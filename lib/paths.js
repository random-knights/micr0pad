"use strict";
// paths.js - where micr0pad keeps the files that belong to the person
// running it, rather than to the copy of the app they happen to be running.
//
// Why this exists: with npx, the app directory is a folder inside npm's
// cache, and every new version lands in a new folder. Anything written beside
// the app (config.json with the slot names, the action commands and the
// pairing token, the device keymap backup, the logs) would silently reset on
// each upgrade. So those files live in one per-user directory instead:
//
//   Windows  %APPDATA%\micr0pad
//   macOS    ~/Library/Application Support/micr0pad
//   Linux    $XDG_CONFIG_HOME/micr0pad, or ~/.config/micr0pad
//
// RK_MICROPAD_DATA_DIR moves the whole directory (a test, or someone who
// wants it elsewhere); RK_MICROPAD_CONFIG still moves config.json alone.
//
// A checkout that ran before this change kept those files beside the app.
// migrateOnce() copies such a file into the per-user directory the first
// time it is needed and never again: it never overwrites a file that is
// already there, and it leaves the old copy where it was (a keymap backup is
// the only way back to stock, so nothing here deletes one).

const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const DIR_NAME = "micr0pad";

// Every argument is injectable so the tests can check each platform's answer
// from any platform.
function dataDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.RK_MICROPAD_DATA_DIR) return path.resolve(env.RK_MICROPAD_DATA_DIR);
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, DIR_NAME);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", DIR_NAME);
  }
  // The XDG spec says a relative XDG_CONFIG_HOME is invalid and is ignored.
  const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : path.join(home, ".config");
  return path.join(xdg, DIR_NAME);
}

// The directory is created readable by its owner only where the OS has POSIX
// modes. On Windows the mode is ignored and %APPDATA% is already private to
// the user by its default ACL.
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Write a file that may hold a secret (config.json holds the pairing token):
// mode 0600 on create, and chmod on every write so a file created before this
// rule existed is tightened too. chmod is a no-op for this purpose on Windows.
function writePrivate(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
}

// Copy <fromDir>/<name> to <toDir>/<name> once. Returns true only when it
// copied. Never overwrites, never deletes the source.
function migrateOnce(name, { fromDir = APP_DIR, toDir = dataDir(), log = console.log } = {}) {
  const from = path.join(fromDir, name);
  const to = path.join(toDir, name);
  if (path.resolve(from) === path.resolve(to)) return false;
  if (fs.existsSync(to) || !fs.existsSync(from)) return false;
  ensureDir(toDir);
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(to, 0o600); } catch (_) { /* best effort */ }
  if (log) log(`copied ${name} to ${toDir} (the copy beside the app is no longer read)`);
  return true;
}

// The keymap backup the pad's revert and the flashing scripts depend on.
function keymapBackupPath(opts = {}) {
  const dir = opts.toDir || dataDir();
  migrateOnce("keymap-backup.json", Object.assign({}, opts, { toDir: dir }));
  return path.join(dir, "keymap-backup.json");
}

module.exports = { APP_DIR, DIR_NAME, dataDir, ensureDir, writePrivate, migrateOnce, keymapBackupPath };
