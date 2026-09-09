"use strict";
// What these tests hold in place: every watch rule fires on a synthetic
// sample series that meets its window and does NOT fire one sample short of
// it; the kill allowlist keeps node.exe out; a snooze suppresses; an alert
// fires once and re-arms only after it clears.

const test = require("node:test");
const assert = require("node:assert");
const { Watch, DEFAULTS, normalize, parseSample, MB } = require("../lib/watch");

const STEP = 3000;
const T0 = 1_000_000_000_000;

// Feed `n` samples STEP apart. `make(i)` returns the sample body for tick i.
// Returns every alert that started, in order.
function feed(w, n, make, start = T0) {
  const fired = [];
  for (let i = 0; i < n; i++) {
    const body = make(i);
    fired.push(...w.ingest(Object.assign({ t: start + i * STEP, cpuPct: 10, memPct: 40, procs: [] }, body)));
  }
  return fired;
}

// Samples needed for a window of `sec`: first sample at 0, last at `sec`.
const ticksFor = (sec) => (sec * 1000) / STEP + 1;

const proc = (o) => Object.assign({ pid: 100, name: "chrome.exe", cpuPct: 0, ws: 900 * MB, ppid: 1 }, o);
const parentShell = { pid: 1, name: "cmd.exe", cpuPct: 0, ws: 10 * MB, ppid: 0 };

test("hungChrome fires at its window and not one sample short", () => {
  const n = ticksFor(DEFAULTS.rules.hungChrome.forSec);
  const short = feed(new Watch(), n - 1, () => ({ procs: [proc()] }));
  assert.deepEqual(short, [], "one sample short of 180 s must not fire");
  const full = feed(new Watch(), n, () => ({ procs: [proc()] }));
  assert.equal(full.length, 1);
  assert.equal(full[0].rule, "hungChrome");
  assert.equal(full[0].pid, 100);
  assert.equal(full[0].name, "chrome.exe");
  assert.match(full[0].detail, /no CPU for 180s/);
});

test("hungChrome needs the memory AND the silence, and a measured CPU value", () => {
  const n = ticksFor(DEFAULTS.rules.hungChrome.forSec);
  assert.deepEqual(feed(new Watch(), n, () => ({ procs: [proc({ ws: 700 * MB })] })), [], "700 MB is an idle tab, not a parked renderer");
  assert.deepEqual(feed(new Watch(), n, () => ({ procs: [proc({ cpuPct: 0.4 })] })), [], "any CPU at all means it is alive");
  assert.deepEqual(feed(new Watch(), n, () => ({ procs: [proc({ cpuPct: null })] })), [], "an unreadable CPU value is not zero");
});

test("cpuSustained and memSustained fire at their window and not one short", () => {
  const cpuN = ticksFor(DEFAULTS.rules.cpuSustained.forSec);
  assert.deepEqual(feed(new Watch(), cpuN - 1, () => ({ cpuPct: 90 })), []);
  const cpu = feed(new Watch(), cpuN, () => ({ cpuPct: 90 }));
  assert.deepEqual(cpu.map((a) => a.rule), ["cpuSustained"]);
  assert.equal(cpu[0].name, "system");
  const memN = ticksFor(DEFAULTS.rules.memSustained.forSec);
  assert.deepEqual(feed(new Watch(), memN - 1, () => ({ memPct: 95 })), []);
  assert.deepEqual(feed(new Watch(), memN, () => ({ memPct: 95 })).map((a) => a.rule), ["memSustained"]);
});

test("processHog fires on working set or on CPU, each at its own window", () => {
  const n = ticksFor(DEFAULTS.rules.processHog.forSec);
  const big = () => ({ procs: [proc({ name: "node.exe", ws: 2100 * MB })] });
  assert.deepEqual(feed(new Watch(), n - 1, big), []);
  const byMem = feed(new Watch(), n, big);
  assert.deepEqual(byMem.map((a) => a.rule), ["processHog"]);
  assert.match(byMem[0].detail, /working set above 2048 MB/);
  const hot = () => ({ procs: [proc({ name: "dart.exe", ws: 100 * MB, cpuPct: 60, ppid: 1 }), parentShell] });
  assert.deepEqual(feed(new Watch(), n - 1, hot), []);
  const byCpu = feed(new Watch(), n, hot);
  assert.deepEqual(byCpu.map((a) => a.rule), ["processHog"]);
  assert.match(byCpu[0].detail, /CPU above 50%/);
});

