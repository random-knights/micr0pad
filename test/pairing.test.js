"use strict";
// Pairing: the one narrow door a HOSTED page has into this local bridge.
//
// Two layers, because they fail differently. The unit tests drive
// lib/pairing.js with a throwaway config object and a fake clock: they are
// where the code, the expiry and the origin list are pinned. The behavior
// tests boot the real server.js against a throwaway config file and ask it
// over HTTP: they are where the origin policy is pinned, including the part
// that matters most, which is what an UNPAIRED origin gets.
//
// Nothing here opens the pad's HID handle. The server runs in the
// RK_MICROPAD_NO_DEVICE seam, the same one test/origin-policy.test.js uses,
// so a plugged-in pad keeps its own server and this suite never fights it
// for the device.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { Pairing, CODE_LENGTH, CODE_TTL_MS, DEFAULT_HOSTED_ORIGINS } = require("../lib/pairing");

const HOSTED = "https://rand0m.ai";
const OTHER_HOSTED = "https://abc-rand0m-ai.web.app";
const EVIL = "https://evil.example";

function freshPairing() {
  const cfg = { pairings: [] };
  const writes = [];
  const p = new Pairing(cfg, { persist: (list) => writes.push(list.length) });
  return { cfg, p, writes };
}

// ---------------------------------------------------------------------------
// lib/pairing.js
// ---------------------------------------------------------------------------

test("start mints a code of the documented shape and life", () => {
  const { p } = freshPairing();
  const now = 1_000_000;
  const started = p.start(now);
  assert.equal(started.code.length, CODE_LENGTH);
  assert.match(started.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/, "no I, O, 0 or 1: the code is transcribed by hand");
  assert.equal(started.expiresAt, now + CODE_TTL_MS);
});

test("complete pairs the origin, returns the token once, and stores only a hash", () => {
  const { cfg, p, writes } = freshPairing();
  const now = 1_000_000;
  const { code } = p.start(now);
  const done = p.complete(code, HOSTED, "my laptop", now + 1000);
  assert.equal(done.ok, true);
  assert.match(done.token, /^[0-9a-f]{64}$/);
  assert.equal(cfg.pairings.length, 1);
  assert.equal(writes.length, 1, "a completed pairing is persisted");

  const stored = cfg.pairings[0];
  assert.equal(stored.origin, HOSTED);
  assert.equal(stored.label, "my laptop");
  assert.equal("token" in stored, false, "the clear token is never stored");
  assert.notEqual(stored.tokenHash, done.token, "what is stored must not be the token itself");
  assert.match(stored.tokenHash, /^[0-9a-f]{64}$/);

  // And the listing says nothing more than it should.
  const listed = p.list();
  assert.deepEqual(Object.keys(listed[0]).sort(), ["createdAt", "id", "label", "origin"]);
});

test("a matched pairing needs BOTH the right origin and the right token", () => {
  const { p } = freshPairing();
  const { code } = p.start(1000);
  const { token } = p.complete(code, HOSTED, "laptop", 2000);
  assert.ok(p.match(HOSTED, token), "the paired origin with its own token");
  assert.equal(p.match(OTHER_HOSTED, token), null, "the same token replayed from another origin");
  assert.equal(p.match(HOSTED, "0".repeat(64)), null, "the right origin with a wrong token");
  assert.equal(p.match(HOSTED, ""), null, "no token at all");
});

test("a wrong code is refused, and burns the code", () => {
  const { cfg, p } = freshPairing();
  const { code } = p.start(1000);
  const wrong = code === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA";
  const first = p.complete(wrong, HOSTED, "laptop", 2000);
  assert.equal(first.ok, false);
  assert.match(first.error, /does not match/);
  assert.equal(cfg.pairings.length, 0);
  // One guess is all a code is worth: the right code no longer works either.
  const second = p.complete(code, HOSTED, "laptop", 3000);
  assert.equal(second.ok, false);
  assert.equal(cfg.pairings.length, 0);
});

test("an expired code is refused", () => {
  const { cfg, p } = freshPairing();
  const now = 1_000_000;
  const { code } = p.start(now);
  const late = p.complete(code, HOSTED, "laptop", now + CODE_TTL_MS + 1);
  assert.equal(late.ok, false);
  assert.match(late.error, /no pairing code is active/);
  assert.equal(cfg.pairings.length, 0);
});

