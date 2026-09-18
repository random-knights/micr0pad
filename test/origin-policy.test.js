"use strict";
// One origin policy, held in place from two directions.
//
// The shape tests below read server.js and assert that no response
// advertises itself as readable by any origin, and that no /api/ handler can
// run before the origin gate. The behavior test boots the real server and
// asks it.
//
// The behavior test needs the HID transport to LOAD, though not to find a
// pad. It loads on the CI runner even though the gate installs with
// --ignore-scripts, because node-hid ships prebuilds: run 34087652055 ran all
// 28 tests with 0 skipped. The guard below stays as a safety net for a
// platform where that stops being true, and it announces a skip rather than
// passing quietly, because a gate that cannot load the device layer cannot
// prove HTTP behavior either.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// This test used to assert that server.js contained the string
// "Access-Control-Allow-Origin" nowhere at all. Pairing (RK-44) makes that
// assertion false on purpose: a paired hosted origin has to be able to read
// the body it asked for. What has NOT changed is the thing that assertion was
// protecting, so that is what is asserted now - no wildcard, and no constant
// origin value, only the origin of the caller being answered.
test("no response advertises itself as readable by ANY origin", () => {
  assert.equal(
    SERVER.includes('"Access-Control-Allow-Origin", "*"'),
    false,
    "a wildcard lets any page's JS read /api/state (the machine name) and /api/sys/procs (the process table)",
  );
  assert.equal(
    /Access-Control-Allow-Origin["']?\s*[:,]\s*["'][^"']/.test(SERVER),
    false,
    "the value of that header must always be a variable holding the caller's own origin, never a literal",
  );
});

test("every /api/ request is judged before any handler runs", () => {
  const gate = SERVER.indexOf('if (p.startsWith("/api/")) {');
  assert.ok(gate > 0, "the /api/ origin gate must exist");
  const block = SERVER.slice(gate, gate + 1200);
  assert.match(block, /authorizeRead\(req, res, p\)/);
  assert.match(block, /authorizeMutation\(req, res, p\)/);
  assert.match(block, /if \(!caller\) return;/, "a refused caller must stop the request");
  // Nothing under /api/ may answer ahead of the gate. The two routes that
  // answer INSIDE the gate block before authorize* runs are the CORS
  // preflight and /api/pair/complete, and each carries its own policy: see
  // answerPreflight and handlePairComplete.
  assert.equal(
    SERVER.slice(0, gate).includes('p === "/api/'),
    false,
    "no /api/ route may be handled before the origin gate",
  );
});

// The routes that pairing must never reach, held by name. A route added to
// this list is a decision; a route quietly dropped from it is a hole.
test("a paired origin is kept out of the local-only routes", () => {
  const line = SERVER.match(/const LOCAL_ONLY_ROUTES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(line, "LOCAL_ONLY_ROUTES must exist");
  for (const route of ["/api/pairing-token", "/api/pair/start", "/api/sys/kill"]) {
    assert.ok(line[1].includes(route), `${route} must stay local-only`);
  }
  assert.match(SERVER, /if \(LOCAL_ONLY_ROUTES\.has\(pathname\)\) return refuseLocalOnly\(res\);/);
});

test("a read tolerates a missing Origin, a mutation does not", () => {
  // assert.match on the whole file prints 19k characters on failure, so these
  // assert the boolean and say what is missing instead.
  assert.ok(
    /function authorizeRead\(req, res, pathname\) \{\s*const who = callerOf\(req, res, \{ requireHeader: false \}\);/.test(SERVER),
    "authorizeRead must allow a missing Origin: same-origin GET fetches send none",
  );
  assert.ok(
    /function authorizeMutation\(req, res, pathname\) \{\s*const who = callerOf\(req, res, \{ requireHeader: true \}\);/.test(SERVER),
    "authorizeMutation must require an Origin header and fail closed without one",
  );
  assert.ok(
    /if \(!origin\) \{\s*if \(!requireHeader\) return \{ kind: "local", origin: null \};/.test(SERVER),
    "a missing Origin resolves to local only for a read, never for a mutation",
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
