"use strict";
// virtualdevice.js - the pad, with nothing behind it.
//
// PURE. No timers, no child processes, no HID, no file. It holds the key
// color matrix and the two light zones in memory, answers the JSON-RPC
// methods the firmware answers, and emits a key-press notification when the
// page says a key was pressed. The bridge drives it; it never drives itself.
// That is the same seam lib/watch.js uses, and it is what lets the pad
// behavior run under node --test with no hardware.
//
// THE METHOD SET, and where it came from. Every name here was read out of this
// repo, not invented:
//
//   v.oai.thstatus   per-key threads      lib/bridge.js, lights-off.js, probe.js
//   v.oai.rgbcfg     the keys/ambient zones  lib/bridge.js, server.js, lights-off.js
//   sys.version      firmware version     backup-keymap.js, probe.js
//
// Implemented as refusals, on purpose:
//
//   fs.read, fs.write   the DEVICE filesystem (keymap.json). A virtual pad has
//                       no flash. Answering with an invented keymap would put
//                       fabricated data where the only route back to stock
//                       lives, so both refuse and server.js keeps the keymap
//                       buttons on the physical pad.
//   device.status       probe.js tries it; no successful response shape is
//                       recorded anywhere in this repo, so there is nothing to
//                       implement without inventing it.
//   lights.preview      named in docs/DEVELOPMENT.md as using full field names
//                       and STRING effects, and nothing calls it.
//   everything else     including ble.*, sys.info, device.info, rpc.discover,
//                       which docs/DEVELOPMENT.md records the real firmware
//                       refusing too.
//
// Notifications, device to host: v.oai.hid {k, act} for a key, which is what
// press() emits. v.oai.rad (the joystick radial) is not emitted: the page has
// no joystick to move, and the dial and toggle already drive the bridge
// directly through /api/dial and /api/joy.
//
// ONE DELIBERATE DIFFERENCE from the firmware: the firmware accepts any
// payload and returns {"ok":1} regardless. This refuses params of the wrong
// shape with an invalid-params error, because a test seam that swallows a
// malformed frame teaches you nothing.
const { methodNotFound } = require("./device");

const MODEL = "virtual pad";
const INVALID_PARAMS = -32602;

// Key id -> name, as the firmware spells it in a v.oai.hid notification.
// From lib/pad.js: 0-5 are the agent status keys (AG00..AG05), 6-12 the action
// keys (ACT06..ACT12), 13/14 the dial and 15-18 the joystick sectors (AG13..AG18).
const AGENT_KEYS = [0, 1, 2, 3, 4, 5];
const ACTION_KEYS = [6, 7, 8, 9, 10, 11, 12];
const CONTROL_KEYS = [13, 14, 15, 16, 17, 18];

function keyName(id) {
  const n = String(id).padStart(2, "0");
  if (ACTION_KEYS.includes(id)) return `ACT${n}`;
  if (AGENT_KEYS.includes(id) || CONTROL_KEYS.includes(id)) return `AG${n}`;
  return null;
}

function invalidParams(method, why) {
  const err = new Error(`invalid params for ${method}: ${why}`);
  err.code = INVALID_PARAMS;
  err.method = method;
  return err;
}

function open() {
  // The color matrix: key id -> the last thread frame the host sent for it.
  // Frames merge, because the host sends partial frames ({id, b: 0, e: 0}).
  const threads = new Map();
  // The two light zones the firmware exposes through v.oai.rgbcfg.
  const zones = { keys: null, ambient: null };
  let closed = false;

  const bus = {
    descriptor: { kind: "virtual", model: MODEL },
    onNotify: null,
    onLog: null,
    call,
    close,
    // The surface only a virtual pad has. server.js reaches it through the
    // bridge so a page can press a key, and the bridge reads the snapshot to
    // replay the lights onto a physical pad when one arrives.
    press,
    snapshot,
  };

  function call(method, params = null) {
    if (closed) return Promise.reject(new Error("virtual pad is closed"));
    switch (method) {
      case "v.oai.thstatus": {
        if (!Array.isArray(params)) {
          return Promise.reject(invalidParams(method, "expected an array of thread frames"));
        }
        for (const frame of params) {
          if (!frame || typeof frame.id !== "number") {
            return Promise.reject(invalidParams(method, "every frame needs a numeric id"));
          }
          threads.set(frame.id, Object.assign({}, threads.get(frame.id), frame));
        }
        return Promise.resolve({ ok: 1 });
      }
      case "v.oai.rgbcfg": {
        if (!params || typeof params !== "object" || Array.isArray(params)) {
          return Promise.reject(invalidParams(method, "expected { keys, ambient }"));
        }
        if ("keys" in params) zones.keys = params.keys;
        if ("ambient" in params) zones.ambient = params.ambient;
        return Promise.resolve({ ok: 1 });
      }
      case "sys.version":
        // Honest about what it is. It does not claim a firmware version,
        // because there is no firmware.
        return Promise.resolve({ version: "virtual", model: MODEL });
      default:
        return Promise.reject(methodNotFound(method));
    }
  }

  // The page pressed a key. Emit the press and the release the same way the
  // firmware does, so the bridge takes exactly the path a real key takes: it
  // acts on act 1 and ignores act 0. Synchronous and with no timer between the
  // two, because a virtual key has no travel to wait for.
  //
  // Returns the notifications that were emitted, so a caller can see what the
  // device said rather than having to trust that it said something.
  function press(id) {
    if (closed) throw new Error("virtual pad is closed");
    const k = keyName(id);
    if (!k) throw new Error(`no such key: ${id}`);
    const sent = [];
    for (const act of [1, 0]) {
      const params = { k, act };
      sent.push(params);
      if (bus.onNotify) bus.onNotify("v.oai.hid", params);
    }
    return sent;
  }

  // Everything the device is currently showing, as the frames that produced
  // it. The bridge replays this onto a physical pad on handover, so the keys
  // light with the same colors they had a moment earlier.
  function snapshot() {
    return {
      threads: [...threads.keys()].sort((a, b) => a - b).map((id) => Object.assign({}, threads.get(id))),
      zones: { keys: zones.keys, ambient: zones.ambient },
    };
  }

  function close() { closed = true; }

  return bus;
}

module.exports = { open, MODEL, keyName, AGENT_KEYS, ACTION_KEYS, CONTROL_KEYS };