test("an origin off the hosted list cannot pair even with the right code", () => {
  const { cfg, p } = freshPairing();
  const { code } = p.start(1000);
  const refused = p.complete(code, EVIL, "laptop", 2000);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /cannot pair/);
  assert.equal(cfg.pairings.length, 0);
  // and the code survives, because a refusal that is not about the code
  // should not cost the owner the code.
  assert.equal(p.complete(code, HOSTED, "laptop", 3000).ok, true);
});

test("the hosted origin list is never a wildcard", () => {
  assert.deepEqual(Pairing.normalizeHostedOrigins(["*"]), []);
  assert.deepEqual(Pairing.normalizeHostedOrigins(["https://*.rand0m.ai"]), []);
  assert.deepEqual(Pairing.normalizeHostedOrigins(["http://rand0m.ai"]), [], "http is not a hosted origin");
  assert.deepEqual(Pairing.normalizeHostedOrigins(["https://rand0m.ai/"]), ["https://rand0m.ai"]);
  assert.deepEqual(Pairing.normalizeHostedOrigins([]), DEFAULT_HOSTED_ORIGINS);
  assert.deepEqual(Pairing.normalizeHostedOrigins(undefined), DEFAULT_HOSTED_ORIGINS);
});

test("revoke removes exactly one pairing and persists", () => {
  const { cfg, p, writes } = freshPairing();
  const a = p.complete(p.start(1000).code, HOSTED, "a", 1100);
  const b = p.complete(p.start(2000).code, OTHER_HOSTED, "b", 2100);
  assert.equal(cfg.pairings.length, 2);
  assert.equal(p.revoke(a.id), true);
  assert.equal(cfg.pairings.length, 1);
  assert.equal(writes.length, 3, "two completions and one revoke");
  assert.equal(p.match(HOSTED, a.token), null, "a revoked token stops working");
  assert.ok(p.match(OTHER_HOSTED, b.token), "the other pairing is untouched");
  assert.equal(p.revoke(a.id), false, "revoking it again changes nothing");
});

// ---------------------------------------------------------------------------
// server.js over HTTP
// ---------------------------------------------------------------------------

function hidLoads() {
  try {
    require("node-hid");
    return true;
  } catch (e) {
    return false;
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A throwaway config file per run. Pairing WRITES to config.json, so pointing
// the server at the repo's real one would edit the machine this is running
// on - including the owner's laptop.
function throwawayConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "micr0pad-pairing-"));
  return path.join(dir, "config.json");
}

function startServer(port, configPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        RK_MICROPAD_PORT: String(port),
        RK_MICROPAD_NO_DEVICE: "1",
        RK_MICROPAD_CONFIG: configPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not start within 20s\n${out}`));
    }, 20000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("server on")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${out}`));
    });
  });
}

async function call(port, route, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, opts);
  let body = null;
  try { body = await res.json(); } catch (_) { /* 204s and empties */ }
  return { code: res.status, acao: res.headers.get("access-control-allow-origin"), body };
}

