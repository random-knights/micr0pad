"use strict";
// mapper.js - assign live Herdr agents to the 6 pad slots and produce lighting.
// Slots are matched by a per-slot `match` rule: agent name, a cwd substring, or
// a title substring. Unmatched slots go dark (idle). The underglow carries the
// worst state across all non-empty slots.
const pad = require("./pad");
const herdr = require("./herdr");

// A slot in config:
//   { slot, name, agent, match, matchType: "agent"|"cwd"|"title" }
function agentMatches(a, slotCfg) {
  const type = slotCfg.matchType || "agent";
  const rule = slotCfg.match || slotCfg.agent;
  if (!rule) return false;
  switch (type) {
    case "cwd": return (a.cwd && a.cwd.includes(rule)) || (a.foregroundCwd && a.foregroundCwd.includes(rule));
    case "title": return (a.title && a.title.includes(rule));
    case "agent":
    default: return (a.agent || "").toLowerCase() === String(rule).toLowerCase();
  }
}

// Assign agents to slots. A slot consumes the first matching unused agent so
// two claude slots can point at different panes via matchType/rule.
function assign(agents, slots) {
  const used = new Set();
  return slots.map((slotCfg) => {
    const hit = agents.find((a) => !used.has(a) && agentMatches(a, slotCfg));
    if (hit) used.add(hit);
    return { slotCfg, agent: hit || null };
  });
}

// Color/effect for one agent in a slot, as a v.oai.thstatus frame. The frame
// uses the firmware's abbreviated fields (c, b, e, s), the ones every other
// write in this codebase uses. The firmware answers ok to any spelling, so a
// wrong one fails silently.
//
// `rest` is what an empty slot shows: "family" (the default) lights it in its
// family color, anything else leaves it dark.
function threadFor(agent, slotCfg, rest = "family") {
  const id = pad.agentKeyIDs[slotCfg.slot];
  if (!agent) {
    const c = rest === "family" ? pad.restColors[slotCfg.slot] : undefined;
    if (c === undefined) return { id, b: 0, e: 0 }; // dark
    return { id, c, b: pad.brightness, e: 1, s: pad.speed };
  }
  const state = herdr.statusOf(agent);
  const style = pad.statusColors[state] || pad.statusColors.unknown;
  // Per-slot color override wins over the status color, so each agent key can
  // carry its own identity color while the effect still follows state.
  // The one exception is blocked: an agent that has stopped to ask is the
  // thing the pad exists to show, so it always takes the blocked color.
  const own = state === "blocked" ? null : slotCfg.color;
  const color = own ? pad.packedRGB(own) || style.color : style.color;
  return { id, c: color, b: pad.brightness, e: style.effect, s: pad.speed };
}

// The underglow zone for the aggregate worst state, or null to switch off.
// Honors the underglow config: "solid" mode uses a fixed color/effect.
// With no agent on any key the outer light is off, unless `rest` is "family":
// then it rests in the primary family color, like the keys do.
function zoneFor(assigned, underglowCfg, rest) {
  const ug = underglowCfg || pad.underglow;
  const present = assigned
    .filter((x) => x.agent)
    .map((x) => herdr.statusOf(x.agent));
  if (present.length === 0) {
    if (rest !== "family") return null;
    return { e: 1, b: ug.brightness || pad.brightness, s: ug.speed || pad.speed, m: 1, c: pad.restColors[0] };
  }
  let style;
  if (ug.mode === "solid") {
    style = { color: pad.packedRGB(ug.color) || 0xff4124, effect: ug.effect || 1 };
  } else {
    for (const state of pad.underglowPriority) {
      if (present.includes(state)) { style = pad.statusColors[state] || pad.statusColors.unknown; break; }
    }
    style = style || pad.statusColors.unknown;
  }
  // An explicit animation wins over both the status effect and the fixed one.
  // The color still comes from the mode above, so "auto + spin" is a
  // traveling light in the worst agent's color.
  const anim = ug.animation;
  const effect = anim !== undefined && anim !== null && anim !== "state" && Number.isFinite(Number(anim))
    ? Number(anim)
    : style.effect;
  return { e: effect, b: ug.brightness || pad.brightness, s: ug.speed || pad.speed, m: 1, c: style.color };
}

module.exports = { agentMatches, assign, threadFor, zoneFor };
