"use strict";
// check-pack.js - what the npm tarball would contain, checked before anyone
// publishes it.
//
// A package is public the moment it is published, and an unpublish does not
// take back what was downloaded. So the list is checked, not trusted:
//
//   1. every file the tarball needs is in it (the bin, the server, the page,
//      the license and notice);
//   2. nothing that must never ship is in it (tests, fixtures, a local
//      config.json with a pairing token, logs, keymap backups, .env files,
//      keys, agent notes, CI files);
//   3. every file in it is tracked by git, so an untracked file sitting in
//      the publisher's checkout cannot ride along.
//
// It runs in CI on every change and as `prepublishOnly`, so a manual
// `npm publish` runs it too. It reads the file list from `npm pack --dry-run
// --json`, which is the same list `npm publish` uses, and writes nothing.

const path = require("path");
const fs = require("fs");
const { spawnSync, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "bin/micr0pad.js",
  "server.js",
  "config.example.json",
  "scripts/preflight.js",
  "lib/config.js",
  "lib/wldevice.js",
  "lib/virtualdevice.js",
  "public/index.html",
  "public/app.js",
];

// Each entry is [pattern, why].
const FORBIDDEN = [
  [/^test\//, "tests"],
  [/fixtures?\//, "test fixtures"],
  [/(^|\/)config\.json$/, "a local config.json (it holds the pairing token)"],
  [/\.log$/, "a log file"],
  [/\.jsonl$/, "a local log (AiEDs or analytics)"],
  [/keymap-backup/, "a device keymap backup"],
  [/(^|\/)\.env/, "an env file"],
  [/\.(pem|key|p12|pfx|crt)$/, "a key or certificate"],
  [/(^|\/)\.npmrc$/, "an npmrc (it can hold a registry token)"],
  [/(^|\/)node_modules\//, "installed dependencies"],
  [/^\.github\//, "CI configuration"],
  [/^\.claude\//, "agent configuration"],
  [/(^|\/)(AGENTS|CLAUDE)\.md$/, "agent notes"],
  [/\.tmp$/, "a scratch file"],
];

function npm(args) {
  const execpath = process.env.npm_execpath;
  if (execpath && fs.existsSync(execpath) && /npm-cli\.js$/.test(execpath)) {
    return spawnSync(process.execPath, [execpath, ...args], { cwd: ROOT, encoding: "utf8" });
  }
  return spawnSync("npm", args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
}

function packedFiles() {
  const result = npm(["pack", "--dry-run", "--json", "--ignore-scripts"]);
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed (${result.status}):\n${result.stderr}`);
  }
  // npm prints the JSON array on stdout; anything before the first "[" is a
  // lifecycle banner, not data.
  const out = result.stdout.slice(result.stdout.indexOf("["));
  const [info] = JSON.parse(out);
  return { name: info.name, version: info.version, files: info.files.map((f) => f.path.replace(/\\/g, "/")).sort() };
}

function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
    return new Set(out.split("\n").filter(Boolean));
  } catch (_) {
    return null;
  }
}

// Pure: returns the list of problems for a given tarball list. Exported so
// the test can hold the rules without running npm.
function problemsFor(files, tracked) {
  const problems = [];
  for (const need of REQUIRED) {
    if (!files.includes(need)) problems.push(`missing: ${need}`);
  }
  for (const file of files) {
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(file)) problems.push(`must not ship: ${file} (${why})`);
    }
    if (tracked && !tracked.has(file)) problems.push(`not tracked by git: ${file}`);
  }
  return problems;
}

function main() {
  const { name, version, files } = packedFiles();
  const tracked = trackedFiles();
  console.log(`${name}@${version}: ${files.length} files in the tarball`);
  for (const file of files) console.log(`  ${file}`);
  if (!tracked) console.log("git is not available here, so the tracked-file check was skipped");
  const problems = problemsFor(files, tracked);
  if (problems.length) {
    console.error(`\ntarball check FAILED:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("tarball check passed");
}

if (require.main === module) main();

module.exports = { REQUIRED, FORBIDDEN, problemsFor };
