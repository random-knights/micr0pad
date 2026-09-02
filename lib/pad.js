"use strict";
// pad.js - Creator Micro 2 (Codex Micro) geometry and the RK status config.
//
// Physical rows (looking at the pad). Firmware key index runs row-major from 0,
// and the TOP row is wired RIGHT to LEFT: key 0 is the top-RIGHT key. Reading
// order (left to right, top to bottom) therefore starts 1, 0 for the top row.
//
//   row0  (top):        [1, 0]        <- firmware ids: 1 is top-left, 0 top-right
//   row1  (second):      [2, 3, 4, 5]
//   row2  (action):      [6, 7, 8, 9]
//   row3  (bottom):      [10, 11, 12]  <- 10+11 under one wide keycap
//
// The keymap on THIS device (firmware v0.4.1) binds:
//   row0 + row1 -> KV_OAI_AG00..AG05   (the 6 agent status keys, RGBlit-able)
//   row2        -> KV_OAI_ACT06..ACT09 (action keys)
//   row3        -> KV_OAI_ACT10..ACT12 (10+11 wide = mic/talk, 12 = terminal)
//   encoder     -> KV_OAI_ENC_CW / ENC_CC / ENC_CLK
//
// Only AG-bound keys can be individually lit. The 6 status keys are AG00..AG05,
// so per-key lighting works out of the box on this unit.

// Agent status keys in READING order: slot N lights firmware key agentKeyIDs[N].
// The keymap layout (verified live via probe) is in physical reading order:
// row0 = [AG00, AG01], so AG00 is the top-LEFT key and AG01 the top-RIGHT key.
// The owner wants claude 1 top-left and claude 2 top-right, so slot 0 (claude 1)
// maps to key 0 (AG00, top-left) and slot 1 (claude 2) to key 1 (AG01, top-right).
const agentKeyIDs = [0, 1, 2, 3, 4, 5];

// Bottom action rows (excluding the talk key 10/11). slot -> firmware id.
const actionKeyIDs = {
  bolt: 6,   // action 1
  check: 7,  // action 2
  x: 8,      // action 3
  fork: 9,   // action 4
  talk: [10, 11], // mic / talk (wide cap)
  terminal: 12,   // >_ claude
};

// Firmware keycode table runs to AG19; clear the whole space when blanking.
const maxThreadID = 19;

// Display rows (reading order) for the on-screen pad mirror.
const displayRows = [
  [1, 0],
  [2, 3, 4, 5],
  [6, 7, 8, 9],
  [10, 11, 12],
];

// The default slot -> provider mapping. Herdr agent names drive status.
// Top two slots are both claude (claude 1 / claude 2) so the owner can use
// both for different panes; what each action key runs is up to the config.
// Each slot may carry a `color` (hex string or int) that overrides the
// status color for that key, so agents are distinguishable at a glance.
const defaultSlots = [
  // Slot 0 = claude 1 (top-LEFT key, firmware key 1, brand orange).
  // Slot 1 = claude 2 (top-RIGHT key, firmware key 0, purple).
  { slot: 0, name: "claude 1", agent: "claude", match: "claude", color: "#ff4124" },
  { slot: 1, name: "claude 2", agent: "claude", match: "claude", color: "#7c4dff" },
  { slot: 2, name: "codex", agent: "codex", match: "codex", color: "#00b0ff" },
  { slot: 3, name: "gemini", agent: "gemini", match: "gemini", color: "#00c853" },
  { slot: 4, name: "grok", agent: "grok", match: "grok", color: "#ffa000" },
  { slot: 5, name: "huggingface", agent: "hermes", match: "hermes", color: "#90a4ae" },
];

// RK branding canon colors (rk_branding/canon/site-canon.md). Status states map
// to these so the pad reads as part of the family. #ff4124 is the primary.
const statusColors = {
  // blocked / needs you: vivid red, breathing (distinct from idle)
  blocked: { color: 0xff2d2d, effect: 4, label: "Blocked" },
  // working: purple, solid. It used to be the brand orange 0xff4124, which is
  // a hair from the blocked red - on the pad and in the mirror the two states
  // were indistinguishable at a glance.
  working: { color: 0x7c4dff, effect: 1, label: "Working" },
  // done: finished but not yet looked at -> blue
  done: { color: 0x00b0ff, effect: 1, label: "Done" },
  // idle: finished and seen -> yellow
  idle: { color: 0xffd400, effect: 1, label: "Idle" },
  // unknown: quiet neutral steel
  unknown: { color: 0x90a4ae, effect: 1, label: "Unknown" },
};

// Worst state priority for the underglow (highest first).
const underglowPriority = ["blocked", "working", "done", "unknown", "idle"];

// Outer-light (underglow) appearance. `mode` is "auto" (follow worst agent
// state) or "solid" (fixed color). `effect` 1 = solid, 5 = gradient.
// `animation` overrides the effect the outer light runs with. "state" keeps the
// existing behaviour (auto mode uses each status's own effect, fixed mode uses
// `effect`); any other value is a firmware effect id and wins over both.
// Firmware effect set (docs/hacking.md): 0 off, 1 solid, 2 snake, 3 rainbow,
// 4 breathing, 5 gradient, 6 shallow breath. There is no separate "spin" or
// "wave" - snake is the travelling one, rainbow the colour-cycling one.
const underglowEffects = [
  { id: "state", label: "Follow state", hint: "auto uses each status effect" },
  { id: 1, label: "Solid", hint: "no animation" },
  { id: 4, label: "Pulse", hint: "breathing" },
  { id: 6, label: "Soft pulse", hint: "shallow breath" },
  { id: 2, label: "Spin", hint: "snake - the travelling effect" },
  { id: 3, label: "Rainbow", hint: "cycles hue, ignores the color above" },
  { id: 5, label: "Gradient", hint: "gradient sweep" },
  { id: 0, label: "Off", hint: "outer light dark" },
];

const underglow = {
  mode: "auto",       // "auto" | "solid"
  color: "#ff4124",   // used when mode is "solid"
  effect: 1,          // 1 = solid, 5 = gradient
  animation: "state", // "state" or a firmware effect id
  brightness: 1,
  speed: 0.5,
};

const brightness = 1;
const speed = 0.5;

// pack "#RRGGBB" or "#RGB" -> int
function packedRGB(hex) {
  let t = hex.startsWith("#") ? hex.slice(1) : hex;
  if (t.length === 3) t = t.split("").map((c) => c + c).join("");
  if (t.length !== 6) return null;
  return parseInt(t, 16);
}

module.exports = {
  underglowEffects,
  agentKeyIDs,
  actionKeyIDs,
  maxThreadID,
  displayRows,
  defaultSlots,
  statusColors,
  underglowPriority,
  underglow,
  brightness,
  speed,
  packedRGB,
};
