"use strict";
// What these tests hold in place: the files that belong to the person (the
// config with the pairing token, the keymap backup, the logs) live in one
// per-user directory that survives an npx upgrade, a checkout's old copies
// are moved across exactly once, and nothing here ever overwrites or deletes
// a file that is already there.
//
// Every platform's answer is checked from every platform: dataDir() takes
// the platform, the environment and the home directory as arguments.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const paths = require("../lib/paths");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "micr0pad-paths-"));
}

const HOME = path.join(path.sep, "home", "someone");

test("Windows: %APPDATA%\\micr0pad", () => {
  const appData = path.join(HOME, "AppData", "Roaming");
  assert.equal(
    paths.dataDir({ platform: "win32", env: { APPDATA: appData }, home: HOME }),
    path.join(appData, "micr0pad"),
  );
});

test("Windows without APPDATA falls back to the roaming folder under home", () => {
  assert.equal(
    paths.dataDir({ platform: "win32", env: {}, home: HOME }),
    path.join(HOME, "AppData", "Roaming", "micr0pad"),
  );
});

test("macOS: ~/Library/Application Support/micr0pad", () => {
  assert.equal(
    paths.dataDir({ platform: "darwin", env: { XDG_CONFIG_HOME: "/ignored" }, home: HOME }),
    path.join(HOME, "Library", "Application Support", "micr0pad"),
  );
});

test("Linux: $XDG_CONFIG_HOME/micr0pad, else ~/.config/micr0pad", () => {
  const xdg = path.resolve(HOME, "xdg");
  assert.equal(
    paths.dataDir({ platform: "linux", env: { XDG_CONFIG_HOME: xdg }, home: HOME }),
    path.join(xdg, "micr0pad"),
  );
  assert.equal(
    paths.dataDir({ platform: "linux", env: {}, home: HOME }),
    path.join(HOME, ".config", "micr0pad"),
  );
  // The XDG spec says a relative value is invalid and must be ignored.
  assert.equal(
    paths.dataDir({ platform: "linux", env: { XDG_CONFIG_HOME: "relative/dir" }, home: HOME }),
    path.join(HOME, ".config", "micr0pad"),
  );
  assert.equal(
    paths.dataDir({ platform: "freebsd", env: {}, home: HOME }),
    path.join(HOME, ".config", "micr0pad"),
    "any other Unix follows the XDG rule",
  );
});

test("RK_MICROPAD_DATA_DIR overrides every platform", () => {
  const dir = scratch();
  for (const platform of ["win32", "darwin", "linux"]) {
    assert.equal(paths.dataDir({ platform, env: { RK_MICROPAD_DATA_DIR: dir, APPDATA: "x" }, home: HOME }), dir);
  }
});

test("migrateOnce copies a checkout's file across once and leaves the original", () => {
  const app = scratch();
  const data = path.join(scratch(), "micr0pad");
  fs.writeFileSync(path.join(app, "config.json"), '{"old":true}');
  const logged = [];
  assert.equal(paths.migrateOnce("config.json", { fromDir: app, toDir: data, log: (l) => logged.push(l) }), true);
  assert.equal(fs.readFileSync(path.join(data, "config.json"), "utf8"), '{"old":true}');
  assert.equal(fs.existsSync(path.join(app, "config.json")), true, "the old copy is never deleted");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].includes("old"), false, "the log line names the file, never its contents");

  // Second time: nothing to do, and the per-user copy is not touched even
  // though the old one has changed since.
  fs.writeFileSync(path.join(app, "config.json"), '{"old":"edited later"}');
  assert.equal(paths.migrateOnce("config.json", { fromDir: app, toDir: data, log: null }), false);
  assert.equal(fs.readFileSync(path.join(data, "config.json"), "utf8"), '{"old":true}');
});

test("migrateOnce never overwrites a per-user file that already exists", () => {
  const app = scratch();
  const data = scratch();
  fs.writeFileSync(path.join(app, "keymap-backup.json"), "checkout copy");
  fs.writeFileSync(path.join(data, "keymap-backup.json"), "stock keymap");
  assert.equal(paths.migrateOnce("keymap-backup.json", { fromDir: app, toDir: data, log: null }), false);
  assert.equal(fs.readFileSync(path.join(data, "keymap-backup.json"), "utf8"), "stock keymap");
});

test("migrateOnce with nothing to move does nothing and creates nothing", () => {
  const app = scratch();
  const data = path.join(scratch(), "not-yet");
  assert.equal(paths.migrateOnce("config.json", { fromDir: app, toDir: data, log: null }), false);
  assert.equal(fs.existsSync(data), false);
});

test("keymapBackupPath moves a checkout's backup into the per-user directory", () => {
  const app = scratch();
  const data = scratch();
  fs.writeFileSync(path.join(app, "keymap-backup.json"), '{"data":"stock"}');
  const file = paths.keymapBackupPath({ fromDir: app, toDir: data, log: null });
  assert.equal(file, path.join(data, "keymap-backup.json"));
  assert.equal(fs.readFileSync(file, "utf8"), '{"data":"stock"}');
});

test("writePrivate creates the directory and, where the OS has modes, owner-only files", () => {
  const dir = path.join(scratch(), "a", "b");
  const file = path.join(dir, "config.json");
  paths.writePrivate(file, "{}");
  assert.equal(fs.readFileSync(file, "utf8"), "{}");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "config.json holds the pairing token");
    // A file created loose before this rule existed is tightened on write.
    fs.chmodSync(file, 0o644);
    paths.writePrivate(file, "{}");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});
