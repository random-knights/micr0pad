"use strict";
// How a hosted page learns what is going on before it is paired, and what
// the bridge says in its own console about it.
//
// The hosted pad panel shows one state at a time (no bridge, origin not
// allowed, not paired, paired), and each state has to come from a real
// response. /api/pair/status is that response: readable by an origin on the
// hosted list or one holding a pairing, refused with no CORS header to
// anybody else. The bridge logs its allowed origins once at startup and one
// line per refused hosted request, and never a token or a code.
//
// The HTTP half boots the real server on a throwaway config with
// RK_MICROPAD_NO_DEVICE=1, so no test opens a pad's HID handle.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const { Pairing, DEFAULT_HOSTED_ORIGINS } = require("../lib/pairing");

const ROOT = path.join(__dirname, "..");
const HOSTED = "https://stg.rand0m.ai";
const EVIL = "https://evil.example";

// ---------------------------------------------------------------------------
// lib/pairing.js
// ---------------------------------------------------------------------------

test("status says allowed and unpaired for a listed origin, and never carries a secret", () => {
  const p = new Pairing({ pairings: [] });
  const s = p.status(HOSTED, "");
  assert.deepEqual(s, { ok: true, bridge: "micr0pad", originAllowed: true, paired: false, pairingCodeActive: false });
  p.start(Date.now());
  assert.equal(p.status(HOSTED, "").pairingCodeActive, true, "a live code is reported as a boolean only");
  assert.equal(JSON.stringify(p.status(HOSTED, "")).includes(p.pending.code), false, "the code never rides along");
});

test("status says paired only for the right origin with the right token", () => {
  const cfg = { pairings: [] };
  const p = new Pairing(cfg);
  const { code } = p.start(1000);
  const done = p.complete(code, HOSTED, "hosted", 1100);
  assert.equal(p.status(HOSTED, done.token).paired, true);
  assert.equal(p.status(HOSTED, "wrong").paired, false);
  assert.equal(p.status(EVIL, done.token).originAllowed, false, "a stranger is not allowed even with a token");
});

test("a refusal names the fix", () => {
  const cfg = { pairings: [], hostedOrigins: ["https://rand0m.ai"] };
  const p = new Pairing(cfg);
  assert.equal(p.refusalReason(HOSTED, false), "origin is not in hostedOrigins",
    "an older config.json whose list predates the staging host");
  assert.equal(p.refusalReason("https://rand0m.ai", false), "origin is allowed but this page has not paired");
  assert.match(p.refusalReason("https://rand0m.ai", true), /does not match/);
});

test("the defaults still list the staging host and never a wildcard", () => {
  assert.ok(DEFAULT_HOSTED_ORIGINS.includes(HOSTED));
  assert.equal(DEFAULT_HOSTED_ORIGINS.some((o) => o.includes("*")), false);
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
    const log = { text: "" };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not start within 20s\n${log.text}`));
    }, 20000);
    child.stdout.on("data", (d) => {
      log.text += d;
      if (log.text.includes("hosted origins allowed to pair")) {
        clearTimeout(timer);
        resolve({ child, log });
      }
    });
    child.stderr.on("data", (d) => (log.text += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${log.text}`));
    });
  });
}

