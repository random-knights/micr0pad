"use strict";
// mapper.js - assign live agents to the 6 pad slots and produce lighting.
// Agents arrive already normalized by lib/providers (any provider, one shape).
// Slots are matched by a per-slot `match` rule: agent kind, a cwd substring,
// or a title substring. Unmatched slots go dark (idle). The underglow carries
// the worst state across all non-empty slots.
const pad = require("./pad");
const providers = require("./providers");

// The pad's status word for a normalized agent. Adapters already speak the
// pad's vocabulary; this is the last guard so a stray value lights "unknown"
// rather than nothing.
function statusOf(agent) {
  return providers.normalizeStatus(agent && agent.status);
}

// A slot in config:
//   { slot, name, agent, match, matchType: "agent"|"cwd"|"title" }
function agentMatches(a, slotCfg) {
  const type = slotCfg.matchType || "agent";
  const rule = slotCfg.match || slotCfg.agent;
  if (!rule) return false;
  switch (type) {
    case "cwd": return !!(a.cwd && a.cwd.includes(rule));
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

// Color/effect for one agent in a slot.
function threadFor(agent, slotCfg) {
  const id = pad.agentKeyIDs[slotCfg.slot];
  if (!agent) {
    return { id, brightness: 0, effect: 0 }; // dark
  }
  const state = statusOf(agent);
  const style = pad.statusColors[state] || pad.statusColors.unknown;
  // Per-slot color override wins over the status color, so each agent key can
  // carry its own identity color while the effect still follows state.
  const color = slotCfg.color ? pad.packedRGB(slotCfg.color) || style.color : style.color;
  return {
    id,
    color,
    brightness: pad.brightness,
    effect: style.effect,
    speed: pad.speed,
  };
}

// The underglow zone for the aggregate worst state, or null to switch off.
// Honors the underglow config: "solid" mode uses a fixed color/effect.
function zoneFor(assigned, underglowCfg) {
  const ug = underglowCfg || pad.underglow;
  const present = assigned
    .filter((x) => x.agent)
    .map((x) => statusOf(x.agent));
  if (present.length === 0) return null;
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
  // The colour still comes from the mode above, so "auto + spin" is a
  // travelling light in the worst agent's colour.
  const anim = ug.animation;
  const effect = anim !== undefined && anim !== null && anim !== "state" && Number.isFinite(Number(anim))
    ? Number(anim)
    : style.effect;
  return { e: effect, b: ug.brightness || pad.brightness, s: ug.speed || pad.speed, m: 1, c: style.color };
}

module.exports = { statusOf, agentMatches, assign, threadFor, zoneFor };