test("orphanDev fires for a dart.exe with a dead parent, not for one owned by an editor", () => {
  const n = ticksFor(DEFAULTS.rules.orphanDev.forSec);
  const dart = (ppid) => proc({ pid: 200, name: "dart.exe", ws: 300 * MB, cpuPct: 0, ppid });
  const orphan = () => ({ procs: [dart(4242)] }); // 4242 is not in the sample: dead parent
  assert.deepEqual(feed(new Watch(), n - 1, orphan), []);
  const fired = feed(new Watch(), n, orphan);
  assert.deepEqual(fired.map((a) => [a.rule, a.pid]), [["orphanDev", 200]]);
  const owned = () => ({ procs: [dart(7), { pid: 7, name: "Code.exe", cpuPct: 1, ws: 500 * MB, ppid: 0 }] });
  assert.deepEqual(feed(new Watch(), n, owned), [], "a live editor parent owns the analysis server");
  const stray = () => ({ procs: [dart(8), { pid: 8, name: "svchost.exe", cpuPct: 0, ws: 5 * MB, ppid: 0 }] });
  assert.equal(feed(new Watch(), n, stray).length, 1, "a live parent that is not an editor, toolchain or shell is still an orphan");
});

test("the kill allowlist keeps node.exe out and lets the defaults through", () => {
  const w = new Watch();
  assert.equal(w.isKillable("node.exe"), false);
  assert.equal(w.isKillable("NODE.EXE"), false);
  for (const name of ["chrome.exe", "dart.exe", "dartvm.exe", "java.exe", "msedgewebview2.exe", "Chrome.exe"]) {
    assert.equal(w.isKillable(name), true, name);
  }
  assert.equal(w.isKillable(null), false);
  assert.equal(new Watch({ killable: ["notepad.exe"] }).isKillable("chrome.exe"), false, "the owner's list replaces the default");
});

test("an alert fires once, stays active while true, clears, and re-arms", () => {
  const w = new Watch();
  const n = ticksFor(DEFAULTS.rules.cpuSustained.forSec);
  assert.equal(feed(w, n, () => ({ cpuPct: 90 })).length, 1);
  assert.equal(feed(w, 5, () => ({ cpuPct: 90 }), T0 + n * STEP).length, 0, "no re-fire while it holds");
  assert.equal(w.alerts().length, 1);
  feed(w, 1, () => ({ cpuPct: 20 }), T0 + (n + 5) * STEP);
  assert.equal(w.alerts().length, 0, "clears when the condition stops");
  assert.equal(feed(w, n, () => ({ cpuPct: 90 }), T0 + (n + 6) * STEP).length, 1, "fires again after a fresh full window");
});

test("snooze suppresses a rule and lets it come back when it expires", () => {
  const w = new Watch();
  const n = ticksFor(DEFAULTS.rules.cpuSustained.forSec);
  feed(w, n, () => ({ cpuPct: 90 }));
  assert.equal(w.alerts().length, 1);
  const now = T0 + n * STEP;
  const until = w.snooze("cpuSustained", now);
  assert.equal(until, now + DEFAULTS.snoozeMs);
  assert.deepEqual(w.alerts(), [], "snoozing removes the alert from the banner");
  assert.deepEqual(w.summary(now).snoozed, { cpuSustained: until });
  // Keep the condition true straight through the snooze: nothing fires until
  // the snooze expires, then it fires exactly once.
  const ticks = DEFAULTS.snoozeMs / STEP + 2;
  const fired = [];
  for (let i = 1; i <= ticks; i++) {
    const t = now + i * STEP;
    const got = feed(w, 1, () => ({ cpuPct: 90 }), t);
    if (got.length) fired.push(t);
    if (t < until) assert.equal(got.length, 0, `nothing new while snoozed (t=${t})`);
  }
  assert.equal(fired.length, 1, "back exactly once after the snooze");
  assert.ok(fired[0] >= until);
  assert.throws(() => w.snooze("noSuchRule", now));
});

