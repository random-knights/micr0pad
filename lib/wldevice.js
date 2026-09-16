"use strict";
// wldevice.js - Work Louder / Creator Micro 2 (Codex Micro) raw-HID JSON-RPC transport.
// Verified live on this device: VID 0x303a PID 0x8360, firmware v0.4.1.
// Opens the vendor HID collection (usage page 0xFF00, usage 1) non-exclusively
// and speaks JSON-RPC 2.0 over 64-byte reports (report id 6, channel 2).
//
// This is one of the two implementations of the interface in lib/device.js.
// The only thing added for that interface is the `descriptor` field below; the
// transport, the framing and the error handling are unchanged.
const HID = require("node-hid");

const VID = 0x303a;
const USAGE_PAGE = 0xff00;
const USAGE = 1;
const REPORT_ID = 0x06;
const CH_RPC = 2;
const CH_DEBUG = 1;
const CHUNK = 61;

// Pure extraction: which device (if any) matches the Work Louder vendor
// interface, out of whatever `enumerate()` (normally HID.devices) returns.
// Isolated so the absent-device error can be tested without touching real
// hardware: an injected enumerate that returns [] proves the error message
// without ever constructing an HID handle.
function findDevice(enumerate) {
  return enumerate().find(
    (d) => d.vendorId === VID && d.usagePage === USAGE_PAGE && d.usage === USAGE
  );
}

// Pure extraction of one raw HID report's channel/length/text framing. Tries
// offset 1 then offset 0 (report id byte may or may not be echoed back),
// exactly as the original inline loop did. Returns null when neither offset
// carries a recognized channel or a length within CHUNK.
function parseReport(buf) {
  for (const off of [1, 0]) {
    const channel = buf[off], len = buf[off + 1];
    if (channel !== CH_RPC && channel !== CH_DEBUG) continue;
    if (len === undefined || len > CHUNK) continue;
    const text = buf.slice(off + 2, off + 2 + len).toString("utf8");
    return { channel, text };
  }
  return null;
}

// Pure extraction of the brace-depth JSON object drainer. Takes the
// accumulated text so far and returns every complete object found plus
// whatever text remains (a partial trailing object, or "" once the 8192
// runaway-buffer guard trips). No state kept here; the caller (open()) owns
// the running `accum` string across calls.
function drainObjects(input) {
  const out = [];
  let accum = input;
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < accum.length; i++) {
    const c = accum[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth++ === 0) start = i; }
    else if (c === "}" && depth > 0 && --depth === 0) {
      try { out.push(JSON.parse(accum.slice(start, i + 1))); } catch {}
      accum = accum.slice(i + 1); i = -1; start = -1;
    }
  }
  if (accum.length > 8192) accum = "";
  return { objects: out, remainder: accum };
}

// Pure extraction: classify one parsed JSON-RPC object as a notification (no
// id) or a response (has an id), accepting both the abbreviated {m, p} and
// the full {method, params} spellings the firmware and virtual pad use.
function classifyMessage(obj) {
  const method = obj.m !== undefined ? obj.m : obj.method;
  if (method !== undefined && obj.id === undefined) {
    return { kind: "notify", method, params: obj.m !== undefined ? obj.p : obj.params };
  }
  return { kind: "response", id: obj.id, error: obj.error, result: obj.result };
}

// Pure extraction of the outbound envelope + chunking: one JSON-RPC request,
// split into 64-byte reports (report id, channel, chunk length, then up to
// CHUNK bytes of payload) exactly as call() writes them.
function buildReports(method, params, id) {
  const payload = Buffer.from(JSON.stringify({ method, params, id }), "utf8");
  const reports = [];
  for (let off = 0; off < payload.length; off += CHUNK) {
    const n = Math.min(CHUNK, payload.length - off);
    const report = Buffer.alloc(64);
    report[0] = REPORT_ID; report[1] = CH_RPC; report[2] = n;
    payload.copy(report, 3, off, off + n);
    reports.push(report);
  }
  return reports;
}

function open(deps = {}) {
  const enumerate = deps.enumerate || HID.devices;
  const HIDCtor = deps.HIDCtor || HID.HID;
  const info = findDevice(enumerate);
  if (!info) throw new Error("no Work Louder vendor interface found (is the pad plugged in?)");
  const hid = new HIDCtor(info.path, { nonExclusive: true });
  const pending = new Map();
  let accum = "";
  const bus = {
    descriptor: { kind: "hid", model: info.product || "Work Louder pad" },
    info, hid, onNotify: null, onLog: null, call, close,
  };
  hid.on("data", (buf) => {
    const parsed = parseReport(buf);
    if (!parsed) return;
    if (parsed.channel === CH_DEBUG) { if (bus.onLog) bus.onLog(parsed.text); return; }
    accum += parsed.text;
    for (const obj of drain()) dispatch(obj);
  });
  function drain() {
    const { objects, remainder } = drainObjects(accum);
    accum = remainder;
    return objects;
  }
  function dispatch(obj) {
    const msg = classifyMessage(obj);
    if (msg.kind === "notify") {
      if (bus.onNotify) bus.onNotify(msg.method, msg.params);
      return;
    }
    const waiting = pending.get(msg.id);
    if (!waiting) return;
    pending.delete(msg.id); clearTimeout(waiting.timer);
    if (msg.error) waiting.reject(new Error(msg.error.message || "rpc error"));
    else waiting.resolve(msg.result);
  }
  function call(method, params = null) {
    const id = Math.floor(Math.random() * 999);
    for (const report of buildReports(method, params, id)) {
      hid.write(Array.from(report));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 5000);
      pending.set(id, { resolve, reject, timer });
    });
  }
  function close() { try { hid.close(); } catch {} }
  return bus;
}

module.exports = {
  open, VID, USAGE_PAGE, USAGE, REPORT_ID, CH_RPC, CH_DEBUG, CHUNK,
  findDevice, parseReport, drainObjects, classifyMessage, buildReports,
};
