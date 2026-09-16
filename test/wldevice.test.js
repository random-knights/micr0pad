"use strict";
// What these tests hold in place: the report framing (channel/length/text out
// of a raw 64-byte HID report), the JSON-RPC envelope wldevice writes back
// (report id 6, channel 2 RPC, chunked at 61 bytes), the notify/response
// split, the brace-depth object drainer, and the absent-device error - all
// through the pure functions wldevice.js exports for exactly this reason.
// No hardware: open() itself is exercised only through an injected enumerate
// that finds nothing, so a real HID handle is never constructed here, and
// (per the lane's hard rule) the physical pad plugged into this machine is
// never touched.

const test = require("node:test");
const assert = require("node:assert");
const wldevice = require("../lib/wldevice");
const {
  open, REPORT_ID, CH_RPC, CH_DEBUG, CHUNK,
  findDevice, parseReport, drainObjects, classifyMessage, buildReports,
} = wldevice;

test("findDevice picks the VID/usagePage/usage match and ignores the rest", () => {
  const match = { vendorId: 0x303a, usagePage: 0xff00, usage: 1, path: "match", product: "Codex Micro" };
  const other = { vendorId: 0x303a, usagePage: 0xff00, usage: 2, path: "other" };
  assert.equal(findDevice(() => [other, match]), match);
  assert.equal(findDevice(() => [other]), undefined);
});

test("open() throws the absent-device error when enumerate finds nothing", () => {
  assert.throws(
    () => open({ enumerate: () => [] }),
    /no Work Louder vendor interface found \(is the pad plugged in\?\)/
  );
});

test("open() never falls back to the real HID.devices when enumerate is injected", () => {
  // A caller who forgets to pass HIDCtor still must not reach the platform
  // enumerator: this proves enumerate alone decides whether a device exists,
  // which is what keeps a test from ever touching the plugged-in pad.
  let calls = 0;
  assert.throws(() => open({ enumerate: () => { calls++; return []; } }));
  assert.equal(calls, 1);
});

test("parseReport reads channel, length and text at offset 1 (report id echoed)", () => {
  const buf = Buffer.alloc(64);
  buf[0] = REPORT_ID; buf[1] = CH_RPC; buf[2] = 5;
  buf.write("hello", 3, "utf8");
  assert.deepEqual(parseReport(buf), { channel: CH_RPC, text: "hello" });
});

test("parseReport falls back to offset 0 when the report id is not echoed", () => {
  const buf = Buffer.alloc(64);
  buf[0] = CH_DEBUG; buf[1] = 3;
  buf.write("log", 2, "utf8");
  assert.deepEqual(parseReport(buf), { channel: CH_DEBUG, text: "log" });
});

test("parseReport returns null for an unrecognized channel at either offset", () => {
  const buf = Buffer.alloc(64);
  buf[0] = 9; buf[1] = 9; buf[2] = 1;
  assert.equal(parseReport(buf), null);
});

test("parseReport returns null when the declared length exceeds CHUNK", () => {
  const buf = Buffer.alloc(64);
  buf[0] = REPORT_ID; buf[1] = CH_RPC; buf[2] = CHUNK + 1;
  assert.equal(parseReport(buf), null);
});

test("drainObjects finds one complete object and leaves nothing behind", () => {
  const { objects, remainder } = drainObjects('{"id":1,"result":{"ok":1}}');
  assert.deepEqual(objects, [{ id: 1, result: { ok: 1 } }]);
  assert.equal(remainder, "");
});

test("drainObjects finds two objects back to back in one buffer", () => {
  const { objects, remainder } = drainObjects('{"id":1}{"id":2}');
  assert.deepEqual(objects.map((o) => o.id), [1, 2]);
  assert.equal(remainder, "");
});

test("drainObjects holds a partial trailing object as the remainder", () => {
  const { objects, remainder } = drainObjects('{"id":1}{"id":2,"resu');
  assert.deepEqual(objects, [{ id: 1 }]);
  assert.equal(remainder, '{"id":2,"resu');
});