test("a gap in sampling breaks the run instead of bridging it", () => {
  const w = new Watch();
  const n = ticksFor(DEFAULTS.rules.cpuSustained.forSec);
  feed(w, 10, () => ({ cpuPct: 90 }));
  // Sampler restart: the next sample lands 60 s later, then the series resumes.
  const resume = T0 + 10 * STEP + 60000;
  assert.equal(feed(w, n - 1, () => ({ cpuPct: 90 }), resume).length, 0, "the run restarts after the gap");
  assert.equal(feed(w, 1, () => ({ cpuPct: 90 }), resume + (n - 1) * STEP).length, 1);
});

test("normalize keeps every default a partial config does not mention", () => {
  const c = normalize({ rules: { hungChrome: { workingSetMb: 1200 } }, autoKill: true });
  assert.equal(c.rules.hungChrome.workingSetMb, 1200);
  assert.equal(c.rules.hungChrome.forSec, 180);
  assert.equal(c.rules.cpuSustained.cpuPct, 85);
  assert.equal(c.autoKill, false, "v1: no config value turns auto-kill on");
  assert.deepEqual(c.killable, DEFAULTS.killable);
  assert.deepEqual(normalize(undefined).rules, DEFAULTS.rules);
});

test("parseSample reads the sampler line and derives CPU percent from the delta", () => {
  const cores = 4;
  const line1 = "S 1000 100|1048576|500|1|chrome.exe;1|2048|-1|0|System;7|4096|100|1|dart.exe";
  const a = parseSample(line1, {}, cores);
  assert.equal(a.t, 1000);
  assert.deepEqual(a.procs.map((p) => [p.pid, p.name, p.cpuPct, p.ws, p.ppid]), [
    [100, "chrome.exe", null, 1048576, 1],
    [1, "System", null, 2048, 0],
    [7, "dart.exe", null, 4096, 1],
  ]);
  // 4 s later chrome used 2000 ms of CPU: 2000 / 4000 / 4 cores = 12.5%.
  const b = parseSample("S 5000 100|1048576|2500|1|chrome.exe;1|2048|-1|0|System", a.cpuMs, cores);
  assert.equal(b.procs[0].cpuPct, 12.5);
  assert.equal(b.procs[1].cpuPct, null, "an unreadable process stays unknown");
  assert.equal(parseSample("not a sample", {}, cores), null);
  assert.deepEqual(parseSample("S 1 bad|row", {}, cores).procs, [], "a malformed record is skipped");
});

test("the rule table names every rule with its window, thresholds and reason", () => {
  const rules = new Watch().rules();
  assert.deepEqual(rules.map((r) => r.id), ["cpuSustained", "memSustained", "processHog", "hungChrome", "orphanDev"]);
  for (const r of rules) {
    assert.ok(r.label && r.reason && r.forSec > 0, r.id);
    assert.equal(typeof r.thresholds, "object");
  }
  const s = new Watch().summary(T0);
  assert.equal(s.autoKill, false);
  assert.match(s.autoKillNote, /coming later/);
});

test("top() serves the process table from the last sample, by working set", () => {
  const w = new Watch();
  feed(w, 1, () => ({ procs: [proc({ pid: 1, ws: 10 * MB }), proc({ pid: 2, ws: 30 * MB }), proc({ pid: 3, ws: 20 * MB })] }));
  assert.deepEqual(w.top(2).map((p) => p.pid), [2, 3]);
  assert.equal(w.top(0).length, 3);
  assert.equal(w.top(1)[0].memKb, 30 * 1024);
  feed(w, 1, () => ({ procs: [proc({ pid: 2, ws: 30 * MB })] }), T0 + STEP);
  assert.equal(w.top(0).length, 1, "a process that left the sample leaves the table");
  assert.equal(w.nameOf(2), "chrome.exe");
  assert.equal(w.nameOf(1), null);
});
