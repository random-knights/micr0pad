"use strict";
// What these tests hold in place: the tarball rules in scripts/check-pack.js.
// A required file that goes missing, a file that must never ship, and a file
// git does not track all fail the check. npm itself is not run here; CI runs
// the real `npm run check-pack` against the real tarball.

const test = require("node:test");
const assert = require("node:assert");
const { REQUIRED, problemsFor } = require("../scripts/check-pack");

test("the required list alone passes", () => {
  assert.deepEqual(problemsFor([...REQUIRED], new Set(REQUIRED)), []);
});

test("a missing required file fails", () => {
  const files = REQUIRED.filter((f) => f !== "LICENSE");
  assert.deepEqual(problemsFor(files, new Set(files)), ["missing: LICENSE"]);
});

test("files that must never ship fail", () => {
  for (const bad of ["config.json", "test/pad.test.js", "lib/fixtures/a.json", "watch.log",
    "aieds-local.jsonl", "keymap-backup.json", ".env", "lib/.env.local", "id.pem", ".npmrc",
    "AGENTS.md", ".github/workflows/x.yml"]) {
    const files = [...REQUIRED, bad];
    const problems = problemsFor(files, new Set(files));
    assert.equal(problems.length, 1, `${bad} should fail once, got ${problems.join("; ")}`);
    assert.match(problems[0], /^must not ship: /);
  }
});

test("config.example.json ships and an untracked file does not", () => {
  const files = [...REQUIRED, "stray.js"];
  assert.deepEqual(problemsFor(files, new Set(REQUIRED)), ["not tracked by git: stray.js"]);
});