test("drainObjects ignores braces inside a JSON string", () => {
  const { objects, remainder } = drainObjects('{"id":1,"m":"a { b } c"}');
  assert.deepEqual(objects, [{ id: 1, m: "a { b } c" }]);
  assert.equal(remainder, "");
});

test("drainObjects resets a runaway buffer past 8192 chars instead of growing forever", () => {
  const junk = "{".repeat(8193);
  const { objects, remainder } = drainObjects(junk);
  assert.deepEqual(objects, []);
  assert.equal(remainder, "", "the guard drops the buffer rather than keeping an unbounded partial");
});

test("classifyMessage reads a notification in the abbreviated {m,p} spelling", () => {
  assert.deepEqual(classifyMessage({ m: "v.oai.hid", p: { k: "AG00", act: 1 } }), {
    kind: "notify", method: "v.oai.hid", params: { k: "AG00", act: 1 },
  });
});

test("classifyMessage reads a notification in the full {method,params} spelling", () => {
  assert.deepEqual(classifyMessage({ method: "v.oai.rad", params: { a: 0.5, d: 0.9 } }), {
    kind: "notify", method: "v.oai.rad", params: { a: 0.5, d: 0.9 },
  });
});

test("classifyMessage reads a response (has an id) as a response, not a notify", () => {
  assert.deepEqual(classifyMessage({ id: 7, result: { ok: 1 } }), {
    kind: "response", id: 7, error: undefined, result: { ok: 1 },
  });
  assert.deepEqual(classifyMessage({ id: 8, error: { message: "Method not found" } }), {
    kind: "response", id: 8, error: { message: "Method not found" }, result: undefined,
  });
});

test("buildReports frames one small call as a single report: id 6, channel 2, length byte, payload", () => {
  const [report] = buildReports("sys.version", null, 1);
  assert.equal(report.length, 64, "every report is a full 64-byte HID report");
  assert.equal(report[0], 0x06, "report id 6");
  assert.equal(report[1], CH_RPC, "channel 2, RPC");
  const payload = JSON.stringify({ method: "sys.version", params: null, id: 1 });
  assert.equal(report[2], payload.length, "the length byte matches the payload");
  assert.equal(report.slice(3, 3 + payload.length).toString("utf8"), payload);
});

test("buildReports splits a payload over CHUNK bytes into more than one report", () => {
  const bigParams = { keys: "x".repeat(200) };
  const reports = buildReports("v.oai.rgbcfg", bigParams, 2);
  const payload = Buffer.from(JSON.stringify({ method: "v.oai.rgbcfg", params: bigParams, id: 2 }), "utf8");
  const expectedChunks = Math.ceil(payload.length / CHUNK);
  assert.equal(reports.length, expectedChunks);
  // Every report but the last carries a full CHUNK bytes.
  for (const report of reports.slice(0, -1)) assert.equal(report[2], CHUNK);
  const last = reports[reports.length - 1];
  assert.equal(last[2], payload.length - CHUNK * (reports.length - 1));
  // Reassembling the chunks by their own length bytes reproduces the payload.
  const rebuilt = Buffer.concat(reports.map((r) => r.slice(3, 3 + r[2])));
  assert.equal(rebuilt.toString("utf8"), payload.toString("utf8"));
});

test("buildReports call ids stay under 1000, as the firmware requires", () => {
  // wldevice.open()'s call() generates ids with Math.floor(Math.random()*999);
  // this proves the envelope itself carries whatever id it is given, and a
  // 3-digit id fits the single length byte with room to spare.
  const [report] = buildReports("sys.version", null, 998);
  const payload = JSON.parse(report.slice(3, 3 + report[2]).toString("utf8"));
  assert.equal(payload.id, 998);
});

test("buildReports writes the firmware's report id, 6, in report[0]", () => {
  // A copy-paste next to report[1] = CH_RPC is the easy way to get this wrong
  // (writing the channel value into the report-id byte); this assertion
  // catches exactly that by name instead of failing silently on hardware.
  const [report] = buildReports("sys.version", null, 1);
  assert.equal(report[0], 0x06, "report[0] must be the report id (6), not the channel");
});
