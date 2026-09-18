"use strict";
// What these tests hold in place: the virtual pad answers exactly the RPC
// methods this repo proves the firmware answers, refuses everything else with
// a JSON-RPC error instead of a fake success, keeps the color matrix the
// mapper paints, emits a key press in the shape the bridge decodes, and needs
// no timer, no child process and no hardware to do any of it.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const virtualdevice = require("../lib/virtualdevice");
const { METHOD_NOT_FOUND } = require("../lib/device");

// A thread frame in the shape lib/mapper.js produces.
const frame = (id, extra) => Object.assign({ id, color: 0x7c4dff, brightness: 1, effect: 1, speed: 0.5 }, extra);

test("it describes itself as virtual and never claims a firmware version", async () => {
  const dev = virtualdevice.open();
  assert.deepEqual(dev.descriptor, { kind: "virtual", model: "virtual pad" });
  assert.deepEqual(await dev.call("sys.version"), { version: "virtual", model: "virtual pad" });
});

test("v.oai.thstatus accepts the mapper's frames and keeps them", async () => {
  const dev = virtualdevice.open();
  assert.deepEqual(await dev.call("v.oai.thstatus", [frame(0), frame(1, { color: 0xff4124 })]), { ok: 1 });
  const shown = dev.snapshot();
  assert.deepEqual(shown.threads.map((t) => t.id), [0, 1]);
  assert.equal(shown.threads[1].color, 0xff4124);
});

test("a later partial frame merges into the key rather than replacing it", async () => {
  const dev = virtualdevice.open();
  await dev.call("v.oai.thstatus", [frame(3)]);
  // This is exactly what lightsOff and pairing mode send: id, brightness, effect.
  await dev.call("v.oai.thstatus", [{ id: 3, b: 0, e: 0 }]);
  const [key3] = dev.snapshot().threads;
  assert.equal(key3.b, 0);
  assert.equal(key3.color, 0x7c4dff, "the color it was painted with is still there");
});

test("v.oai.rgbcfg keeps both zones and lets one be written alone", async () => {
  const dev = virtualdevice.open();
  const gold = { e: 4, b: 1, s: 0.5, m: 1, c: 0xe8bf03 };
  const dark = { e: 0, b: 0, s: 0.5, m: 1, c: 0 };
  assert.deepEqual(await dev.call("v.oai.rgbcfg", { keys: dark, ambient: gold }), { ok: 1 });
  assert.deepEqual(dev.snapshot().zones, { keys: dark, ambient: gold });
  await dev.call("v.oai.rgbcfg", { ambient: dark });
  assert.deepEqual(dev.snapshot().zones, { keys: dark, ambient: dark });
});

test("an unknown method is a JSON-RPC refusal, never a fake ok", async () => {
  const dev = virtualdevice.open();
  // fs.* is the device flash, which a virtual pad does not have. device.status
  // and lights.preview have no response shape recorded anywhere in this repo.
  // ble.status is one the real firmware refuses too (docs/DEVELOPMENT.md).
  for (const method of ["fs.read", "fs.write", "fs.list", "device.status", "lights.preview", "ble.status", "rpc.discover"]) {
    await assert.rejects(
      () => dev.call(method, { file: "keymap.json" }),
      (err) => {
        assert.equal(err.message, "Method not found");
        assert.equal(err.code, METHOD_NOT_FOUND);
        assert.equal(err.method, method);
        return true;
      },
      `${method} must be refused`,
    );
  }
});

test("a malformed frame is refused rather than swallowed", async () => {
  const dev = virtualdevice.open();
  await assert.rejects(() => dev.call("v.oai.thstatus", { id: 0 }), /invalid params/);
  await assert.rejects(() => dev.call("v.oai.thstatus", [{ c: 1 }]), /numeric id/);
  await assert.rejects(() => dev.call("v.oai.rgbcfg", [1, 2]), /invalid params/);
});

test("a press emits the press and the release in the shape the bridge decodes", () => {
  const dev = virtualdevice.open();
  const seen = [];
  dev.onNotify = (method, params) => seen.push([method, params]);
  const sent = dev.press(3);
  assert.deepEqual(seen, [
    ["v.oai.hid", { k: "AG03", act: 1 }],
    ["v.oai.hid", { k: "AG03", act: 0 }],
  ]);
  assert.deepEqual(sent, [{ k: "AG03", act: 1 }, { k: "AG03", act: 0 }]);
});

test("key names follow the firmware's own split of AG and ACT", () => {
  const { keyName } = virtualdevice;
  assert.equal(keyName(0), "AG00");
  assert.equal(keyName(5), "AG05");
  assert.equal(keyName(6), "ACT06");
  assert.equal(keyName(12), "ACT12");
  assert.equal(keyName(13), "AG13", "the dial is an AG key");
  assert.equal(keyName(18), "AG18", "so is the joystick");
  assert.equal(keyName(19), null, "19 is in the thread space but is not a key");
  assert.equal(keyName(-1), null);
});

test("pressing a key that does not exist is an error, not a silent no-op", () => {
  const dev = virtualdevice.open();
  assert.throws(() => dev.press(99), /no such key/);
  assert.throws(() => dev.press("AG00"), /no such key/);
});

test("a closed pad refuses calls and presses", async () => {
  const dev = virtualdevice.open();
  dev.close();
  dev.close(); // closing twice is safe, as the interface requires
  await assert.rejects(() => dev.call("v.oai.thstatus", []), /closed/);
  assert.throws(() => dev.press(0), /closed/);
});

test("the module reaches for no timer, no process and no hardware", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "virtualdevice.js"), "utf8");
  // Comments say the words, so this looks at code lines only.
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  for (const banned of ["setTimeout", "setInterval", "setImmediate", "child_process", "node-hid", "require(\"fs\")"]) {
    assert.equal(code.includes(banned), false, `virtualdevice must not use ${banned}`);
  }
});
