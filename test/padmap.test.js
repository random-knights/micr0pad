"use strict";
// padmap.test.js - lib/padmap.json is the key map, and this is what keeps it
// honest.
//
// Two different failures are guarded here, and they are not the same failure:
//
//   1. DRIFT INSIDE THIS REPO. lib/pad.js and public/app.js are what the local
//      app actually draws. If somebody moves a key, renames a slot or changes a
//      status color there and does not carry it into padmap.json, the hosted
//      pad and the local pad stop being the same pad. These tests read the real
//      modules, not a copy of them.
//
//   2. DRIFT INTO THE HOSTED APP. The hosted 1aunchpad renders its virtual pad
//      from a vendored copy of this file at
//      assets/launchpad/micr0pad_keymap.json in its own repository, which
//      cannot reach this one from CI. So the sha256 below is pinned at both
//      ends. Editing padmap.json fails this test until the
//      digest is updated, and the message says what else to update. That is the
//      whole drift check: it cannot stop somebody skipping it, but it cannot be
//      skipped by accident.
//
// The digest is over the file with CRLF normalized to LF, so a Windows
// checkout and a Linux checkout agree.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const pad = require("../lib/pad");

const PADMAP_PATH = path.join(__dirname, "..", "lib", "padmap.json");
const APP_JS_PATH = path.join(__dirname, "..", "public", "app.js");

// Keep this in step with test/launchpad/pad_keymap_test.dart in the hosted app.
const PADMAP_SHA256 =
  "c96639c2aa106b23127a4718b19252b4d96e3412b6e6806a5ad09ed3424fd7bd";

function readNormalized(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

const raw = readNormalized(PADMAP_PATH);
const map = JSON.parse(raw);

test("padmap.json digest is pinned, and the hosted app holds the same copy", () => {
  const digest = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  assert.strictEqual(
    digest,
    PADMAP_SHA256,
    "lib/padmap.json changed. Copy it to assets/launchpad/micr0pad_keymap.json in " +
      "the hosted app, then put the new digest in BOTH this file and its " +
      "test/launchpad/pad_keymap_test.dart. New digest: " + digest,
  );
});

test("padmap.json draws the same rows lib/pad.js does", () => {
  assert.deepStrictEqual(map.displayRows, pad.displayRows);
  assert.deepStrictEqual(map.agentKeyIDs, pad.agentKeyIDs);
  assert.deepStrictEqual(map.actionKeyIDs, pad.actionKeyIDs);
});

test("padmap.json slots match the default slots, key ids included", () => {
  assert.strictEqual(map.slots.length, pad.defaultSlots.length);
  map.slots.forEach((slot, i) => {
    const real = pad.defaultSlots[i];
    assert.strictEqual(slot.slot, real.slot);
    assert.strictEqual(slot.name, real.name);
    assert.strictEqual(slot.color, real.color);
    // slot N lights firmware key agentKeyIDs[N] - the same lookup /api/state
    // makes when it reports keyID.
    assert.strictEqual(slot.keyID, pad.agentKeyIDs[real.slot]);
  });
});

test("padmap.json status colors match the canon colors pad.js packs", () => {
  for (const [name, entry] of Object.entries(map.statusColors)) {
    const real = pad.statusColors[name];
    assert.ok(real, `pad.js has no status named ${name}`);
    assert.strictEqual(pad.packedRGB(entry.color), real.color);
    assert.strictEqual(entry.label, real.label);
  }
  assert.deepStrictEqual(
    Object.keys(map.statusColors).sort(),
    Object.keys(pad.statusColors).sort(),
  );
});

test("padmap.json key names match KEY_NAMES in public/app.js", () => {
  // The local page's labels live in a plain object literal in app.js, which is
  // browser JS and cannot be required. Reading the literal out of the source is
  // the honest way to compare them: if the shape ever changes this fails with a
  // message saying so, rather than silently passing on nothing.
  const source = readNormalized(APP_JS_PATH);
  const match = source.match(/const KEY_NAMES = \{([\s\S]*?)\};/);
  assert.ok(match, "could not find the KEY_NAMES literal in public/app.js");
  const names = {};
  for (const pair of match[1].matchAll(/(\d+)\s*:\s*"([^"]*)"/g)) {
    names[pair[1]] = pair[2];
  }
  assert.ok(Object.keys(names).length > 0, "KEY_NAMES parsed empty");
  assert.deepStrictEqual(map.keyNames, names);
});

test("every drawn key has a name, and every knob key is outside the grid", () => {
  const drawn = map.displayRows.flat();
  for (const id of drawn) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(map.keyNames, String(id)),
      `drawn key ${id} has no name`,
    );
  }
  const knobKeys = map.knobs.flatMap((k) => k.keys);
  for (const id of knobKeys) {
    assert.ok(!drawn.includes(id), `knob key ${id} is also drawn in the grid`);
  }
});