test(
  "the bridge pairs a hosted origin, and refuses everything else",
  { skip: hidLoads() ? false : "node-hid is not loadable here, so the server cannot boot" },
  async (t) => {
    const port = await freePort();
    const configPath = throwawayConfig();
    const child = await startServer(port, configPath);
    t.after(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill();
      try { fs.rmSync(path.dirname(configPath), { recursive: true, force: true }); } catch (_) {}
    });
    const own = `http://localhost:${port}`;
    const localToken = (await call(port, "/api/pairing-token", { headers: { Origin: own } })).body.token;
    const json = { "Content-Type": "application/json" };

    // BEFORE any pairing: the hosted origin is refused on a read and on a
    // write, and its preflight is refused too, which is what actually stops
    // the browser.
    assert.equal((await call(port, "/api/state", { headers: { Origin: HOSTED } })).code, 403, "unpaired read");
    assert.equal(
      (await call(port, "/api/config", { method: "POST", headers: { ...json, Origin: HOSTED }, body: "{}" })).code,
      403,
      "unpaired write",
    );
    const coldPreflight = await call(port, "/api/state", {
      method: "OPTIONS",
      headers: { Origin: HOSTED, "Access-Control-Request-Method": "GET" },
    });
    assert.equal(coldPreflight.code, 403);
    assert.equal(coldPreflight.acao, null, "a refused preflight carries no CORS header");

    // Step 1, on the local dashboard. A hosted origin cannot do this itself.
    const started = await call(port, "/api/pair/start", {
      method: "POST",
      headers: { ...json, Origin: own, "x-pairing-token": localToken },
    });
    assert.equal(started.code, 200);
    assert.equal(started.body.code.length, CODE_LENGTH);

    // Step 2 and 3, from the hosted page. An origin off the list is refused
    // with the very same code.
    const evilTry = await call(port, "/api/pair/complete", {
      method: "POST",
      headers: { ...json, Origin: EVIL },
      body: JSON.stringify({ code: started.body.code }),
    });
    assert.equal(evilTry.code, 403, "an origin off the hosted list cannot pair");
    assert.equal(evilTry.acao, null);

    const paired = await call(port, "/api/pair/complete", {
      method: "POST",
      headers: { ...json, Origin: HOSTED },
      body: JSON.stringify({ code: started.body.code, label: "hosted 1aunchpad" }),
    });
    assert.equal(paired.code, 200);
    assert.equal(paired.body.ok, true);
    assert.equal(paired.acao, HOSTED, "the pairing response must be readable by the page that asked");
    const bearer = { Authorization: `Bearer ${paired.body.token}` };

    // AFTER pairing: the read works, and the response says the page may read
    // it - named exactly, never a wildcard.
    const read = await call(port, "/api/state", { headers: { Origin: HOSTED, ...bearer } });
    assert.equal(read.code, 200);
    assert.equal(read.acao, HOSTED);
    assert.equal(read.body.config.pairingToken, undefined, "no response carries the local token");
    assert.equal(read.body.config.pairings, undefined, "no response carries the pairing hashes");

    // A write through the pairing works, and needs no local token.
    const write = await call(port, "/api/config", {
      method: "POST",
      headers: { ...json, Origin: HOSTED, ...bearer },
      body: JSON.stringify({}),
    });
    assert.equal(write.code, 200);
    assert.equal(write.acao, HOSTED);

    // The pairing does NOT hand over the local page's identity, and does not
    // let a hosted page mint further pairings or end a process here.
    for (const route of ["/api/pairing-token"]) {
      assert.equal((await call(port, route, { headers: { Origin: HOSTED, ...bearer } })).code, 403, route);
    }
    for (const route of ["/api/pair/start", "/api/sys/kill"]) {
      const r = await call(port, route, { method: "POST", headers: { ...json, Origin: HOSTED, ...bearer }, body: "{}" });
      assert.equal(r.code, 403, route);
    }

    // The token is origin-pinned: the same bearer from another hosted origin
    // is a stranger.
    assert.equal(
      (await call(port, "/api/state", { headers: { Origin: OTHER_HOSTED, ...bearer } })).code,
      403,
      "the token does not travel to another origin",
    );

    // Listing, from either end, says labels and dates and no secret.
    const listed = await call(port, "/api/pair", { headers: { Origin: own } });
    assert.equal(listed.code, 200);
    assert.equal(listed.body.pairings.length, 1);
    assert.deepEqual(Object.keys(listed.body.pairings[0]).sort(), ["createdAt", "id", "label", "origin"]);
    const id = listed.body.pairings[0].id;

    // Revoke from the hosted side (the disconnect button), and the pairing is
    // gone for good: the same token now reads as an unpaired origin.
    const revoked = await call(port, `/api/pair/${id}`, {
      method: "DELETE",
      headers: { ...json, Origin: HOSTED, ...bearer },
    });
    assert.equal(revoked.code, 200);
    assert.equal(revoked.body.ok, true);
    assert.equal((await call(port, "/api/state", { headers: { Origin: HOSTED, ...bearer } })).code, 403, "revoked");

    // And the local end can revoke too, which is the other half of "either
    // side". Pair again, then cut it from the dashboard.
    const second = await call(port, "/api/pair/start", {
      method: "POST",
      headers: { ...json, Origin: own, "x-pairing-token": localToken },
    });
    const again = await call(port, "/api/pair/complete", {
      method: "POST",
      headers: { ...json, Origin: HOSTED },
      body: JSON.stringify({ code: second.body.code, label: "hosted 1aunchpad" }),
    });
    const againId = again.body.id;
    const localRevoke = await call(port, `/api/pair/${againId}`, {
      method: "DELETE",
      headers: { ...json, Origin: own, "x-pairing-token": localToken },
    });
    assert.equal(localRevoke.code, 200);
    assert.equal(
      (await call(port, "/api/state", { headers: { Origin: HOSTED, Authorization: `Bearer ${again.body.token}` } })).code,
      403,
      "revoked from the local dashboard",
    );

    // The throwaway config carries the hashes and never a clear token.
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(Array.isArray(written.pairings), true);
    assert.equal(written.pairings.length, 0, "both pairings were revoked");
  },
);
