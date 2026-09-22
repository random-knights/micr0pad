"use strict";
// analytics.js - optional, local, and about the pad, not about you.
//
// OFF BY DEFAULT. Nothing here runs, and no file is created, unless you turn
// it on. Two ways to do that, both explicit:
//
//   config.json     "analytics": { "enabled": true }
//   environment     MICR0PAD_ANALYTICS=1
//
// It writes ONE line when the server stops, to analytics-local.jsonl in the
// per-user directory beside config.json (lib/paths.js; override with
// MICR0PAD_ANALYTICS_PATH). Nothing is transmitted:
// this app has no server to send to and does not open outbound connections
// for analytics. The file is yours, it is gitignored, and deleting it is a
// complete opt-out after the fact.
//
// WHAT IT MEASURES: what a running pad costs. How long the bridge ran, how
// long the device was actually attached, how many times the lights were
// repainted, and how much CPU time this process used. That is the shape
// AiEDs asks for: the cost of the running thing, disclosed by the thing
// itself.
//
// WHAT IT DOES NOT MEASURE, and why each was dropped rather than reduced:
//
//   hostname, username, home directory  identify a person or a machine.
//   IP address, timezone, locale        identify a place.
//   agent names, slot names             the user's own words.
//   working directories, window titles  contain project and client names.
//   action key labels and commands      the user's own scripts.
//   which keys were pressed, and when   this is what the user does, and a
//                                       key-press timeline is a keystroke
//                                       log by another name.
//   AiEDs rows, transcripts, prompts    the content of the work itself.
//
// A count of repaints is a cost of running. A record of presses is a record
// of a person. That line is the whole rule, and when a proposed field sat on
// the wrong side of it the field was dropped, not anonymized.
//
// One field is generated: runId, 8 random hex characters minted per run and
// never stored anywhere else. It exists so two lines from the same run can be
// told apart from two runs, and it is meaningless across runs by
// construction.
//
// NOT MODELED: energy in watt-hours. AiEDs v2 models energy from AI token
// counts, and there is no sourced figure for what this device draws. A
// modeled number without a source would be a guess wearing a unit, so the
// line carries the measurements and says energyWhModeled is not available.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const APP_DIR = path.join(__dirname, "..");
const SCHEMA = "micr0pad.analytics/1";

// Fields that must never appear in a written line. This is the last check
// before the file, not the first: the record is built without them. It is
// here because a future field added carelessly is exactly the kind of change
// that a comment does not stop.
const FORBIDDEN_KEYS = [
  "hostname", "host", "user", "username", "userName", "home", "homedir",
  "cwd", "dir", "path", "ip", "address", "location", "timezone", "tz",
  "locale", "email", "token", "pairingToken", "key", "apiKey", "title",
  "agentName", "slotName", "label", "cmd", "command", "transcript", "prompt",
  "text", "keys", "keyPresses", "presses",
];

function settings(cfg = {}, env = process.env) {
  const fromConfig = cfg && cfg.analytics && cfg.analytics.enabled === true;
  const fromEnv = env.MICR0PAD_ANALYTICS === "1" || env.MICR0PAD_ANALYTICS === "true";
  const logPath = env.MICR0PAD_ANALYTICS_PATH
    ? path.resolve(env.MICR0PAD_ANALYTICS_PATH)
    : path.join(require("./paths").dataDir({ env }), "analytics-local.jsonl");
  return { enabled: Boolean(fromConfig || fromEnv), logPath };
}

// Returns the record, or null if it carries anything on the forbidden list.
// Dropping the whole line is deliberate. A line that has already been built
// wrong cannot be fixed by deleting one key, because the reason it went wrong
// is upstream of here.
function sanitize(record) {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.includes(key)) return null;
  }
  return record;
}

function version() {
  try {
    return require(path.join(APP_DIR, "package.json")).version || "unknown";
  } catch (_) {
    return "unknown";
  }
}

// The counters a session accumulates. Every one of them is a cost of running.
class Session {
  constructor(now = Date.now) {
    this.now = now;
    this.startedMs = now();
    this.padRepaints = 0;
    this.deviceConnectedMs = 0;
    this.deviceUpSince = null;
    this.startCpu = process.cpuUsage();
  }

