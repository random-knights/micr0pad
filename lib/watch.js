"use strict";
// watch.js - resource watcher: rules over a ring buffer of process samples.
//
// PURE. No timers, no child processes, no device, no file. server.js feeds
// one sample per tick in and reads alerts out; test/watch.test.js feeds
// synthetic series. Nothing here ever ends a process: the watcher only says
// what it sees, and the existing /api/sys/kill route (pairing token and
// origin checked) is the only thing that acts.
//
// A rule HOLDS when its predicate is true on every sample of the current
// unbroken run AND the run's first sample is at least `forSec` old. So one
// sample short of the window does not fire, and a gap in sampling (a sampler
// restart) breaks the run instead of bridging it.

const MB = 1048576;

// Defaults and the reason for each number. None of these is a measured fact
// about every machine; each is a judgment for the laptop this was built on,
// and all of them live under "watch" in config.json to be changed.
const DEFAULTS = {
  enabled: true,
  sampleMs: 3000,      // the System panel already polls at 3 s; same cadence
  historyMs: 600000,   // 10 minutes of samples per process
  snoozeMs: 1800000,   // 30 minutes
  // The end button works ONLY on these. node.exe is left off on purpose: this
  // server and herdr are node, and ending the wrong one wedges the HID handle.
  // dartvm.exe is there because on Dart 3.x `dart.exe` is a thin launcher and
  // the work (an analysis server, a script) runs in a dartvm.exe child.
  killable: ["chrome.exe", "dart.exe", "dartvm.exe", "java.exe", "msedgewebview2.exe"],
  // v1 never ends anything on its own. The flag exists so the shape is
  // settled; nothing reads it yet and the UI shows it as "coming later".
  autoKill: false,
  rules: {
    cpuSustained: { enabled: true, cpuPct: 85, forSec: 90 },
    memSustained: { enabled: true, memPct: 90, forSec: 60 },
    processHog:   { enabled: true, workingSetMb: 2048, cpuPct: 50, forSec: 120 },
    hungChrome:   { enabled: true, name: "chrome.exe", cpuPct: 0, workingSetMb: 800, forSec: 180 },
    orphanDev: {
      enabled: true,
      names: ["dart.exe", "dartvm.exe", "java.exe"],
      // A live parent with one of these names owns the process. Anything
      // else, or a dead parent, is an orphan.
      parents: [
        "code.exe", "code - insiders.exe", "cursor.exe", "windsurf.exe", "idea64.exe",
        "studio64.exe", "devenv.exe", "dart.exe", "dartvm.exe", "flutter.exe", "java.exe", "node.exe",
        "cmd.exe", "powershell.exe", "pwsh.exe", "bash.exe", "windowsterminal.exe", "explorer.exe",
      ],
      forSec: 300,
    },
  },
};

const REASONS = {
  cpuSustained: "a Flutter web build pins every core for 30 to 60 s; 90 s clears a build and still catches a runaway",
  memSustained: "Windows starts trimming and paging near 90%; a minute rules out a transient allocation spike",
  processHog: "2 GB is above any single healthy renderer, analysis server or node process; half the machine from one process for two minutes is a spin, not work",
  hungChrome: "a parked renderer keeps its memory and does nothing; an idle background tab sits well under 800 MB",
  orphanDev: "analysis servers and Gradle daemons are what editors leave behind; five minutes is longer than an editor restart",
};

const LABELS = {
  cpuSustained: "CPU sustained", memSustained: "RAM sustained", processHog: "process hog",
  hungChrome: "hung Chrome", orphanDev: "orphan dev process",
};

// Deep-merge a partial "watch" block over the defaults, so a config.json that
// sets one threshold keeps every other default.
function normalize(user) {
  const u = user && typeof user === "object" ? user : {};
  const out = Object.assign({}, DEFAULTS, u, { rules: {} });
  for (const id of Object.keys(DEFAULTS.rules)) {
    out.rules[id] = Object.assign({}, DEFAULTS.rules[id], (u.rules || {})[id]);
  }
  out.killable = (Array.isArray(u.killable) ? u.killable : DEFAULTS.killable).map((s) => String(s).toLowerCase());
  out.autoKill = false; // v1: no config value can turn this on
  return out;
}

