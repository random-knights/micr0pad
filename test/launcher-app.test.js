"use strict";
// The desktop launcher (launcher/launcher.js). What these hold:
//
//   - where one click lands is decided by the site's own feature list, and
//     anything short of "live" is the local app;
//   - the hello uses the family colors and only the six status keys;
//   - the window server presses nothing for a stranger: the start route needs
//     the per-run path segment, another origin is refused, and no response
//     carries Access-Control-Allow-Origin.
//
// No bridge is started and no browser is opened: the click is injected.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const launcher = require("../launcher/launcher");
const pad = require("../lib/pad");

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

test("the hello paints the six status keys in the family colors", () => {
  assert.deepEqual(launcher.FAMILY, { app: "#ff4124", org: "#f45d43", llc: "#e97862", xyz: "#faafa5" });
  assert.deepEqual(launcher.HELLO_KEYS.map((k) => k.keyID), pad.agentKeyIDs);
  const family = new Set(Object.values(launcher.FAMILY));
  for (const { color } of launcher.HELLO_KEYS) assert.ok(family.has(color), `${color} is a family color`);
  assert.equal(launcher.packed("#ff4124"), 0xff4124);
  assert.equal(launcher.packed("#ff4124"), pad.packedRGB("#ff4124"));
});

test("the app-window browser is found from the environment, or not at all", () => {
  const env = { ProgramFiles: "P", "ProgramFiles(x86)": "X", LOCALAPPDATA: "L" };
  const edge = path.join("X", "Microsoft", "Edge", "Application", "msedge.exe");
  const chrome = path.join("P", "Google", "Chrome", "Application", "chrome.exe");
  assert.equal(launcher.findAppBrowser(env, (p) => p === edge || p === chrome, "win32"), edge);
  assert.equal(launcher.findAppBrowser(env, (p) => p === chrome, "win32"), chrome);
  assert.equal(launcher.findAppBrowser(env, () => false, "win32"), null);
  assert.equal(launcher.findAppBrowser(env, () => true, "linux"), null);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("the window server starts only for its own page", async (t) => {
  let runs = 0;
  const { server, nonce } = launcher.createServer({
    nonce: "a".repeat(32),
    run: async () => { runs += 1; return { ok: true }; },
  });
  const port = await listen(server);
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${port}`;

  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  const html = await page.text();
  assert.ok(html.includes(`/${nonce}`), "the page is handed the per-run segment");
  assert.ok(!html.includes("__NONCE__"), "no placeholder is left in the page");
  assert.match(html, /<title>0P \| Micr0Pad<\/title>/);

  const art = await fetch(base + "/pad.webp");
  assert.equal(art.status, 200);
  assert.equal(art.headers.get("content-type"), "image/webp");
  await art.arrayBuffer();

  // Without the segment there is no start route at all.
  assert.equal((await fetch(base + "/go", { method: "POST" })).status, 404);
  assert.equal((await fetch(base + "/wrong/go", { method: "POST" })).status, 404);
  // With it, but from another origin: refused before anything runs.
  const cross = await fetch(`${base}/${nonce}/go`, { method: "POST", headers: { Origin: "https://example.com" } });
  assert.equal(cross.status, 403);
  assert.equal(cross.headers.get("access-control-allow-origin"), null);
  assert.equal(runs, 0);

  const own = await fetch(`${base}/${nonce}/go`, { method: "POST", headers: { Origin: base } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await own.json(), { ok: true });
  assert.equal(runs, 1);
});

test("a failed start is reported, not swallowed", async (t) => {
  const { server, nonce } = launcher.createServer({
    nonce: "b".repeat(32),
    run: async () => { throw new Error("the bridge did not answer"); },
  });
  const port = await listen(server);
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const res = await fetch(`http://127.0.0.1:${port}/${nonce}/go`, { method: "POST" });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: "the bridge did not answer" });
});

test("the pad drawing is an animated webp that loops forever", () => {
  const art = fs.readFileSync(path.join(__dirname, "..", "launcher", "pad.webp"));
  assert.equal(art.subarray(0, 4).toString("latin1"), "RIFF");
  assert.equal(art.subarray(8, 12).toString("latin1"), "WEBP");
  const anim = art.indexOf(Buffer.from("ANIM", "latin1"));
  assert.ok(anim > 0, "an ANIM chunk marks an animated file");
  // ANIM payload: 4 bytes background color, then a 16-bit loop count. 0 is forever.
  assert.equal(art.readUInt16LE(anim + 8 + 4), 0);
});

test("the launcher is a checkout tool and stays out of the npm package", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts.launcher, "node launcher/launcher.js");
  assert.ok(!pkg.files.some((f) => f.startsWith("launcher")), "launcher/ is not in the files list");
});
