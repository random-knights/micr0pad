"use strict";
// What these tests hold in place: the resolution order for where action-key
// .cmd files live (MICROPAD_CMD_DIR, then config.json cmdDir, then <app>/cmd,
// then sibling _macropad folders), that an absolute path in config wins
// outright, and that resolveCmd only ever returns a path that actually
// exists - never a guess. Everything here is real fs against temp
// directories; launcher.js itself never launches anything (the execFile call
// lives in lib/bridge.js, out of this lane's paths), so "without launching"
// just means: prove what WOULD be run, not run it.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const launcher = require("../lib/launcher");

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `micr0pad-launcher-${name}-`));
  return dir;
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test("candidates order: MICROPAD_CMD_DIR first, then cfg.cmdDir, then <app>/cmd, then sibling _macropad folders", () => {
  const list = withEnv({ MICROPAD_CMD_DIR: "C:\\explicit" }, () => launcher.describe({ cmdDir: "custom" }));
  assert.equal(list[0].dir, path.resolve("C:\\explicit"));
  assert.equal(list[1].dir, path.resolve(launcher.APP_DIR, "custom"));
  assert.equal(list[2].dir, path.join(launcher.APP_DIR, "cmd"));
  assert.ok(list[3].dir.endsWith("_macropad"));
});

test("cmdDir returns null when nothing in the search order exists", () => {
  withEnv({ MICROPAD_CMD_DIR: undefined }, () => {
    delete process.env.MICROPAD_CMD_DIR;
    const dir = launcher.cmdDir({ cmdDir: "definitely-not-here-" + Date.now() });
    // <app>/cmd may exist in a real checkout; only assert the search does not
    // crash and returns either null or a directory that truly exists.
    if (dir !== null) assert.ok(fs.statSync(dir).isDirectory());
  });
});

test("cmdDir finds a directory placed via MICROPAD_CMD_DIR", () => {
  const dir = tmpDir("cmddir");
  try {
    withEnv({ MICROPAD_CMD_DIR: dir }, () => {
      assert.equal(launcher.cmdDir({}), dir);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("resolveCmd finds a file inside MICROPAD_CMD_DIR, without launching it", () => {
  const dir = tmpDir("resolve");
  const cmdFile = path.join(dir, "deploy.cmd");
  fs.writeFileSync(cmdFile, "@echo off\r\necho would deploy\r\n");
  try {
    withEnv({ MICROPAD_CMD_DIR: dir }, () => {
      assert.equal(launcher.resolveCmd("deploy.cmd", {}), cmdFile);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("resolveCmd returns null for a name that exists nowhere in the search order", () => {
  const dir = tmpDir("missing");
  try {
    withEnv({ MICROPAD_CMD_DIR: dir }, () => {
      assert.equal(launcher.resolveCmd("nope-" + Date.now() + ".cmd", {}), null);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("resolveCmd honors cfg.cmdDir relative to APP_DIR", () => {
  const dir = fs.mkdtempSync(path.join(launcher.APP_DIR, "tmp-launcher-test-"));
  const rel = path.relative(launcher.APP_DIR, dir);
  const cmdFile = path.join(dir, "build.cmd");
  fs.writeFileSync(cmdFile, "@echo off\r\n");
  try {
    withEnv({ MICROPAD_CMD_DIR: undefined }, () => {
      delete process.env.MICROPAD_CMD_DIR;
      assert.equal(launcher.resolveCmd("build.cmd", { cmdDir: rel }), cmdFile);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("resolveCmd: an absolute path in config wins outright when it exists", () => {
  const dir = tmpDir("abs");
  const cmdFile = path.join(dir, "abs.cmd");
  fs.writeFileSync(cmdFile, "@echo off\r\n");
  try {
    assert.equal(launcher.resolveCmd(cmdFile, {}), cmdFile);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("resolveCmd: an absolute path that does not exist falls through to the normal search, not a guessed path", () => {
  withEnv({ MICROPAD_CMD_DIR: undefined }, () => {
    delete process.env.MICROPAD_CMD_DIR;
    const ghost = path.join(os.tmpdir(), "definitely-does-not-exist-" + Date.now() + ".cmd");
    assert.equal(launcher.resolveCmd(ghost, {}), null);
  });
});

test("resolveCmd returns null for a falsy name", () => {
  assert.equal(launcher.resolveCmd(null, {}), null);
  assert.equal(launcher.resolveCmd("", {}), null);
});

test("describe reports exists:true only for directories that are really there", () => {
  const dir = tmpDir("describe");
  try {
    withEnv({ MICROPAD_CMD_DIR: dir }, () => {
      const list = launcher.describe({});
      assert.equal(list[0].dir, dir);
      assert.equal(list[0].exists, true);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- Fail-first target: the resolution order itself, caught by name. ---
test("MICROPAD_CMD_DIR beats cfg.cmdDir when both would resolve the same name", () => {
  // If the search order in lib/launcher.js's candidates() were ever
  // reordered (cfg.cmdDir checked before the env var), this is the
  // assertion that catches it: the same file name exists in both
  // directories, and the env-var copy must win.
  const envDir = tmpDir("order-env");
  const cfgDir = tmpDir("order-cfg");
  fs.writeFileSync(path.join(envDir, "same.cmd"), "@echo off\r\necho env\r\n");
  fs.writeFileSync(path.join(cfgDir, "same.cmd"), "@echo off\r\necho cfg\r\n");
  try {
    withEnv({ MICROPAD_CMD_DIR: envDir }, () => {
      const resolved = launcher.resolveCmd("same.cmd", { cmdDir: path.relative(launcher.APP_DIR, cfgDir) });
      assert.equal(resolved, path.join(envDir, "same.cmd"));
    });
  } finally {
    fs.rmSync(envDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});
