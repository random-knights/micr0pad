"use strict";
// device.js - the pad interface the bridge consumes, and nothing else.
//
// There are two implementations. lib/wldevice.js is the real Work Louder pad
// over raw HID. lib/virtualdevice.js answers the same calls in memory, so the
// app has something to drive when no pad is on the bus. The bridge holds one
// of them and does not care which, except to say so in the dashboard.
//
// A device is a plain object:
//
//   descriptor       { kind: "hid" | "virtual", model: string|null }
//   onNotify         null, or fn(method, params) for a device-to-host event
//   onLog            null, or fn(text) for the device debug channel
//   call(m, params)  Promise of the result; REJECTS when the device says no
//   close()          release it; safe to call on an already closed device
//
// The one rule that makes a stand-in trustworthy: METHOD NOT FOUND IS A
// REJECTION, never a resolved value. The firmware answers an unknown method
// with a JSON-RPC error and wldevice turns that into a rejected promise. A
// virtual pad that resolved {ok:1} instead would report success for a call the
// hardware refuses, and every caller would believe it.
//
// The second rule is the firmware's own trap, restated here because it applies
// to both implementations: {"ok":1} means the frame was accepted, not that a
// light changed. See docs/DEVELOPMENT.md.

// JSON-RPC 2.0 reserved code for an unknown method.
const METHOD_NOT_FOUND = -32601;

// The error an implementation rejects with for a method it does not have. The
// message matches what the firmware returns ("Method not found", recorded in
// docs/DEVELOPMENT.md from live probing), so a caller cannot tell a virtual
// refusal from a hardware one by reading the message.
function methodNotFound(method) {
  const err = new Error("Method not found");
  err.code = METHOD_NOT_FOUND;
  err.method = method;
  return err;
}

// Descriptor for whatever the bridge is holding, including nothing at all.
function descriptorOf(dev) {
  if (dev && dev.descriptor) return dev.descriptor;
  return { kind: "none", model: null };
}

module.exports = { METHOD_NOT_FOUND, methodNotFound, descriptorOf };