  // Called on each bridge state tick. deviceUp is the only thing read from
  // the state object; the rest of that object is agent names and working
  // directories, which is precisely what does not belong here.
  observe(deviceUp) {
    this.padRepaints++;
    const t = this.now();
    if (deviceUp && this.deviceUpSince === null) {
      this.deviceUpSince = t;
    } else if (!deviceUp && this.deviceUpSince !== null) {
      this.deviceConnectedMs += t - this.deviceUpSince;
      this.deviceUpSince = null;
    }
  }

  record() {
    const t = this.now();
    const connected =
      this.deviceConnectedMs + (this.deviceUpSince === null ? 0 : t - this.deviceUpSince);
    const cpu = process.cpuUsage(this.startCpu);
    return sanitize({
      schema: SCHEMA,
      appVersion: version(),
      tsUtc: new Date(t).toISOString(),
      runId: crypto.randomBytes(4).toString("hex"),
      sessionMs: t - this.startedMs,
      deviceConnectedMs: connected,
      padRepaints: this.padRepaints,
      hostCpuMs: Math.round((cpu.user + cpu.system) / 1000),
      energyWhModeled: null,
      energyNote: "not modeled: no sourced power figure for this device",
      platform: process.platform,
      nodeMajor: Number(process.versions.node.split(".")[0]),
    });
  }
}

function append(logPath, record) {
  if (!record) return false;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(record) + os.EOL, "utf8");
    return true;
  } catch (e) {
    // A telemetry file that cannot be written is not a reason to take the pad
    // down. Say it once, keep running.
    console.error("[analytics] could not write:", e.message);
    return false;
  }
}

// Attach to a running bridge. Returns null when analytics are off, which is
// the default, so the caller can tell the difference between "off" and
// "attached" without reading the config a second time.
function attach(bridge, cfg, env = process.env) {
  const { enabled, logPath } = settings(cfg, env);
  if (!enabled) return null;
  // A checkout that logged beside the app before the per-user directory
  // existed keeps its history: copied across once, never overwritten.
  if (!env.MICR0PAD_ANALYTICS_PATH) {
    try {
      require("./paths").migrateOnce("analytics-local.jsonl", { toDir: path.dirname(logPath) });
    } catch (_) { /* a history that cannot be copied is not a reason to stop */ }
  }

  const session = new Session();
  bridge.on("state", (s) => session.observe(Boolean(s && s.deviceUp)));

  let written = false;
  const flush = () => {
    if (written) return;
    written = true;
    append(logPath, session.record());
  };

  // exit covers a normal stop and an uncaught throw. The signals are how this
  // actually ends most of the time (Ctrl+C is SIGINT, and SIGBREAK is the
  // Windows console Ctrl+Break), and none of them fire exit on their own.
  //
  // A FORCE KILL LOSES THE LINE. taskkill /F, a pulled plug, or a hard stop
  // from a process manager cannot run a handler, so that run goes unrecorded.
  // That is the right failure for optional telemetry: it under-reports rather
  // than holding the process open to write about itself.
  process.on("exit", flush);
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    process.on(signal, () => {
      flush();
      process.exit(0);
    });
  }

  console.log(`[analytics] on, writing one line per run to ${logPath}`);
  return { session, logPath, flush };
}

// Read a written log back into totals. This is what makes the opt-in worth
// taking: the numbers are for the person who turned it on.
function summarize(lines) {
  const rows = [];
  for (const line of lines) {
    const text = String(line).trim();
    if (!text) continue;
    try {
      const row = JSON.parse(text);
      if (row && row.schema === SCHEMA) rows.push(row);
    } catch (_) {
      // A truncated last line (a hard kill mid-append) is skipped, not fatal.
    }
  }
  const total = (key) => rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
  return {
    runs: rows.length,
    sessionMs: total("sessionMs"),
    deviceConnectedMs: total("deviceConnectedMs"),
    padRepaints: total("padRepaints"),
    hostCpuMs: total("hostCpuMs"),
  };
}

function summarizeFile(logPath) {
  if (!fs.existsSync(logPath)) return summarize([]);
  return summarize(fs.readFileSync(logPath, "utf8").split(/\r?\n/));
}

module.exports = {
  SCHEMA,
  FORBIDDEN_KEYS,
  APP_DIR,
  settings,
  sanitize,
  attach,
  append,
  summarize,
  summarizeFile,
  Session,
};
