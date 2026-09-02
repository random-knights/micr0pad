"use strict";
// launcher.js - find the .cmd files the action keys run.
//
// Both entry points need this (the HTTP handler for the on-screen buttons and
// the bridge for physical key presses), and when they each carried their own
// relative hop the two could disagree - and did: moving the app into its own
// repo left both resolving to a directory one level off the drive root, so
// every action key answered "cmd not found" whichever way it was pressed.
//
// Resolution order, first hit wins:
//   1. MICROPAD_CMD_DIR              - explicit, for any layout
//   2. config.json "cmdDir"          - per-install, absolute or repo-relative
//   3. <app>/cmd                     - the obvious place in a clone
//   4. ../_macropad, ../../_macropad, ../../../_macropad, ../../../../_macropad
//                                    - the workspace layouts this grew up in
const fs = require("fs");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");

function candidates(cfg) {
  const out = [];
  if (process.env.MICROPAD_CMD_DIR) out.push(path.resolve(process.env.MICROPAD_CMD_DIR));
  if (cfg && cfg.cmdDir) out.push(path.resolve(APP_DIR, cfg.cmdDir));
  out.push(path.join(APP_DIR, "cmd"));
  for (const up of ["..", "../..", "../../..", "../../../.."]) {
    out.push(path.resolve(APP_DIR, up, "_macropad"));
  }
  return out;
}

/** The directory action commands live in, or null when none exists yet. */
function cmdDir(cfg) {
  for (const dir of candidates(cfg)) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch (_) { /* unreadable, try the next */ }
  }
  return null;
}

/**
 * Full path to one action command, or null when it cannot be found.
 * `name` is the file name from config.json, e.g. "judge.cmd".
 */
function resolveCmd(name, cfg) {
  if (!name) return null;
  // An absolute path in config wins outright.
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  for (const dir of candidates(cfg)) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** For diagnostics: what was searched, and what exists. */
function describe(cfg) {
  return candidates(cfg).map((dir) => ({ dir, exists: fs.existsSync(dir) }));
}

module.exports = { resolveCmd, cmdDir, describe, APP_DIR };
