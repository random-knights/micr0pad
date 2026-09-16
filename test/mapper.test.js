"use strict";
// What these tests hold in place: assigning live Herdr agents to the 6 slots
// by agent/cwd/title match, one agent used at most once, the per-slot color
// override winning over the status color, and - the worst-of-six rule -
// zoneFor() picking the single worst state present across all assigned
// slots to drive the underglow. No seam needed: mapper.js is pure, and
// herdr.statusOf() (which it calls) does no I/O.

const test = require("node:test");
const assert = require("node:assert");
const mapper = require("../lib/mapper");
const pad = require("../lib/pad");

const agent = (o) => Object.assign({ agent: "claude", status: "idle", cwd: "C:\\proj", foregroundCwd: null, title: "" }, o);

test("agentMatches by agent name is case-insensitive", () => {
  assert.equal(mapper.agentMatches(agent({ agent: "Claude" }), { match: "claude" }), true);
  assert.equal(mapper.agentMatches(agent({ agent: "codex" }), { match: "claude" }), false);
});

test("agentMatches by cwd checks both cwd and foregroundCwd", () => {
  const slot = { matchType: "cwd", match: "xyz" };
  assert.equal(mapper.agentMatches(agent({ cwd: "C:\\rand0m\\xyz" }), slot), true);
  assert.equal(mapper.agentMatches(agent({ cwd: "C:\\rand0m\\abc", foregroundCwd: "C:\\rand0m\\xyz" }), slot), true);
  assert.ok(!mapper.agentMatches(agent({ cwd: "C:\\rand0m\\abc" }), slot), "neither cwd nor foregroundCwd contains the rule");
});

test("agentMatches by title checks a substring", () => {
  assert.equal(mapper.agentMatches(agent({ title: "deploy: xyz staging" }), { matchType: "title", match: "staging" }), true);
  assert.equal(mapper.agentMatches(agent({ title: "deploy: xyz prod" }), { matchType: "title", match: "staging" }), false);
});

test("assign consumes the first matching unused agent, so two slots with the same rule split two agents", () => {
  const agents = [agent({ agent: "claude" }), agent({ agent: "claude" }), agent({ agent: "codex" })];
  const slots = [
    { slot: 0, match: "claude" },
    { slot: 1, match: "claude" },
    { slot: 2, match: "codex" },
    { slot: 3, match: "gemini" },
  ];
  const assigned = mapper.assign(agents, slots);
  assert.equal(assigned[0].agent, agents[0]);
  assert.equal(assigned[1].agent, agents[1], "the second claude slot gets the second claude agent, not the first again");
  assert.equal(assigned[2].agent, agents[2]);
  assert.equal(assigned[3].agent, null, "no gemini agent: the slot stays empty");
});

test("threadFor returns a dark frame for an empty slot", () => {
  const t = mapper.threadFor(null, { slot: 2 });
  assert.deepEqual(t, { id: pad.agentKeyIDs[2], brightness: 0, effect: 0 });
});

test("threadFor uses the status color/effect for each of the 4 known states plus unknown", () => {
  for (const status of ["idle", "working", "blocked", "done", "totally-made-up"]) {
    const t = mapper.threadFor(agent({ status }), { slot: 0 });
    const expectState = ["idle", "working", "blocked", "done"].includes(status) ? status : "unknown";
    const style = pad.statusColors[expectState];
    assert.equal(t.color, style.color, `status ${status} -> ${expectState}`);
    assert.equal(t.effect, style.effect);
  }
});

test("threadFor's per-slot color override wins over the status color, but the effect still follows state", () => {
  const t = mapper.threadFor(agent({ status: "working" }), { slot: 0, color: "#00ff00" });
  assert.equal(t.color, 0x00ff00);
  assert.equal(t.effect, pad.statusColors.working.effect);
});

test("threadFor falls back to the status color when the override hex is unparsable", () => {
  const t = mapper.threadFor(agent({ status: "idle" }), { slot: 0, color: "not-a-color" });
  assert.equal(t.color, pad.statusColors.idle.color);
});

test("zoneFor returns null when no slot has an agent (nothing to light)", () => {
  const assigned = [{ slotCfg: { slot: 0 }, agent: null }];
  assert.equal(mapper.zoneFor(assigned, pad.underglow), null);
});

test("zoneFor: worst-of-six - one blocked among five idle drives the underglow red", () => {
  const assigned = [
    { slotCfg: { slot: 0 }, agent: agent({ status: "idle" }) },
    { slotCfg: { slot: 1 }, agent: agent({ status: "idle" }) },
    { slotCfg: { slot: 2 }, agent: agent({ status: "idle" }) },
    { slotCfg: { slot: 3 }, agent: agent({ status: "idle" }) },
    { slotCfg: { slot: 4 }, agent: agent({ status: "idle" }) },
    { slotCfg: { slot: 5 }, agent: agent({ status: "blocked" }) },
  ];
  const zone = mapper.zoneFor(assigned, pad.underglow);
  assert.equal(zone.c, pad.statusColors.blocked.color);
  assert.equal(zone.e, pad.statusColors.blocked.effect);
});

test("zoneFor: worst-of-six priority order holds pairwise (working beats done beats unknown beats idle)", () => {
  const zoneWith = (states) => {
    const assigned = states.map((status, i) => ({ slotCfg: { slot: i }, agent: agent({ status }) }));
    return mapper.zoneFor(assigned, pad.underglow);
  };
  assert.equal(zoneWith(["working", "done"]).c, pad.statusColors.working.color);
  assert.equal(zoneWith(["done", "totally-unknown"]).c, pad.statusColors.done.color);
  assert.equal(zoneWith(["totally-unknown", "idle"]).c, pad.statusColors.unknown.color);
  assert.equal(zoneWith(["idle"]).c, pad.statusColors.idle.color);
});

test("zoneFor solid mode uses the fixed underglow color regardless of agent state", () => {
  const assigned = [{ slotCfg: { slot: 0 }, agent: agent({ status: "blocked" }) }];
  const zone = mapper.zoneFor(assigned, { mode: "solid", color: "#00ff00", effect: 1, brightness: 1, speed: 0.5 });
  assert.equal(zone.c, 0x00ff00);
});

test("zoneFor: an explicit animation overrides the state effect but not the state color", () => {
  const assigned = [{ slotCfg: { slot: 0 }, agent: agent({ status: "working" }) }];
  const zone = mapper.zoneFor(assigned, Object.assign({}, pad.underglow, { animation: 2 }));
  assert.equal(zone.e, 2, "spin (2) wins over working's own effect");
  assert.equal(zone.c, pad.statusColors.working.color, "the color still comes from the worst state");
});

// --- Fail-first target: worst-of-six ordering, caught by name. ---
test("zoneFor: blocked still wins even when it is the ONLY non-idle slot among six", () => {
  // If underglowPriority in lib/pad.js were reordered (e.g. blocked dropped
  // below working), this is the assertion that catches it by the exact
  // scenario the strip exists for: one blocked agent among five quiet ones.
  const assigned = ["idle", "idle", "idle", "idle", "idle", "blocked"].map((status, i) => ({
    slotCfg: { slot: i }, agent: agent({ status }),
  }));
  assert.equal(mapper.zoneFor(assigned, pad.underglow).c, pad.statusColors.blocked.color);
});
