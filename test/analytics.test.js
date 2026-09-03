"use strict";
// What these tests hold in place: analytics stay off unless someone turns
// them on, and a line that would identify a person never reaches the disk.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const analytics = require("../lib/analytics");

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "micr0pad-analytics-"));
  return path.join(dir, name);
}

test("off by default: no config key, no environment variable", () => {
  assert.equal(analytics.settings({}, {}).enabled, false);
});

test("off for every value that is not an explicit yes", () => {
  assert.equal(analytics.settings({ analytics: {} }, {}).enabled, false);
  assert.equal(analytics.settings({ analytics: { enabled: false } }, {}).enabled, false);
  // A string is not a yes. Config files acquire strings.
  assert.equal(analytics.settings({ analytics: { enabled: "true" } }, {}).enabled, false);
  assert.equal(analytics.settings({}, { MICR0PAD_ANALYTICS: "0" }).enabled, false);
  assert.equal(analytics.settings({}, { MICR0PAD_ANALYTICS: "" }).enabled, false);
});

test("on when the config says so, or the environment does", () => {
  assert.equal(analytics.settings({ analytics: { enabled: true } }, {}).enabled, true);
  assert.equal(analytics.settings({}, { MICR0PAD_ANALYTICS: "1" }).enabled, true);
  assert.equal(analytics.settings({}, { MICR0PAD_ANALYTICS: "true" }).enabled, true);
});

test("attach returns null while analytics are off, and subscribes nothing", () => {
  const bridge = { listeners: [], on(evt, fn) { this.listeners.push([evt, fn]); } };
  assert.equal(analytics.attach(bridge, {}, {}), null);
  assert.equal(bridge.listeners.length, 0);
});

test("a record carries measurements and no identifiers", () => {
  let clock = 1000;
  const session = new analytics.Session(() => clock);
  clock += 5000;
  session.observe(true);
  clock += 7000;
  session.observe(true);

  const record = session.record();
  assert.equal(record.schema, analytics.SCHEMA);
  assert.equal(record.sessionMs, 12000);
  assert.equal(record.padRepaints, 2);
  assert.equal(record.deviceConnectedMs, 7000);
  assert.equal(typeof record.hostCpuMs, "number");
  assert.equal(record.energyWhModeled, null);
  assert.match(record.runId, /^[0-9a-f]{8}$/);

  const text = JSON.stringify(record).toLowerCase();
  for (const leak of [os.hostname().toLowerCase(), os.userInfo().username.toLowerCase()]) {
    assert.ok(!text.includes(leak), `record leaked ${leak}`);
  }
  for (const key of analytics.FORBIDDEN_KEYS) {
    assert.ok(!(key in record), `record carries forbidden key ${key}`);
  }
});

test("device time only counts while the device is attached", () => {
  let clock = 0;
  const session = new analytics.Session(() => clock);
  session.observe(false);
  clock += 3000;
  session.observe(true);
  clock += 4000;
  session.observe(false);
  clock += 9000;
  assert.equal(session.record().deviceConnectedMs, 4000);
});

test("sanitize drops the whole line rather than one field", () => {
  assert.equal(analytics.sanitize({ schema: "x", hostname: "desk-01" }), null);
  assert.equal(analytics.sanitize({ schema: "x", cwd: "C:/work/client" }), null);
  assert.deepEqual(analytics.sanitize({ schema: "x", sessionMs: 1 }), { schema: "x", sessionMs: 1 });
});

test("append writes one line, and summarize reads it back", () => {
  const logPath = tempFile("analytics-local.jsonl");
  analytics.append(logPath, { schema: analytics.SCHEMA, sessionMs: 1000, padRepaints: 2, hostCpuMs: 5, deviceConnectedMs: 500 });
  analytics.append(logPath, { schema: analytics.SCHEMA, sessionMs: 2000, padRepaints: 3, hostCpuMs: 7, deviceConnectedMs: 250 });

  const totals = analytics.summarizeFile(logPath);
  assert.equal(totals.runs, 2);
  assert.equal(totals.sessionMs, 3000);
  assert.equal(totals.padRepaints, 5);
  assert.equal(totals.hostCpuMs, 12);
  assert.equal(totals.deviceConnectedMs, 750);
});

test("summarize survives a truncated last line and ignores foreign rows", () => {
  const totals = analytics.summarize([
    JSON.stringify({ schema: analytics.SCHEMA, sessionMs: 10 }),
    JSON.stringify({ schema: "something.else/1", sessionMs: 999 }),
    '{"schema":"micr0pad.analytics/1","sessi',
    "",
  ]);
  assert.equal(totals.runs, 1);
  assert.equal(totals.sessionMs, 10);
});

test("no log file means no runs, not a crash", () => {
  const totals = analytics.summarizeFile(tempFile("missing.jsonl"));
  assert.equal(totals.runs, 0);
});
