"use strict";
// What these tests hold in place: the first run creates a config, and a
// second run never touches the one you have edited.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const preflight = require("../scripts/preflight");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "micr0pad-preflight-"));
}

test("first run copies config.example.json to config.json", () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, "config.example.json"), '{"pollIntervalMs":2500}', "utf8");

  assert.equal(preflight.ensureConfig(dir), true);
  assert.equal(
    fs.readFileSync(path.join(dir, "config.json"), "utf8"),
    '{"pollIntervalMs":2500}',
  );
});

test("a second run leaves an edited config alone", () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, "config.example.json"), '{"pollIntervalMs":2500}', "utf8");
  fs.writeFileSync(path.join(dir, "config.json"), '{"pollIntervalMs":9999}', "utf8");

  preflight.ensureConfig(dir);
  assert.equal(
    fs.readFileSync(path.join(dir, "config.json"), "utf8"),
    '{"pollIntervalMs":9999}',
  );
});

test("no example file is not a failure", () => {
  const dir = scratch();
  assert.equal(preflight.ensureConfig(dir), true);
  assert.equal(fs.existsSync(path.join(dir, "config.json")), false);
});

test("the Node floor is checked by major version", () => {
  assert.equal(preflight.checkNode("16.20.2"), false);
  assert.equal(preflight.checkNode("18.0.0"), true);
  assert.equal(preflight.checkNode("24.4.1"), true);
  assert.equal(preflight.checkNode(process.versions.node), true);
});

test("installDependencies does nothing when node_modules is already there", () => {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, "node_modules"));
  // No package.json in this directory, so if it shelled out to npm at all
  // the call would fail and this would return false.
  assert.equal(preflight.installDependencies(dir), true);
});

test("an installed package never runs npm inside node_modules", () => {
  const dir = path.join(scratch(), "node_modules", "@randomknights", "micr0pad");
  fs.mkdirSync(dir, { recursive: true });
  // Same trap as above: an npm call here, with no package.json, would fail.
  assert.equal(preflight.isInstalledPackage(dir), true);
  assert.equal(preflight.installDependencies(dir), true);
  assert.equal(fs.existsSync(path.join(dir, "node_modules")), false);
  assert.equal(preflight.isInstalledPackage(scratch()), false);
});
