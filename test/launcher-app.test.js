"use strict";
// The desktop launcher (launcher/launcher.js). What these hold:
//
//   - where the click lands is decided by the site's own feature list, and
//     anything short of "live" is the local app;
//   - the double-click runs its steps in order and opens exactly one page;
//   - it sends no light of its own;
//   - the shortcut icon is a real .ico, and the launcher stays out of the
//     npm package.
//
// No bridge is started and no browser is opened: every step is injected.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const launcher = require("../launcher/launcher");

const BRIDGE = "http://localhost:4120";

test("a live feature opens the hosted page, anything else the local app", () => {
  const live = { features: [{ id: "micr0pad", state: "live", href: "/tools/micr0pad/" }] };
  assert.deepEqual(launcher.pickDestination(live, BRIDGE), {
    kind: "hosted",
    url: "https://randomly.engineering/tools/micr0pad/",
  });
  const cases = [
    null,
    {},
    { features: [] },
    { features: [{ id: "micr0pad", state: "disabled", href: "/tools/micr0pad/" }] },
    { features: [{ id: "micr0pad", state: "disabled", staging: "live", href: "/tools/micr0pad/" }] },
    { features: [{ id: "other", state: "live", href: "/tools/other/" }] },
    // A list that names another site must not be followed off the hosted origin.
    { features: [{ id: "micr0pad", state: "live", href: "https://example.com/" }] },
    { features: [{ id: "micr0pad", state: "live" }] },
  ];
  for (const features of cases) {
    assert.deepEqual(launcher.pickDestination(features, BRIDGE), { kind: "local", url: BRIDGE });
  }
});

test("the hosted origin is one the bridge pairs with by default", () => {
  const { DEFAULT_HOSTED_ORIGINS } = require("../lib/pairing");
  assert.ok(DEFAULT_HOSTED_ORIGINS.includes(launcher.HOSTED_ORIGIN));
});

function fakes(over = {}) {
  const calls = [];
  const opened = [];
  return {
    calls,
    opened,
    deps: {
      ensureBridge: async () => { calls.push("bridge"); return { started: true, state: { device: { kind: "hid", model: "pad" } } }; },
      siteFeatures: async () => { calls.push("site"); return null; },
      openInBrowser: (url) => { calls.push("open"); opened.push(url); },
      ...over,
    },
  };
}

test("the double-click starts the bridge, then opens one page", async () => {
  const f = fakes();
  const out = await launcher.go(f.deps);
  assert.deepEqual(f.calls, ["bridge", "site", "open"]);
  assert.equal(f.opened.length, 1);
  assert.equal(out.bridge, "started");
  assert.equal(out.device, "hid");
  assert.equal(out.destination.kind, "local");
});

test("a live site sends the click to the hosted page", async () => {
  const f = fakes({ siteFeatures: async () => ({ features: [{ id: "micr0pad", state: "live", href: "/tools/micr0pad/" }] }) });
  await launcher.go(f.deps);
  assert.deepEqual(f.opened, ["https://randomly.engineering/tools/micr0pad/"]);
});

test("with no device at all the app still opens", async () => {
  const f = fakes({ ensureBridge: async () => ({ started: false, state: { device: { kind: "none", model: null } } }) });
  const out = await launcher.go(f.deps);
  assert.equal(out.device, "none");
  assert.equal(out.bridge, "already running");
  assert.equal(f.opened.length, 1);
});

test("the launcher sends no light: the family colors are the bridge's own", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "launcher", "launcher.js"), "utf8");
  assert.ok(!src.includes('"/api/light"') && !src.includes("/api/light`"), "no call to /api/light");
  assert.ok(!src.includes("pairing-token"), "no read of the local token");
});

test("a bridge that never answers opens nothing", async () => {
  const f = fakes({ ensureBridge: async () => { throw new Error("the bridge did not answer"); } });
  await assert.rejects(launcher.go(f.deps), /did not answer/);
  assert.equal(f.opened.length, 0);
});

test("the shortcut icon is an .ico with a 256 px image", () => {
  const ico = fs.readFileSync(path.join(__dirname, "..", "launcher", "micr0pad.ico"));
  assert.equal(ico.readUInt16LE(0), 0, "reserved");
  assert.equal(ico.readUInt16LE(2), 1, "type 1 is an icon");
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 1);
  // In a directory entry a width byte of 0 means 256.
  const widths = Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256);
  assert.ok(widths.includes(256), `sizes: ${widths.join(", ")}`);
  assert.ok(widths.includes(16), `sizes: ${widths.join(", ")}`);
});

test("the launcher is a checkout tool and stays out of the npm package", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts.launcher, "node launcher/launcher.js");
  assert.ok(!pkg.files.some((f) => f.startsWith("launcher")), "launcher/ is not in the files list");
});
