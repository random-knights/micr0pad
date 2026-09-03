"use strict";
// What these tests hold in place: this repo is safe to be public.
//
// They are cheap and blunt on purpose. Each one encodes a mistake that is
// easy to make in a hurry and expensive to make in a public repo: shipping a
// secret, shipping one machine's paths, or shipping an install that only
// works on the machine it was written on.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// The files git actually tracks. A file that is not tracked cannot be
// published, so it is not this test's business.
function trackedFiles() {
  const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  return out.split(/\r?\n/).filter(Boolean);
}

const TEXT_EXTENSIONS = new Set([
  ".js", ".json", ".md", ".txt", ".html", ".css", ".cmd", ".yml", ".yaml",
]);

test("no tracked file carries an absolute path from the author's machine", () => {
  const offenders = [];
  for (const file of trackedFiles()) {
    if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
    // This test file names the pattern it looks for, so skip itself.
    if (file === "test/public-safety.test.js") continue;
    const body = read(file);
    // Any Windows drive-letter path. A public repo should not know where a
    // particular person keeps their files.
    //
    // The drive letter has to be preceded by something that is not a letter,
    // or "see why:\n" in a source string reads as the drive "y:" followed by
    // an escape. That false positive is not hypothetical; it is why this
    // pattern is spelled out rather than being the obvious short version.
    const matches = [...body.matchAll(/(?:^|[^A-Za-z])([A-Za-z]:\\[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_.-]+)*)/g)]
      .map((m) => m[1]);
    // C:\path and C:\Users\you are teaching examples, not real locations.
    const real = matches.filter((m) => !/^[A-Za-z]:\\(path|Users\\you|full)\b/i.test(m));
    if (real.length) offenders.push(`${file}: ${real.join(", ")}`);
  }
  assert.deepEqual(offenders, [], `absolute local paths in tracked files:\n${offenders.join("\n")}`);
});

test("the checked-in config example carries no secret and no analytics", () => {
  const example = JSON.parse(read("config.example.json"));
  assert.equal("pairingToken" in example, false, "config.example.json must never carry a token");
  assert.equal(example.analytics.enabled, false, "analytics must ship off");
  // The action keys ship unconfigured: shipping one team's scripts gives
  // everyone else buttons that can only answer "cmd not found".
  for (const [key, action] of Object.entries(example.actions)) {
    assert.equal(action.type, "none", `action ${key} must ship unconfigured`);
    if ("cmd" in action) assert.equal(action.cmd, "", `action ${key} must ship with no command`);
  }
});

test("gitignore keeps the per-machine files out", () => {
  const ignored = read(".gitignore");
  for (const entry of ["config.json", "analytics-local.jsonl", "aieds-local.jsonl", "node_modules/"]) {
    assert.ok(ignored.includes(entry), `.gitignore must list ${entry}`);
  }
});

test("git tracks none of the per-machine files", () => {
  const tracked = new Set(trackedFiles());
  for (const file of ["config.json", "analytics-local.jsonl", "aieds-local.jsonl", "keymap-backup.json"]) {
    assert.equal(tracked.has(file), false, `${file} must not be committed`);
  }
});

test("package.json declares an install a stranger can run", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.prestart, "node scripts/preflight.js");
  assert.equal(pkg.scripts.start, "node server.js");
  assert.ok(pkg.engines && pkg.engines.node, "declare the Node floor");
  assert.ok(fs.existsSync(path.join(ROOT, pkg.bin.micr0pad)), "bin entry must exist");
});

test("every tracked JavaScript file parses", () => {
  for (const file of trackedFiles()) {
    if (path.extname(file) !== ".js") continue;
    execFileSync(process.execPath, ["--check", file], { cwd: ROOT });
  }
});

test("no em dashes or en dashes in tracked text (K13 gate)", () => {
  const offenders = [];
  for (const file of trackedFiles()) {
    if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
    if (file === "test/public-safety.test.js") continue;
    const body = read(file);
    if (body.includes("\u2014") || body.includes("\u2013")) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `dashes found in: ${offenders.join(", ")}`);
});
