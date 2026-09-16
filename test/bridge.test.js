"use strict";
// What these tests hold in place: the bridge always prefers the physical pad,
// falls back to the virtual one when there is none, hands over the moment a
// pad appears (replaying the lights it was showing), does NOT quietly replace
// an unplugged pad with a virtual one, and never reports a virtual pad as a
// connected device.
//
// No hardware, no child process and no timer: the opener and the agent roster
// are injected, and refresh() is called by hand. start() owns the only timer
// in the bridge and is deliberately not used here.

const test = require("node:test");
const assert = require("node:assert");
const { MicropadBridge } = require("../lib/bridge");
const config = require("../lib/config");
const pad = require("../lib/pad");

// A stand-in for a real HID pad: it records what was written to it.
function fakeHid() {
  const dev = {
    descriptor: { kind: "hid", model: "Creator Micro 2" },
    onNotify: null,
    onLog: null,
    calls: [],
    closed: false,
    call(method, params) { dev.calls.push([method, params]); return Promise.resolve({ ok: 1 }); },
    close() { dev.closed = true; },
  };
  return dev;
}

// An empty roster. lib/herdr.js shells out to the herdr CLI, so a test that
// used the real one would spawn a process and depend on what is running.
const emptyHerdr = {
  listAgents: async () => [],
  statusOf: () => "idle",
  focusedAgent: async () => null,
  focus: async () => {},
  prompt: async () => {},
  navigate: async () => {},
};

// Config without touching the owner's config.json on this machine.
function cfg(extra) {
  return Object.assign({
    pollIntervalMs: 2500,
    slots: pad.defaultSlots,
    statusColors: pad.statusColors,
    underglow: pad.underglow,
    actions: {},
  }, extra);
}

// A bridge whose HID opener is a script: one entry per connect() attempt,
// either a device to return or an Error to throw.
function bridgeWith(plan, extraCfg) {
  const script = plan.slice();
  const bridge = new MicropadBridge(cfg(extraCfg), {
    openHid: () => {
      const next = script.length ? script.shift() : new Error("no Work Louder vendor interface found (is the pad plugged in?)");
      if (next instanceof Error) throw next;
      return next;
    },
    herdr: emptyHerdr,
  });
  const notices = [];
  bridge.on("notice", (n) => notices.push(n.text));
  return { bridge, notices };
}

test("with no pad on the bus the bridge serves a virtual one", async () => {
  const { bridge, notices } = bridgeWith([]);
  await bridge.refresh();
  assert.equal(bridge.deviceKind(), "virtual");
  assert.equal(bridge.deviceUp(), false, "a virtual pad is not a connected device");
  assert.deepEqual(bridge.descriptor(), { kind: "virtual", model: "virtual pad" });
  assert.ok(notices.includes("no pad found: serving a virtual pad"));
  assert.match(bridge.deviceError, /is the pad plugged in/, "the HID reason is still reported");
  assert.equal(bridge.timer, null, "refresh() starts no timer");
});

test("the virtual pad is lit by the same mapper the real pad is", async () => {
  const { bridge } = bridgeWith([]);
  await bridge.refresh();
  const shown = bridge.dev.snapshot();
  assert.deepEqual(shown.threads.map((t) => t.id), pad.agentKeyIDs, "one frame per agent key");
  assert.ok(shown.zones.ambient, "the outer light was painted too");
});

test("a physical pad takes over from the virtual one and the lights are replayed", async () => {
  const hid = fakeHid();
  const { bridge, notices } = bridgeWith([new Error("no pad"), hid]);
  await bridge.refresh();
  const beforeHandover = bridge.dev.snapshot();
  assert.equal(bridge.deviceKind(), "virtual");

  await bridge.refresh(); // the pad is plugged in between polls
  assert.equal(bridge.deviceKind(), "hid");
  assert.equal(bridge.deviceUp(), true);
  assert.ok(notices.includes("physical pad connected: the virtual pad has stepped aside"));

  // The FIRST thing written to the real pad is the matrix the virtual pad was
  // holding, not whatever the next poll would have painted.
  const [method, params] = hid.calls[0];
  assert.equal(method, "v.oai.thstatus");
  assert.deepEqual(params, beforeHandover.threads);
  assert.equal(hid.calls[1][0], "v.oai.rgbcfg");
});

test("an unplugged pad is not quietly replaced by a virtual one", async () => {
  const hid = fakeHid();
  const { bridge } = bridgeWith([hid]);
  await bridge.refresh();
  assert.equal(bridge.deviceKind(), "hid");
  // The pad goes away: refresh() drops the handle the way a failed write does.
  bridge.dev = null;
  await bridge.refresh();
  assert.equal(bridge.deviceKind(), "none", "the pad is gone, and the app says so");
  assert.equal(bridge.deviceUp(), false);
});

