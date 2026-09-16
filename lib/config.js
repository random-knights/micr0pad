"use strict";
// config.js - load (and default) the micropad config from config.json.
// Lets the owner change per-slot agent matching, colors, and bottom action
// mappings without touching code. config.json is git-ignored; config.example.json
// is the checked-in template.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pad = require("./pad");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const EXAMPLE_PATH = path.join(__dirname, "..", "config.example.json");

function defaults() {
  return {
    // Poll Herdr every N ms for agent status.
    pollIntervalMs: 2500,
    // Where the action-key .cmd launchers live. Absolute, or relative to the
    // app directory. Leave null to search MICROPAD_CMD_DIR, <app>/cmd and the
    // sibling _macropad folders - see lib/launcher.js.
    cmdDir: null,
    // Bring the browser window forward when the PAD's talk key is pressed.
    // Off by default: speech recognition needs a focused document, but taking
    // focus unasked is intrusive. See lib/focus.js.
    focusBrowserOnTalk: false,
    // The virtual pad: what the app serves when no Work Louder pad is on the
    // HID bus. `enabled: false` turns it off and leaves the app device-less,
    // which is the pre-virtual-pad behaviour. `onUnplug` decides what happens
    // when a pad that WAS connected goes away: false (the default) reports the
    // pad as gone, true falls back to the virtual pad. Off by default because
    // a virtual pad appearing by itself mid-session reads as the app losing
    // track of the hardware.
    virtualPad: { enabled: true, onUnplug: false },
    // The 6 status slots. `matchType` is "agent" | "cwd" | "title".
    slots: pad.defaultSlots,
    // Optional per-slot color/effect override keyed by state.
    statusColors: pad.statusColors,
    underglowPriority: pad.underglowPriority,
    underglow: pad.underglow,
    brightness: pad.brightness,
    speed: pad.speed,
    // Bottom action keys (excluding talk). Each runs a command you choose.
    //
    // These ship UNCONFIGURED on purpose: the defaults used to name one team's
    // internal scripts, so a fresh install had five buttons that could only
    // ever answer "cmd not found". Set them from the gear in the Action Keys
    // tile, or edit config.json directly; type "none" means the key does
    // nothing but still lights and reports its press.
    actions: {
      bolt:   { label: "Action 1", type: "none", cmd: "" },
      check:  { label: "Action 2", type: "none", cmd: "" },
      x:      { label: "Action 3", type: "none", cmd: "" },
      fork:   { label: "Action 4", type: "none", cmd: "" },
      talk:   { label: "Talk (voice)", type: "none" },
      terminal: { label: "Terminal", type: "none", cmd: "" },
    },
  };
}

let cache = null;
function load() {
  if (cache) return cache;
  const base = defaults();
  let merged = base;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const user = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      // shallow-ish merge
      merged = Object.assign(base, user, {
        statusColors: Object.assign({}, base.statusColors, user.statusColors),
        underglowPriority: user.underglowPriority || base.underglowPriority,
        actions: Object.assign({}, base.actions, user.actions),
      });
    } catch (e) {
      console.error("config.json failed to parse, using defaults:", e.message);
    }
  }
  ensurePairingToken(merged);
  return (cache = merged);
}

// The pairing token server.js requires on every mutating route. Minted once
// on first run (or on upgrade, if an older config.json predates this field)
// and written to config.json next to the other keys. Never logged - do not
// add this to any console.log/error line.
function ensurePairingToken(cur) {
  if (typeof cur.pairingToken === "string" && cur.pairingToken.length === 64) return;
  cur.pairingToken = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2), "utf8");
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
