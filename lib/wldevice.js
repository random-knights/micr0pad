"use strict";
// wldevice.js - Work Louder / Creator Micro 2 (Codex Micro) raw-HID JSON-RPC transport.
// Verified live on this device: VID 0x303a PID 0x8360, firmware v0.4.1.
// Opens the vendor HID collection (usage page 0xFF00, usage 1) non-exclusively
// and speaks JSON-RPC 2.0 over 64-byte reports (report id 6, channel 2).
const HID = require("node-hid");

const VID = 0x303a;
const USAGE_PAGE = 0xff00;
const USAGE = 1;
const REPORT_ID = 0x06;
const CH_RPC = 2;
const CH_DEBUG = 1;
const CHUNK = 61;

function open() {
  const info = HID.devices().find(
    (d) => d.vendorId === VID && d.usagePage === USAGE_PAGE && d.usage === USAGE
  );
  if (!info) throw new Error("no Work Louder vendor interface found (is the pad plugged in?)");
  const hid = new HID.HID(info.path, { nonExclusive: true });
  const pending = new Map();
  let accum = "";
  const bus = { info, hid, onNotify: null, onLog: null, call, close };
  hid.on("data", (buf) => {
    for (const off of [1, 0]) {
      const channel = buf[off], len = buf[off + 1];
      if (channel !== CH_RPC && channel !== CH_DEBUG) continue;
      if (len === undefined || len > CHUNK) continue;
      const text = buf.slice(off + 2, off + 2 + len).toString("utf8");
      if (channel === CH_DEBUG) { if (bus.onLog) bus.onLog(text); return; }
      accum += text;
      for (const obj of drain()) dispatch(obj);
      return;
    }
  });
  function drain() {
    const out = [];
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
    return out;
  }
  function dispatch(obj) {
    const method = obj.m !== undefined ? obj.m : obj.method;
    if (method !== undefined && obj.id === undefined) {
      if (bus.onNotify) bus.onNotify(method, obj.m !== undefined ? obj.p : obj.params);
      return;
    }
    const waiting = pending.get(obj.id);
    if (!waiting) return;
    pending.delete(obj.id); clearTimeout(waiting.timer);
    if (obj.error) waiting.reject(new Error(obj.error.message || "rpc error"));
    else waiting.resolve(obj.result);
  }
  function call(method, params = null) {
    const id = Math.floor(Math.random() * 999);
    const payload = Buffer.from(JSON.stringify({ method, params, id }), "utf8");
    for (let off = 0; off < payload.length; off += CHUNK) {
      const n = Math.min(CHUNK, payload.length - off);
      const report = Buffer.alloc(64);
      report[0] = REPORT_ID; report[1] = CH_RPC; report[2] = n;
      payload.copy(report, 3, off, off + n);
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

module.exports = { open, VID, USAGE_PAGE, USAGE };
