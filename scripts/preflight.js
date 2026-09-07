"use strict";
// preflight.js - everything that has to be true before server.js can run,
// done for the user instead of asked of them.
//
// Why this exists: the install used to be four steps (clone, npm i, copy a
// config, start), and skipping any of them failed later and elsewhere.
// `npm start` now runs this first (the "prestart" script), so one command
// from a clean clone is the whole install.
//
// It does three things, each only when needed:
//   1. checks the Node version, and says the real number if it is too old;
//   2. installs dependencies if node_modules is not there yet;
//   3. copies config.example.json to config.json on first run.
//
// It never edits an existing config.json. That file is yours once it exists.
//
// Every step takes the app directory as an argument so the tests can run it
// against a scratch directory instead of this checkout.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const APP_DIR = path.join(__dirname, "..");
const MIN_NODE_MAJOR = 18;

function log(line) {
  console.log(`[preflight] ${line}`);
}

// Node 18 is the floor because the server uses fetch(), which landed there.
// Anything older fails deep inside a request with a confusing message, so
// fail here, with the version number, instead.
function checkNode(version = process.versions.node) {
  const major = Number(String(version).split(".")[0]);
  if (major >= MIN_NODE_MAJOR) return true;
  console.error(
    `[preflight] Node ${version} is too old. ` +
      `micr0pad needs Node ${MIN_NODE_MAJOR} or newer: https://nodejs.org`,
  );
  return false;
}

// npm, whichever npm is running us. When this is invoked as an npm script,
// npm_execpath points at npm's own cli.js, and running that with this Node
// binary is exact. Outside npm (a plain `node scripts/preflight.js`) fall
// back to the npm on PATH, which on Windows is npm.cmd and so needs a shell.
function runNpm(args, dir) {
  const execpath = process.env.npm_execpath;
  if (execpath && fs.existsSync(execpath)) {
    return spawnSync(process.execPath, [execpath, ...args], { cwd: dir, stdio: "inherit" });
  }
  return spawnSync("npm", args, { cwd: dir, stdio: "inherit", shell: true });
}

function installDependencies(dir = APP_DIR) {
  if (fs.existsSync(path.join(dir, "node_modules"))) return true;
  // node-hid is a native module. npm fetches a prebuilt binary for the common
  // platforms and falls back to compiling, which is why this can take a
  // minute and why its output is shown rather than hidden.
  const lockfile = fs.existsSync(path.join(dir, "package-lock.json"));
  log(`installing dependencies (${lockfile ? "npm ci" : "npm install"}), this can take a minute`);
  const result = runNpm(lockfile ? ["ci"] : ["install"], dir);
  if (result.status === 0) return true;
  console.error(
    "[preflight] dependency install failed. Run it yourself to see why:\n" +
      `           cd ${dir} && npm install`,
  );
  return false;
}

// First run gets a config.json copied from the checked-in example, so the pad
// works before anyone opens an editor. config.json is gitignored: it ends up
// holding your slot names, your action commands and the pairing token, none
// of which belongs in a public repo.
function ensureConfig(dir = APP_DIR) {
  const configPath = path.join(dir, "config.json");
  const examplePath = path.join(dir, "config.example.json");
  if (fs.existsSync(configPath)) return true;
  if (!fs.existsSync(examplePath)) {
    // Not an error. lib/config.js carries the same defaults in code and
    // writes the file itself on first load.
    log("no config.example.json to copy, so the built-in defaults will be used");
    return true;
  }
  fs.copyFileSync(examplePath, configPath);
  log("created config.json from config.example.json");
  return true;
}

function main(dir = APP_DIR) {
  const ok = checkNode() && installDependencies(dir) && ensureConfig(dir);
  if (!ok) process.exit(1);
}

if (require.main === module) main();

module.exports = { checkNode, installDependencies, ensureConfig, main, APP_DIR, MIN_NODE_MAJOR };