// Time of the first sample in the unbroken run (ending at the latest sample)
// on which `pred` holds, or null when the latest sample fails. A gap wider
// than `maxGapMs` between two samples ends the run.
function runStart(samples, pred, maxGapMs) {
  let start = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (!pred(s)) break;
    if (start !== null && start - s.t > maxGapMs) break;
    start = s.t;
  }
  return start;
}

class Watch {
  constructor(watchCfg) {
    this.cfg = normalize(watchCfg);
    this.sys = [];
    this.procs = new Map(); // pid -> { name, samples: [{t, cpuPct, ws, orphan}] }
    this.active = new Map(); // alert key -> alert
    this.snoozes = {};       // rule id -> until (ms)
    this.lastSampleAt = 0;
  }

  // sample: { t, cpuPct, memPct, procs: [{ pid, name, cpuPct, ws, ppid }] }
  // Returns the alerts that STARTED on this sample.
  ingest(sample) {
    const { t } = sample;
    const c = this.cfg;
    const r = c.rules;
    this.lastSampleAt = t;
    const cutoff = t - c.historyMs;
    this.sys.push({ t, cpuPct: sample.cpuPct, memPct: sample.memPct });
    while (this.sys.length && this.sys[0].t < cutoff) this.sys.shift();

    const byPid = new Map(sample.procs.map((p) => [p.pid, p]));
    const parentSet = new Set(r.orphanDev.parents.map((s) => s.toLowerCase()));
    for (const p of sample.procs) {
      const name = String(p.name || "").toLowerCase();
      const parent = byPid.get(p.ppid);
      const orphan = !parent || !parentSet.has(String(parent.name || "").toLowerCase());
      let e = this.procs.get(p.pid);
      if (!e || e.name !== name) { e = { name, samples: [] }; this.procs.set(p.pid, e); }
      e.samples.push({ t, cpuPct: p.cpuPct, ws: p.ws, orphan });
      while (e.samples.length && e.samples[0].t < cutoff) e.samples.shift();
    }
    for (const pid of [...this.procs.keys()]) if (!byPid.has(pid)) this.procs.delete(pid);

    // Evaluate. `held` collects every (key -> alert) that holds right now.
    const gap = c.sampleMs * 3;
    const held = new Map();
    const sec = (since) => Math.round((t - since) / 1000);
    const check = (rule, key, samples, pred, subject, detail) => {
      if (!r[rule].enabled) return;
      const since = runStart(samples, pred, gap);
      if (since === null || t - since < r[rule].forSec * 1000) return;
      held.set(key, Object.assign({ key, rule, label: LABELS[rule], since, detail: detail(sec(since)) }, subject));
    };
    check("cpuSustained", "cpuSustained", this.sys, (s) => s.cpuPct >= r.cpuSustained.cpuPct,
      { pid: null, name: "system" }, (s) => `CPU at or above ${r.cpuSustained.cpuPct}% for ${s}s`);
    check("memSustained", "memSustained", this.sys, (s) => s.memPct >= r.memSustained.memPct,
      { pid: null, name: "system" }, (s) => `RAM at or above ${r.memSustained.memPct}% for ${s}s`);
    for (const [pid, e] of this.procs) {
      const subject = { pid, name: e.name };
      const hogWs = r.processHog.workingSetMb * MB;
      check("processHog", `processHog:${pid}`, e.samples, (s) => s.ws >= hogWs, subject,
        (s) => `working set above ${r.processHog.workingSetMb} MB for ${s}s`);
      check("processHog", `processHog:cpu:${pid}`, e.samples, (s) => s.cpuPct >= r.processHog.cpuPct, subject,
        (s) => `CPU above ${r.processHog.cpuPct}% for ${s}s`);
      if (e.name === r.hungChrome.name.toLowerCase()) {
        const ws = r.hungChrome.workingSetMb * MB;
        check("hungChrome", `hungChrome:${pid}`, e.samples,
          (s) => typeof s.cpuPct === "number" && s.cpuPct <= r.hungChrome.cpuPct && s.ws >= ws, subject,
          (s) => `no CPU for ${s}s while holding ${Math.round(e.samples[e.samples.length - 1].ws / MB)} MB`);
      }
      if (r.orphanDev.names.map((n) => n.toLowerCase()).includes(e.name)) {
        check("orphanDev", `orphanDev:${pid}`, e.samples, (s) => s.orphan, subject,
          (s) => `no owning editor, toolchain or shell process for ${s}s`);
      }
    }

    const fresh = [];
    for (const [key, alert] of held) {
      if ((this.snoozes[alert.rule] || 0) > t) { this.active.delete(key); continue; }
      const before = this.active.get(key);
      alert.firedAt = before ? before.firedAt : t;
      if (!before) fresh.push(alert);
      this.active.set(key, alert);
    }
    for (const key of [...this.active.keys()]) if (!held.has(key)) this.active.delete(key);
    return fresh;
  }

