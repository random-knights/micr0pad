"use strict";
// What these tests hold in place: the pad's own model - the 6 agent key ids
// in reading order, the action key map, the worst-of-six underglow priority
// order, the status color/effect table (blocked/working/done/idle/unknown),
// and packedRGB's hex parsing. Pure data and one pure function; no seam
// needed, nothing here touches a device.

const test = require("node:test");
const assert = require("node:assert");
const pad = require("../lib/pad");

test("agentKeyIDs has exactly the 6 status keys, in reading order", () => {
  assert.deepEqual(pad.agentKeyIDs, [0, 1, 2, 3, 4, 5]);
});

test("actionKeyIDs maps every logical action name to its firmware id", () => {
  assert.equal(pad.actionKeyIDs.bolt, 6);
  assert.equal(pad.actionKeyIDs.check, 7);
  assert.equal(pad.actionKeyIDs.x, 8);
  assert.equal(pad.actionKeyIDs.fork, 9);
  assert.deepEqual(pad.actionKeyIDs.talk, [10, 11], "the wide talk key is two switches");
  assert.equal(pad.actionKeyIDs.terminal, 12);
});

test("defaultSlots names 6 slots 0..5 with a match rule and a color each", () => {
  assert.equal(pad.defaultSlots.length, 6);
  pad.defaultSlots.forEach((s, i) => {
    assert.equal(s.slot, i);
    assert.ok(s.match, `slot ${i} needs a match rule`);
    assert.match(s.color, /^#[0-9a-f]{6}$/i, `slot ${i} needs a hex color`);
  });
});

test("statusColors covers blocked, working, done, idle and unknown, each with a color and effect", () => {
  for (const state of ["blocked", "working", "done", "idle", "unknown"]) {
    const style = pad.statusColors[state];
    assert.ok(style, `missing statusColors.${state}`);
    assert.equal(typeof style.color, "number");
    assert.equal(typeof style.effect, "number");
    assert.equal(typeof style.label, "string");
  }
});

test("blocked and working are visually distinct (the reason working moved off brand orange)", () => {
  assert.notEqual(pad.statusColors.blocked.color, pad.statusColors.working.color);
});

test("underglowPriority lists blocked worst, then working, done, unknown, idle", () => {
  assert.deepEqual(pad.underglowPriority, ["blocked", "working", "done", "unknown", "idle"]);
});

test("underglowPriority names only real statusColors entries", () => {
  for (const state of pad.underglowPriority) {
    assert.ok(pad.statusColors[state], `underglowPriority names ${state}, which is not in statusColors`);
  }
});

test("maxThreadID covers every AG id including the dial and joystick sectors", () => {
  assert.equal(pad.maxThreadID, 19);
});

test("displayRows is the pad's reading-order layout: top row RIGHT-to-LEFT firmware ids", () => {
  assert.deepEqual(pad.displayRows[0], [1, 0], "row0 firmware ids: 1 is top-left, 0 top-right");
  assert.deepEqual(pad.displayRows[1], [2, 3, 4, 5]);
  assert.deepEqual(pad.displayRows[2], [6, 7, 8, 9]);
  assert.deepEqual(pad.displayRows[3], [10, 11, 12]);
});

test("packedRGB packs a 6-digit hex string", () => {
  assert.equal(pad.packedRGB("#ff4124"), 0xff4124);
  assert.equal(pad.packedRGB("ff4124"), 0xff4124, "the leading # is optional");
});

test("packedRGB expands a 3-digit shorthand hex string", () => {
  assert.equal(pad.packedRGB("#0f0"), 0x00ff00);
});

test("packedRGB rejects anything that is not 3 or 6 hex digits", () => {
  assert.equal(pad.packedRGB("#ff41"), null);
  assert.equal(pad.packedRGB("#ff41244"), null);
  assert.equal(pad.packedRGB(""), null);
});

test("underglow default follows agent state and starts at the brand color", () => {
  assert.equal(pad.underglow.mode, "auto");
  assert.equal(pad.underglow.animation, "state");
  assert.equal(pad.underglow.color, "#ff4124");
});

test("underglowEffects always offers state-follow plus every firmware effect id 0-6", () => {
  const ids = pad.underglowEffects.map((e) => e.id);
  assert.ok(ids.includes("state"));
  for (const n of [0, 1, 2, 3, 4, 5, 6]) assert.ok(ids.includes(n), `missing firmware effect ${n}`);
});

test("statusColors effect ids are real firmware effects (0-6), not an invented number", () => {
  for (const state of Object.keys(pad.statusColors)) {
    assert.ok(pad.statusColors[state].effect >= 0 && pad.statusColors[state].effect <= 6, state);
  }
});

// --- Fail-first target: a wrong color in the status table, caught by name. ---
test("blocked is the vivid red 0xff2d2d the header comment documents", () => {
  // If blocked's color were quietly changed (or swapped with working's), this
  // is the assertion that catches it, by the exact hex value the comment in
  // lib/pad.js commits to - not a downstream "the pad looked wrong" report.
  assert.equal(pad.statusColors.blocked.color, 0xff2d2d);
});
