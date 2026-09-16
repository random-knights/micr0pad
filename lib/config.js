"use strict";
// config.js - load (and default) the micropad config from config.json.
// Lets the owner change per-slot agent matching, colors, and bottom action
// mappings without touching code. config.json is git-ignored; config.example.json
// is the checked-in template.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pad = require("./pad");

// RK_MICROPAD_CONFIG points the whole config layer at another file. It exists
// so a test can exercise the real server against a throwaway config without
// writing the owner's own config.json - pairing WRITES to this file, and a
// test suite that appended pairings to the running owner's config would be
// changing the machine it is meant to be checking. Same spirit as
// RK_MICROPAD_PORT and AIEDS_LOG_PATH.
const CONFIG_PATH = process.env.RK_MICROPAD_CONFIG
  ? path.resolve(process.env.RK_MICROPAD_CONFIG)
  : path.join(__dirname, "..", "config.json");
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
    // Hosted origins allowed to ATTEMPT a pairing (see lib/pairing.js). This
    // is the list of pages that may show a "pair with my bridge" box at all;
    // being on it grants nothing by itself. Never a wildcard - an entry that
    // is not a plain https origin is dropped on load.
    hostedOrigins: ["https://rand0m.ai", "https://abc-rand0m-ai.web.app"],
    // Completed pairings: { id, origin, tokenHash, createdAt, label }. The
    // token itself is returned once at pairing time and never stored, so this
    // array is safe to read and useless to steal.
    pairings: [],
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
        // An older config.json predates both of these, and a config.json that
        // carries `pairings: null` must not crash the pairing module.
        hostedOrigins: Array.isArray(user.hostedOrigins) ? user.hostedOrigins : base.hostedOrigins,
        pairings: Array.isArray(user.pairings) ? user.pairings : [],
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

// Persist the pairing list and nothing else. Separate from save() because
// save() takes a patch from the WEB UI and must never be able to write a
// pairing: a page that could POST a pairing record could pair itself.
function savePairings(pairings) {
  const cur = load();
  cur.pairings = Array.isArray(pairings) ? pairings : [];
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2), "utf8");
  return cur.pairings;
}

function writeExample() {
  const ex = defaults();
  // The example is a template, not a state file. An empty pairing list is
  // still state, and a reader who copies it should start from nothing.
  ex.pairings = [];
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

module.exports = { load, defaults, CONFIG_PATH, writeExample, save, savePairings };
