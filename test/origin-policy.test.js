"use strict";
// One origin policy, held in place from two directions.
//
// The shape tests below always run: they read server.js and assert that no
// response advertises itself as readable by any origin, and that no /api/
// handler can run before the origin gate. The behaviour tests boot the real
// server and ask it. Those need the HID transport to load, which it does not
// on a CI runner installed with --ignore-scripts, so they announce a skip
// rather than passing quietly. The skip is the honest outcome: the CI gate
// cannot prove HTTP behaviour on a machine that cannot load the device layer.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

test("no response advertises itself as readable by any origin", () => {
  assert.equal(
    SERVER.includes('"Access-Control-Allow-Origin"'),
    false,
    "server.js must not set Access-Control-Allow-Origin: a wildcard there lets any page's JS read /api/state (the machine name) and /api/sys/procs (the process table)",
  );
});

test("every /api/ request is judged before any handler runs", () => {
  const gate = SERVER.indexOf('if (p.startsWith("/api/")) {');
  assert.ok(gate > 0, "the /api/ origin gate must exist");
  assert.match(SERVER.slice(gate, gate + 260), /authorizeRead\(req, res\)/);
  assert.match(SERVER.slice(gate, gate + 260), /authorizeMutation\(req, res\)/);
  // Nothing under /api/ may answer ahead of the gate.
  assert.equal(
    SERVER.slice(0, gate).includes('p === "/api/'),
    false,
    "no /api/ route may be handled before the origin gate",
  );
});

test("a read tolerates a missing Origin, a mutation does not", () => {
  // assert.match on the whole file prints 19k characters on failure, so these
  // assert the boolean and say what is missing instead.
  assert.ok(
    /function authorizeRead\(req, res\) \{\s*return originAllowed\(req, res, \{ requireHeader: false \}\);/.test(SERVER),
    "authorizeRead must allow a missing Origin: same-origin GET fetches send none",
  );
  assert.ok(
    /function authorizeMutation\(req, res\) \{\s*if \(!originAllowed\(req, res, \{ requireHeader: true \}\)\) return false;/.test(SERVER),
    "authorizeMutation must require an Origin header and fail closed without one",
  );
});

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

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      // NO_DEVICE: one process owns the pad's HID handle, so a test that
      // claimed it would fight the owner's own running server and hang. The
      // seam disables the hardware only; every route and every check in front
      // of a route is the real one.
      env: { ...process.env, RK_MICROPAD_PORT: String(port), RK_MICROPAD_NO_DEVICE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    // Kill the child on the timeout path too. A server left running holds the
    // pad's HID handle, and the next boot then blocks on it, so one leaked
    // child turns every later run of this file into a hang.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(
        "server did not start within 20s. If another micr0pad server is " +
        `running, it owns the pad's HID handle and this one cannot boot.\n${out}`,
      ));
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

async function status(port, route, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, opts);
  return { code: res.status, acao: res.headers.get("access-control-allow-origin") };
}

test("the origin policy answers the way it is documented", { skip: hidLoads() ? false : "node-hid is not loadable here, so the server cannot boot" }, async (t) => {
  const port = await freePort();
  const child = await startServer(port);
  // Destroy the pipes as well as the process: an open stdio pipe to a child
  // keeps this runner's event loop alive and the test file never exits.
  t.after(() => {
    child.stdout.destroy();
    child.stderr.destroy();
    child.kill();
  });
  const own = `http://localhost:${port}`;
  const evil = "https://evil.example";

  // The real UI: a same-origin GET carries no Origin header at all.
  assert.deepEqual(await status(port, "/api/state"), { code: 200, acao: null });

  // Another page's tab, reading the two routes that carry machine detail.
  assert.equal((await status(port, "/api/state", { headers: { Origin: evil } })).code, 403);
  assert.equal((await status(port, "/api/sys/procs", { headers: { Origin: evil } })).code, 403);
  assert.equal((await status(port, "/api/pairing-token", { headers: { Origin: evil } })).code, 403);

  // The pad's own page, named explicitly.
  assert.equal((await status(port, "/api/state", { headers: { Origin: own } })).code, 200);

  // A mutation still needs the token, and still fails closed with no Origin.
  const body = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
  assert.equal((await status(port, "/api/sys/kill", { ...body, headers: { ...body.headers, Origin: own } })).code, 401);
  assert.equal((await status(port, "/api/sys/kill", body)).code, 403);
});