async function call(port, route, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, opts);
  let body = null;
  try { body = await res.json(); } catch (_) { /* 204s and empties */ }
  return {
    code: res.status,
    acao: res.headers.get("access-control-allow-origin"),
    acapn: res.headers.get("access-control-allow-private-network"),
    body,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

test(
  "the status probe, the preflight and the console lines a hosted page depends on",
  { skip: hidLoads() ? false : "node-hid is not loadable here, so the server cannot boot" },
  async (t) => {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "micr0pad-hosted-"));
    const configPath = path.join(dir, "config.json");
    const { child, log } = await startServer(port, configPath);
    t.after(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    });
    const own = `http://localhost:${port}`;
    const json = { "Content-Type": "application/json" };

    // One startup line with the allowed origins.
    assert.match(log.text, /hosted origins allowed to pair: https:\/\/rand0m\.ai, https:\/\/stg\.rand0m\.ai, https:\/\/abc-rand0m-ai\.web\.app/);

    // A listed origin, unpaired: readable, and it says unpaired.
    const cold = await call(port, "/api/pair/status", { headers: { Origin: HOSTED } });
    assert.equal(cold.code, 200);
    assert.equal(cold.acao, HOSTED, "named exactly, never a wildcard");
    assert.equal(cold.body.originAllowed, true);
    assert.equal(cold.body.paired, false);
    assert.equal(cold.body.bridge, "micr0pad");
    assert.equal(JSON.stringify(cold.body).includes(require("os").hostname()), false, "no machine name before pairing");

    // A stranger: refused, no CORS header, and one console line saying why.
    const stranger = await call(port, "/api/pair/status", { headers: { Origin: EVIL } });
    assert.equal(stranger.code, 403);
    assert.equal(stranger.acao, null);
    await settle();
    assert.match(log.text, /refused hosted request: GET \/api\/pair\/status from https:\/\/evil\.example: origin is not in hostedOrigins/);

    // An unpaired read from a listed origin is still refused, and logged
    // with the other reason.
    assert.equal((await call(port, "/api/state", { headers: { Origin: HOSTED } })).code, 403);
    await settle();
    assert.match(log.text, /refused hosted request: GET \/api\/state from https:\/\/stg\.rand0m\.ai: origin is allowed but this page has not paired/);

    // The preflight for the probe, with the Authorization header a paired
    // page sends, and the old Private Network Access header answered for an
    // allowed origin only.
    const pre = await call(port, "/api/pair/status", {
      method: "OPTIONS",
      headers: {
        Origin: HOSTED,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(pre.code, 204);
    assert.equal(pre.acao, HOSTED);
    assert.equal(pre.acapn, "true");
    const plainPre = await call(port, "/api/pair/status", {
      method: "OPTIONS",
      headers: { Origin: HOSTED, "Access-Control-Request-Method": "GET" },
    });
    assert.equal(plainPre.acapn, null, "only answered when asked");
    const evilPre = await call(port, "/api/pair/status", {
      method: "OPTIONS",
      headers: { Origin: EVIL, "Access-Control-Request-Method": "GET", "Access-Control-Request-Private-Network": "true" },
    });
    assert.equal(evilPre.code, 403);
    assert.equal(evilPre.acao, null);
    assert.equal(evilPre.acapn, null, "never for an origin the policy refuses");
    const wrongMethod = await call(port, "/api/pair/status", {
      method: "OPTIONS",
      headers: { Origin: HOSTED, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(wrongMethod.code, 403, "the probe is GET only");

    // Pair, then the probe says paired with the token and unpaired without.
    // The test holds its own throwaway server's tokens and prints neither.
    const localToken = (await call(port, "/api/pairing-token", { headers: { Origin: own } })).body.token;
    const started = await call(port, "/api/pair/start", {
      method: "POST",
      headers: { ...json, Origin: own, "x-pairing-token": localToken },
    });
    assert.equal((await call(port, "/api/pair/status", { headers: { Origin: HOSTED } })).body.pairingCodeActive, true);
    const paired = await call(port, "/api/pair/complete", {
      method: "POST",
      headers: { ...json, Origin: HOSTED },
      body: JSON.stringify({ code: started.body.code, label: "hosted 1aunchpad" }),
    });
    assert.equal(paired.code, 200);
    const bearer = { Authorization: `Bearer ${paired.body.token}` };
    const warm = await call(port, "/api/pair/status", { headers: { Origin: HOSTED, ...bearer } });
    assert.equal(warm.code, 200);
    assert.equal(warm.body.paired, true);
    assert.equal(warm.body.pairingCodeActive, false, "the code was used up");
    const wrong = await call(port, "/api/pair/status", { headers: { Origin: HOSTED, Authorization: "Bearer nope" } });
    assert.equal(wrong.body.paired, false);

    // A paired page asking for a local-only route is refused and logged.
    assert.equal((await call(port, "/api/pairing-token", { headers: { Origin: HOSTED, ...bearer } })).code, 403);
    await settle();
    assert.match(log.text, /refused hosted request: GET \/api\/pairing-token from https:\/\/stg\.rand0m\.ai: this route is local/);

    // The local page may read the probe too.
    const local = await call(port, "/api/pair/status", { headers: { Origin: own } });
    assert.equal(local.code, 200);
    assert.equal(local.acao, null, "a local response needs no CORS header");

    // Nothing secret ever reached the console.
    assert.equal(log.text.includes(paired.body.token), false, "the hosted token is never logged");
    assert.equal(log.text.includes(localToken), false, "the local token is never logged");
    assert.equal(log.text.includes(started.body.code), false, "the pairing code is never logged");
  },
);
