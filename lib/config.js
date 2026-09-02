"use strict";
// config.js - load (and default) the micropad config from config.json.
// Lets the owner change per-slot agent matching, colors, and bottom action
// mappings without touching code. config.json is git-ignored; config.example.json
// is the checked-in template.
const fs = require("fs");
const path = require("path");
const pad = require("./pad");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const EXAMPLE_PATH = path.join(__dirname, "..", "config.example.json");

function defaults() {
  return {
    // Poll Herdr every N ms for agent status.
    pollIntervalMs: 2500,
    // The 6 status slots. `matchType` is "agent" | "cwd" | "title".
    slots: pad.defaultSlots,
    // Optional per-slot color/effect override keyed by state.
    statusColors: pad.statusColors,
    underglowPriority: pad.underglowPriority,
    underglow: pad.underglow,
    brightness: pad.brightness,
    speed: pad.speed,
    // Bottom action keys (excluding talk). Each maps to a role launcher to run.
    actions: {
      bolt:   { label: "Deploy wf80",  type: "cmd", cmd: "staging-dispatch.cmd" },
      check:  { label: "Judge",        type: "cmd", cmd: "judge.cmd" },
      x:      { label: "Janitor",      type: "cmd", cmd: "janitor.cmd" },
      fork:   { label: "Commit/Push", type: "cmd", cmd: "commit-push.cmd" },
      talk:   { label: "Talk (voice)", type: "none" },
      terminal: { label: "Claude (new tab)", type: "cmd", cmd: "claude-herdr.cmd" },
    },
  };
}

let cache = null;
function load() {
  if (cache) return cache;
  const base = defaults();
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const user = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      // shallow-ish merge
      return (cache = Object.assign(base, user, {
        statusColors: Object.assign({}, base.statusColors, user.statusColors),
        underglowPriority: user.underglowPriority || base.underglowPriority,
        actions: Object.assign({}, base.actions, user.actions),
      }));
    } catch (e) {
      console.error("config.json failed to parse, using defaults:", e.message);
    }
  }
  return (cache = base);
}

function writeExample() {
  const ex = defaults();
  if (!fs.existsSync(EXAMPLE_PATH)) {
    fs.writeFileSync(EXAMPLE_PATH, JSON.stringify(ex, null, 2), "utf8");
  }
}

// Persist the current config back to config.json. Used by the web UI so the
// owner can rename slots (visual reference) and tweak colors without editing
// the file by hand.
//
// MUTATES the cached object IN PLACE rather than replacing it. The bridge
// holds a reference to the object `load()` returned at startup; if save()
// swapped in a fresh object, the running bridge would keep reading the old
// one and underglow/slot changes would never reach the device until restart.
// Mutating the same object means the live bridge sees every change
// immediately.
function save(next) {
  const cur = load();
  if (next.slots) cur.slots = next.slots;
  if (next.underglow) cur.underglow = next.underglow;
  if (next.statusColors) Object.assign(cur.statusColors, next.statusColors);
  if (next.actions) Object.assign(cur.actions, next.actions);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2), "utf8");
  return cur;
}

module.exports = { load, defaults, CONFIG_PATH, writeExample, save };