test("virtualPad.onUnplug brings the virtual pad back, when the owner asks for it", async () => {
  const hid = fakeHid();
  const { bridge } = bridgeWith([hid], { virtualPad: { enabled: true, onUnplug: true } });
  await bridge.refresh();
  assert.equal(bridge.deviceKind(), "hid");
  bridge.dev = null;
  await bridge.refresh();
  assert.equal(bridge.deviceKind(), "virtual");
});

test("virtualPad.enabled false is the pre-virtual-pad behaviour", async () => {
  const { bridge } = bridgeWith([], { virtualPad: { enabled: false } });
  await bridge.refresh();
  assert.equal(bridge.deviceKind(), "none");
  assert.equal(bridge.dev, null);
});

test("a page press reaches the key handlers only through a virtual pad", async () => {
  const { bridge } = bridgeWith([]);
  await bridge.refresh();
  const seen = [];
  bridge.on("actkeyevent", (e) => seen.push(e));
  bridge.press(6);
  assert.deepEqual(seen, [
    { index: 6, pressed: true, raw: { k: "ACT06", act: 1 } },
    { index: 6, pressed: false, raw: { k: "ACT06", act: 0 } },
  ]);
});

test("a page press is refused while the real pad is live", async () => {
  const { bridge } = bridgeWith([fakeHid()]);
  await bridge.refresh();
  assert.throws(() => bridge.press(6), /need the virtual pad/);
});

test("pairing mode still releases everything and starts nothing", async () => {
  const { bridge } = bridgeWith([]);
  await bridge.refresh();
  await bridge.setPairing(true);
  assert.equal(bridge.dev, null, "pairing releases the device, virtual or not");
  await bridge.refresh();
  assert.equal(bridge.deviceKind(), "none", "and refresh does not re-open one while pairing");
  if (bridge.timer) { clearInterval(bridge.timer); bridge.timer = null; }
});

test("the real config ships the virtual pad on, and the fallback off", () => {
  const d = config.defaults();
  assert.deepEqual(d.virtualPad, { enabled: true, onUnplug: false });
});

// --- RK-43: handover edge cases not covered by RK-42's happy-path tests. ---

test("handover(): connect() still fails mid-poll and the SAME virtual pad is kept, not replaced", async () => {
  const { bridge } = bridgeWith([]);
  await bridge.refresh();
  const virtual = bridge.dev;
  assert.equal(bridge.deviceKind(), "virtual");
  // Next poll: still no physical pad (openHid script is empty, so connect()
  // keeps throwing). handover() must return false and leave dev untouched.
  const result = await bridge.handover();
  assert.equal(result, false);
  assert.equal(bridge.dev, virtual, "the exact same virtual instance, not a fresh one");
  assert.equal(bridge.deviceKind(), "virtual");
});

test("handover(): a replay failure is reported but the new physical device is kept connected", async () => {
  const hid = fakeHid();
  hid.call = () => Promise.reject(new Error("write timed out"));
  const { bridge, notices } = bridgeWith([new Error("no pad"), hid]);
  await bridge.refresh(); // virtual pad, with something painted on it
  assert.equal(bridge.deviceKind(), "virtual");

  const result = await bridge.handover();
  assert.equal(result, true, "handover still reports success: the pad IS connected");
  assert.equal(bridge.deviceKind(), "hid", "the physical pad stays attached despite the failed replay");
  assert.ok(
    notices.some((n) => n.startsWith("device connected but the replay failed:")),
    "the replay failure is surfaced, not swallowed"
  );
  assert.ok(notices.includes("physical pad connected: the virtual pad has stepped aside"));
});

test("handover(): an empty snapshot (nothing painted yet) writes nothing to the new pad", async () => {
  const hid = fakeHid();
  const { bridge } = bridgeWith([new Error("no pad"), hid]);
  // connect() consumes the first script entry (the Error) without a poll, so
  // startVirtual() attaches a bare virtual pad that has never been painted -
  // refresh() would paint it immediately, which is exactly what this test
  // needs to NOT happen yet.
  assert.equal(bridge.connect(), false);
  assert.equal(bridge.startVirtual(), true);
  assert.deepEqual(bridge.dev.snapshot(), { threads: [], zones: { keys: null, ambient: null } }, "a fresh virtual pad has painted nothing");

  const result = await bridge.handover();
  assert.equal(result, true);
  assert.deepEqual(hid.calls, [], "no thstatus and no rgbcfg call when there was nothing to replay");
});

test("handover(): the outgoing virtual pad is closed once the physical pad is attached", async () => {
  const hid = fakeHid();
  const { bridge } = bridgeWith([new Error("no pad"), hid]);
  await bridge.refresh();
  const virtual = bridge.dev;
  assert.equal(virtual.descriptor.kind, "virtual");

  await bridge.handover();
  // virtualdevice.js marks itself closed and refuses further calls; proving
  // that here (rather than reading a private flag) is what "closed" means.
  await assert.rejects(() => virtual.call("v.oai.thstatus", []), /closed/);
});