  alerts() { return [...this.active.values()].sort((a, b) => a.since - b.since); }

  snooze(rule, now) {
    if (!this.cfg.rules[rule]) throw new Error(`unknown rule ${rule}`);
    this.snoozes[rule] = now + this.cfg.snoozeMs;
    for (const [key, a] of this.active) if (a.rule === rule) this.active.delete(key);
    return this.snoozes[rule];
  }

  isKillable(name) { return this.cfg.killable.includes(String(name || "").toLowerCase()); }
  nameOf(pid) { const e = this.procs.get(pid); return e ? e.name : null; }

  // The process table the System panel shows: top n by working set.
  top(n) {
    const rows = [];
    for (const [pid, e] of this.procs) {
      const last = e.samples[e.samples.length - 1];
      rows.push({ pid, name: e.name, memKb: Math.round(last.ws / 1024), cpuPct: last.cpuPct });
    }
    rows.sort((a, b) => b.memKb - a.memKb);
    return n > 0 ? rows.slice(0, n) : rows;
  }

  rules() {
    return Object.keys(DEFAULTS.rules).map((id) => {
      const { enabled, forSec, ...thresholds } = this.cfg.rules[id];
      return { id, label: LABELS[id], enabled, forSec, thresholds, reason: REASONS[id] };
    });
  }

  summary(now) {
    const snoozed = {};
    for (const [rule, until] of Object.entries(this.snoozes)) if (until > now) snoozed[rule] = until;
    return {
      enabled: this.cfg.enabled, sampleMs: this.cfg.sampleMs, lastSampleAt: this.lastSampleAt,
      rules: this.rules(), alerts: this.alerts(), snoozed, killable: this.cfg.killable,
      autoKill: false, autoKillNote: "coming later: v1 alerts and never ends a process on its own",
    };
  }
}

// One line from the sampler: "S <epochMs> pid|ws|cpuMs|ppid|name;pid|...".
// Per-process CPU percent is the delta of cumulative CPU time over the delta
// of wall time, spread over the cores, using `prev` (pid -> cpuMs) from the
// previous line. Unreadable processes report cpuMs -1 and get cpuPct null.
function parseSample(line, prev, cores) {
  const m = /^S (\d+) (.*)$/.exec(line);
  if (!m) return null;
  const t = Number(m[1]);
  const dt = prev.t ? t - prev.t : 0;
  const cpuMs = { t };
  const procs = [];
  for (const rec of m[2].split(";")) {
    const f = rec.split("|");
    if (f.length !== 5) continue;
    const pid = Number(f[0]), ws = Number(f[1]), ms = Number(f[2]), ppid = Number(f[3]);
    let cpuPct = null;
    if (ms >= 0) {
      cpuMs[pid] = ms;
      if (dt > 0 && typeof prev[pid] === "number") cpuPct = Math.max(0, Math.round(((ms - prev[pid]) / dt / cores) * 1000) / 10);
    }
    procs.push({ pid, name: f[4], cpuPct, ws, ppid });
  }
  return { t, procs, cpuMs };
}

module.exports = { Watch, DEFAULTS, REASONS, LABELS, normalize, runStart, parseSample, MB };
