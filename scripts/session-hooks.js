#!/usr/bin/env node
"use strict";
// session-hooks.js - add (or remove) the Claude Code hooks that report a
// session's state to the local bridge (hooks/session-report.js).
//
//   npm run session-hooks                 show what would change, write nothing
//   npm run session-hooks -- --write      back up settings.json, then write it
//   npm run session-hooks -- --remove --write
//   npm run session-hooks -- --file <path>   another settings file
//
// It edits one file, the user's Claude Code settings.json, and only the
// "hooks" key in it. Every other key is written back as it was read. Hooks
// that are already there are kept: an entry is ours only if its command names
// session-report.js, and those are the only entries this ever adds, replaces
// or removes. Without --write it prints the plan and stops, the same habit as
// add-layers.js: a settings file is not something to change on a first run.
const fs = require("fs");
const os = require("os");
const path = require("path");

// The events hooks/session-report.js maps to a state. Each one is a moment the
// session's state can change; see the table in that file.
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];
const MARK = "session-report.js";

function hookCommand(appDir, provider = "claude") {
  // Forward slashes and double quotes read the same in every shell a hook is
  // run from on Windows, macOS and Linux.
  const script = path.join(appDir, "hooks", MARK).replace(/\\/g, "/");
  return `node "${script}" ${provider}`;
}

function isOurs(hook) {
  return Boolean(hook) && typeof hook.command === "string" && hook.command.includes(MARK);
}

// Pure. Returns a NEW settings object with our entries taken out of every
// event, and any group or event left empty by that removed with them.
function without(settings) {
  const next = Object.assign({}, settings);
  const hooks = Object.assign({}, settings && settings.hooks);
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = hooks[event]
      .map((g) => (g && Array.isArray(g.hooks) ? Object.assign({}, g, { hooks: g.hooks.filter((h) => !isOurs(h)) }) : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (groups.length) hooks[event] = groups; else delete hooks[event];
  }
  if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
  return next;
}

// Pure. Returns a NEW settings object carrying exactly one of our entries on
// each event, after whatever was already there.
function withHooks(settings, command) {
  const next = without(settings || {});
  const hooks = Object.assign({}, next.hooks);
  for (const event of EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event].slice() : [];
    groups.push({ hooks: [{ type: "command", command, timeout: 5 }] });
    hooks[event] = groups;
  }
  next.hooks = hooks;
  return next;
}

function defaultFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, "settings.json");
}

function main(argv) {
  const write = argv.includes("--write");
  const remove = argv.includes("--remove");
  const at = argv.indexOf("--file");
  const file = at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]) : defaultFile();
  const command = hookCommand(path.join(__dirname, ".."));

  let before = {};
  if (fs.existsSync(file)) {
    try {
      before = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`${file} is not valid JSON, so nothing was changed: ${e.message}`);
      return 1;
    }
    if (!before || typeof before !== "object" || Array.isArray(before)) {
      console.error(`${file} does not hold a settings object, so nothing was changed`);
      return 1;
    }
  }
  const after = remove ? without(before) : withHooks(before, command);
  const same = JSON.stringify(before) === JSON.stringify(after);

  console.log(`settings file: ${file}`);
  if (remove) console.log("plan: remove the micr0pad session hooks");
  else console.log(`plan: run this on ${EVENTS.join(", ")}:\n  ${command}`);
  if (same) { console.log("already in that state: nothing to do"); return 0; }
  if (!write) { console.log("nothing written. Run again with --write to apply."); return 0; }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    const backup = `${file}.micr0pad-backup-${stamp}`;
    fs.copyFileSync(file, backup);
    console.log(`backup: ${backup}`);
  }
  fs.writeFileSync(file, JSON.stringify(after, null, 2) + "\n", "utf8");
  console.log("written. New Claude Code sessions pick it up when they start.");
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { EVENTS, hookCommand, isOurs, without, withHooks };
