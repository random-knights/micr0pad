#!/usr/bin/env node
"use strict";
// session-hooks.js - add (or remove) the hooks that report an agent session's
// state to the local bridge (hooks/session-report.js).
//
//   npm run session-hooks                          Claude Code: show the plan
//   npm run session-hooks -- --write               back the file up, then write
//   npm run session-hooks -- --remove --write
//   npm run session-hooks -- --provider codex      the same, for Codex
//   npm run session-hooks -- --file <path>         another hooks file
//
// It edits one file per provider and only the "hooks" key in it:
//
//   claude   settings.json under CLAUDE_CONFIG_DIR, else under .claude in home
//   codex    hooks.json under CODEX_HOME, else under .codex in home
//
// Every other key is written back as it was read. Hooks that are already
// there are kept: an entry is ours only if its command names
// session-report.js with that provider, and those are the only entries this
// ever adds, replaces or removes. Without --write it prints the plan and
// stops, the same habit as add-layers.js: a settings file is not something to
// change on a first run.
//
// Codex will not run a hook until you have reviewed and trusted it: open
// /hooks in the Codex CLI, or Settings > Hooks in the Codex app, after this.
const fs = require("fs");
const os = require("os");
const path = require("path");

const MARK = "session-report.js";

// Per provider: where its hooks live, which events hooks/session-report.js
// maps to a state (see the tables in that file), and what a handler looks
// like. Each event is a moment the session's state can change.
const PROVIDERS = {
  claude: {
    label: "Claude Code",
    file: () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json"),
    events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"],
    handler: (command) => ({ type: "command", command, timeout: 5 }),
    after: "New Claude Code sessions pick it up when they start.",
  },
  codex: {
    label: "Codex",
    file: () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json"),
    events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt", "SessionEnd"],
    // async: the report never decides anything, so Codex does not wait for
    // it. SessionEnd and Interrupt always get at most three seconds from
    // Codex, and SessionEnd always runs in the foreground whatever this says.
    handler: (command, event) => ({
      type: "command",
      command,
      async: true,
      timeout: event === "SessionEnd" || event === "Interrupt" ? 3 : 5,
    }),
    after: "Codex skips a new hook until you trust it: open /hooks in the Codex CLI, or Settings > Hooks in the Codex app.",
  },
};

// Kept for callers of the first version: the Claude Code event list.
const EVENTS = PROVIDERS.claude.events;

function hookCommand(appDir, provider = "claude") {
  // Forward slashes and double quotes read the same in every shell a hook is
  // run from on Windows, macOS and Linux.
  const script = path.join(appDir, "hooks", MARK).replace(/\\/g, "/");
  return `node "${script}" ${provider}`;
}

// Ours, and for this provider: the command names the script and ends with
// the provider word. With no provider given, any entry that names the script.
function isOurs(hook, provider) {
  if (!hook || typeof hook.command !== "string" || !hook.command.includes(MARK)) return false;
  return provider ? hook.command.trim().endsWith(" " + provider) : true;
}

// Pure. Returns a NEW settings object with our entries taken out of every
// event, and any group or event left empty by that removed with them.
function without(settings, provider) {
  const next = Object.assign({}, settings);
  const hooks = Object.assign({}, settings && settings.hooks);
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = hooks[event]
      .map((g) => (g && Array.isArray(g.hooks) ? Object.assign({}, g, { hooks: g.hooks.filter((h) => !isOurs(h, provider)) }) : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (groups.length) hooks[event] = groups; else delete hooks[event];
  }
  if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
  return next;
}

// Pure. Returns a NEW settings object carrying exactly one of our entries on
// each of the provider's events, after whatever was already there.
function withHooks(settings, command, provider = "claude") {
  const spec = PROVIDERS[provider];
  const next = without(settings || {}, provider);
  const hooks = Object.assign({}, next.hooks);
  for (const event of spec.events) {
    const groups = Array.isArray(hooks[event]) ? hooks[event].slice() : [];
    groups.push({ hooks: [spec.handler(command, event)] });
    hooks[event] = groups;
  }
  next.hooks = hooks;
  return next;
}

function main(argv) {
  const write = argv.includes("--write");
  const remove = argv.includes("--remove");
  const pAt = argv.indexOf("--provider");
  const provider = pAt >= 0 && argv[pAt + 1] ? String(argv[pAt + 1]).toLowerCase() : "claude";
  const spec = PROVIDERS[provider];
  if (!spec) {
    console.error(`unknown provider "${provider}". Known: ${Object.keys(PROVIDERS).join(", ")}`);
    return 1;
  }
  const at = argv.indexOf("--file");
  const file = at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]) : spec.file();
  const command = hookCommand(path.join(__dirname, ".."), provider);

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
  const after = remove ? without(before, provider) : withHooks(before, command, provider);
  const same = JSON.stringify(before) === JSON.stringify(after);

  console.log(`${spec.label} hooks file: ${file}`);
  if (remove) console.log("plan: remove the micr0pad session hooks");
  else console.log(`plan: run this on ${spec.events.join(", ")}:\n  ${command}`);
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
  console.log("written.");
  if (!remove) console.log(spec.after);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { EVENTS, PROVIDERS, hookCommand, isOurs, without, withHooks };
