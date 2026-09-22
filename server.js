"use strict";
// server.js - serves the RK micropad UI + a JSON API for live state.
// Run: node server.js  then open http://localhost:PORT
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const config = require("./lib/config");
const paths = require("./lib/paths");
const { Pairing } = require("./lib/pairing");
const { MicropadBridge } = require("./lib/bridge");

const PORT = process.env.RK_MICROPAD_PORT || 4120;
const PUBLIC = path.join(__dirname, "public");
const cfg = config.load();
config.writeExample();

// Auth for mutating routes. The token is minted by config.load() (see
// lib/config.js) and lives on cfg.pairingToken; PAIRING_TOKEN is a private
// copy so it never has to be re-read off the (redacted, client-facing) cfg
// object. ALLOWED_ORIGIN follows PORT rather than hardcoding 4120, so an
// owner who overrides RK_MICROPAD_PORT does not lock themselves out.
const PAIRING_TOKEN = cfg.pairingToken;
const ALLOWED_ORIGIN = `http://localhost:${PORT}`;

// The hosted side of the same question. ALLOWED_ORIGIN is the ONE origin that
// is trusted because of where it is; a paired origin is trusted because the
// owner put a code from this screen into that page. See lib/pairing.js.
const pairing = new Pairing(cfg, { persist: (list) => config.savePairings(list) });

// Routes a PAIRED origin may never reach, whatever token it holds:
//
//   /api/pairing-token  hands out the LOCAL page's token. Giving it to a
//                       hosted page would let that page act as the local
//                       page, which is the whole thing pairing replaces.
//   /api/pair/start     mints a pairing code. A paired page that could mint
//                       codes could pair further origins without the owner.
//   /api/sys/kill       ends a process on this machine. Pairing is a remote
//                       capability and ending a process is not one; the owner
//                       does that from the machine it happens on.
//
// Everything else - the reads, the config writes, the light and keymap
// routes - is the same surface the local page has. README says so in the
// security section, because a paired page being able to run an action key is
// a real consequence of pairing and not a footnote.
const LOCAL_ONLY_ROUTES = new Set(["/api/pairing-token", "/api/pair/start", "/api/sys/kill"]);

// GET /api/config and /api/state echo the live config back to the page;
// strip the token before it ever reaches a JSON response.
function redactConfig(c) {
  const { pairingToken, pairings, ...rest } = c;
  // Pairings go out through /api/pair, which returns labels, origins and
  // dates. The raw array carries tokenHash, so it never rides along on
  // /api/state or /api/config.
  return rest;
}

// Any tab on any site can already reach localhost, so every /api/ request
// has to come from the pad's own page. One policy, one code path: this is
// the only place an origin is judged.
//
// The one difference between a read and a mutation is what a MISSING Origin
// header means. Browsers attach Origin to every non-GET fetch, same-origin
// included, so a mutation can fail closed on a missing header without
// affecting the real UI. Same-origin GET fetches carry no Origin header at
// all, so a read can only reject a MISMATCHED one. That gap is closed by
// the second half of the read policy: an UNPAIRED cross-origin response
// carries no Access-Control-Allow-Origin header at all, so such a page can
// reach a GET handler but the browser will not let its JS read the body.
// There is no wildcard anywhere: the only value this server ever puts in that
// header is the exact origin of a caller that holds a pairing.
//
// A PAIRED hosted origin is the second way through, and only the second way:
// it must send an Origin this bridge has a pairing for AND the bearer token
// that pairing was issued with. Reads and writes are judged the same way, so
// there is no read that a hosted page can do unpaired.
function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

// Who is asking? Exactly one of:
//   { kind: "local" }   the pad's own page (or a same-origin GET, which
//                       carries no Origin header at all)
//   { kind: "paired" }  a hosted origin presenting its pairing token
//   null                refused, and the 403 has already been written
function callerOf(req, res, { requireHeader }) {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) return { kind: "local", origin };
  if (!origin) {
    if (!requireHeader) return { kind: "local", origin: null };
    logRefusedHosted(req, "a mutation without an Origin header");
  } else {
    const paired = pairing.match(origin, bearerToken(req));
    if (paired) return { kind: "paired", origin, id: paired.id };
    logRefusedHosted(req, pairing.refusalReason(origin, Boolean(bearerToken(req))));
  }
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "origin not allowed" }));
  return null;
}

// A paired origin's JS has to be able to READ the body it asked for, so its
// response - and only its response - carries the exact origin back. Never a
// wildcard, and never for a local response, which does not need one.
function allowPairedOrigin(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
}

// One line per refused hosted request, with the reason, so the owner can read
// in the bridge's own console why a hosted page is not getting through. It
// names the method, the path, the origin and the reason. It never prints any
// other header: no token, no code, no body.
function logRefusedHosted(req, reason) {
  const origin = req.headers.origin ? String(req.headers.origin).slice(0, 200) : "(no origin)";
  const url = String(req.url || "").split("?")[0].slice(0, 200);
  console.log(`refused hosted request: ${req.method} ${url} from ${origin}: ${reason}`);
}

function refuseLocalOnly(res) {
  // res.req is the request this response answers (Node sets it).
  if (res.req) logRefusedHosted(res.req, "this route is local to the machine the pad is on");
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "this route is local to the machine the pad is on" }));
  return null;
}

// A read proves it came from the pad's own page, or from a paired origin. A
// mutation proves that and, for the LOCAL page, that it is the pad's own page
// rather than any page on that origin (the pairing token). A paired caller
// has already proved that with its bearer token; asking it for the local
// token too would mean handing the local token to a hosted page.
function authorizeRead(req, res, pathname) {
  const who = callerOf(req, res, { requireHeader: false });
  if (!who) return null;
  if (who.kind === "paired") {
    if (LOCAL_ONLY_ROUTES.has(pathname)) return refuseLocalOnly(res);
    allowPairedOrigin(res, who.origin);
  }
  return who;
}

function authorizeMutation(req, res, pathname) {
  const who = callerOf(req, res, { requireHeader: true });
  if (!who) return null;
  if (who.kind === "paired") {
    if (LOCAL_ONLY_ROUTES.has(pathname)) return refuseLocalOnly(res);
    allowPairedOrigin(res, who.origin);
    return who;
  }
  const supplied = Buffer.from(String(req.headers["x-pairing-token"] || ""), "utf8");
  const expected = Buffer.from(PAIRING_TOKEN, "utf8");
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "pairing token required" }));
    return null;
  }
  return who;
}

// The machine this micropad bridge is running on (the PC the pad is plugged
// into). Shown in the UI so the owner can tell which host a pad is attached to.
const HOSTNAME = require("os").hostname();
const os = require("os");

// CPU usage: we hold the last sample of per-core times and compute the delta
// on the next read, turning the cumulative counters into a live percentage.
let cpuPrev = os.cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));

function readCpu() {
  const now = os.cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
  let idleDelta = 0, totalDelta = 0;
  now.forEach((c, i) => {
    const p = cpuPrev[i];
    if (!p) return;
    idleDelta += c.idle - p.idle;
    totalDelta += c.total - p.total;
  });
  cpuPrev = now;
  if (totalDelta <= 0) return 0;
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10;
}

// One line of system metrics (CPU, RAM, disk, process count). The process
// count comes from the watcher's last sample, so this route spawns nothing.
async function sysSnapshot() {
  const totalMem = os.totalmem(), freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  return {
    cpuPct: readCpu(),
    memUsedMb: Math.round(usedMem / 1048576),
    memTotalMb: Math.round(totalMem / 1048576),
    memPct: Math.round((usedMem / totalMem) * 100),
    processes: watch.procs.size,
    hostname: HOSTNAME,
    uptimeSec: Math.round(os.uptime()),
  };
}

// RESOURCE WATCH
// ONE process sampler feeds both the Top Processes table and the watcher
// rules (lib/watch.js). It is a single long-lived PowerShell child rather
// than a spawn per tick: a fresh powershell costs 400 to 650 ms of wall time
// per call on the laptop this was built on, warm Get-Process costs 80 ms.
// The child polls the server pid and exits by itself when it is gone, so a
// force-killed server leaves no loop behind. Get-Process gives working set
// and cumulative CPU time; Win32_Process, every 10th tick, gives the parent
// pid and the exact image name (the orphanDev rule needs the first, the
// kill allowlist the second). Line format: see parseSample in lib/watch.js.
const watchLib = require("./lib/watch");
const watch = new watchLib.Watch(cfg.watch);
// Beside config.json in the per-user directory (lib/paths.js), so an npx
// upgrade does not start the alert history over.
const WATCH_LOG = path.join(paths.dataDir(), "watch.log");
const samplerState = { child: null, prev: {}, lastLineAt: 0, restarts: 0 };
const SAMPLER_PS = [
  `$pp=${process.pid}; $iv=${watch.cfg.sampleMs}; $k=0; $meta=@{}`,
  "while ($true) {",
  "  if (-not (Get-Process -Id $pp -ErrorAction SilentlyContinue)) { exit }",
  "  if ($k % 10 -eq 0) { $m=@{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ForEach-Object { $m[[int]$_.ProcessId] = \"$($_.ParentProcessId)|$($_.Name)\" }; $meta=$m }",
  "  $k++",
  "  $rows = foreach ($p in Get-Process) { $c=-1; try { $c=[long]$p.TotalProcessorTime.TotalMilliseconds } catch {}; $x=$meta[[int]$p.Id]; if (-not $x) { $x=\"0|$($p.ProcessName).exe\" }; \"$($p.Id)|$($p.WorkingSet64)|$c|$x\" }",
  "  Write-Output (\"S \" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + \" \" + ($rows -join ';'))",
  "  Start-Sleep -Milliseconds $iv",
  "}",
].join("\n");

function watchLog(entry) {
  // Process name, pid, rule, time, who. Never a title, a user or a path.
  try { paths.ensureDir(path.dirname(WATCH_LOG)); fs.appendFileSync(WATCH_LOG, JSON.stringify(Object.assign({ t: new Date().toISOString() }, entry)) + "\n"); } catch (_) {}
}

function onSamplerLine(line) {
  const parsed = watchLib.parseSample(line, samplerState.prev, os.cpus().length);
  if (!parsed) return;
  samplerState.prev = parsed.cpuMs;
  samplerState.lastLineAt = Date.now();
  const totalMem = os.totalmem();
  const sample = { t: parsed.t, procs: parsed.procs, cpuPct: readCpu(), memPct: Math.round(((totalMem - os.freemem()) / totalMem) * 100) };
  for (const alert of watch.ingest(sample)) {
    watchLog({ event: "alert", rule: alert.rule, name: alert.name, pid: alert.pid, who: "watch" });
    bridge.emit("notice", { text: `watch: ${alert.label}: ${alert.name}${alert.pid ? " " + alert.pid : ""}, ${alert.detail}`, watch: alert });
    flashPad().catch(() => {});
  }
}

function startSampler() {
  if (!watch.cfg.enabled || process.platform !== "win32") return;
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", SAMPLER_PS], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  samplerState.child = child;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { onSamplerLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
  });
  child.on("exit", () => {
    samplerState.child = null;
    samplerState.prev = {};
    samplerState.restarts++;
    setTimeout(startSampler, 5000).unref();
  });
}
process.on("exit", () => { if (samplerState.child) samplerState.child.kill(); });

// Two short flashes of the blocked color on the ambient zone, then hand the
// light back to state via the bridge's own repaint. Never while talk is live
// (the gold pulse is the owner's cue that dictation is on) or while pairing.
// Uses the same bridge surface server.js already uses for keymap backup.
async function flashPad() {
  if (!bridge.dev || bridge.pairing || bridge.talkActive) return;
  const color = ((cfg.statusColors || {}).blocked || {}).color || 0xff2d2d;
  const dark = { e: 0, b: 0, s: 0.5, m: 1, c: 0 };
  const on = { e: 1, b: 1, s: 0.5, m: 1, c: color };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 2; i++) {
    await bridge.dev.call("v.oai.rgbcfg", { keys: dark, ambient: on });
    await wait(220);
    await bridge.dev.call("v.oai.rgbcfg", { keys: dark, ambient: dark });
    await wait(180);
  }
  await bridge.refresh();
}

const launcher = require("./lib/launcher");
const bridge = new MicropadBridge(cfg);
// One process owns the pad's HID handle. RK_MICROPAD_NO_DEVICE brings the HTTP
// server up without claiming it, so a test can ask the API questions on a
// machine where the real pad server is already running. It disables the
// hardware only: every route, and every check in front of every route, behaves
// exactly as it does in a normal run.
if (process.env.RK_MICROPAD_NO_DEVICE !== "1") bridge.start();
startSampler();

// SSE clients: the web UI subscribes so it can react to device key presses
// (talk toggle, action runs) without polling.
const sseClients = new Set();
bridge.on("notice", (n) => broadcast({ type: "notice", text: n.text, watch: n.watch || null }));
bridge.on("actkeyevent", (e) => broadcast({ type: "actkey", index: e.index, pressed: e.pressed }));
// AG key events cover the six status keys AND the dial (13/14) and joystick
// (15-18), so the on-screen dial and toggle can light up when the physical
// control is used.
bridge.on("keyevent", (e) => broadcast({ type: "agkey", index: e.index, pressed: e.pressed }));
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch (_) { sseClients.delete(res); } }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(req, res, urlPath) {
  let file = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(full)) { res.writeHead(404); res.end("not found"); return; }
  const ext = path.extname(full);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(full).pipe(res);
}

// Run an action command configured for a bottom key.
function runAction(action) {
  if (!action || action.type !== "cmd" || !action.cmd) {
    return { ok: false, error: "no command set for this key - use the gear in Action Keys" };
  }
  const cmdPath = launcher.resolveCmd(action.cmd, cfg);
  if (!cmdPath) {
    return {
      ok: false,
      error: `cmd not found: ${action.cmd}`,
      searched: launcher.describe(cfg).map((c) => c.dir),
    };
  }
  // Spawn detached so the launcher runs independent of this process.
  const child = execFile("cmd.exe", ["/c", "start", "", cmdPath], { windowsHide: true, detached: true }, (e) => {});
  child.unref();
  return { ok: true, command: action.cmd };
}

// Read a JSON request body. Capped, because an unbounded read on a route that
// has not been authorized yet is a way to make this process hold memory for a
// stranger; 8 KB is far above any body these routes take.
function readJsonBody(req, res, then) {
  let body = "";
  let tooBig = false;
  req.on("data", (c) => {
    body += c;
    if (body.length > 8192 && !tooBig) {
      tooBig = true;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "body too large" }));
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooBig) return;
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch (_) { parsed = null; }
    if (parsed === null || typeof parsed !== "object") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "expected a JSON object" }));
      return;
    }
    then(parsed);
  });
}

// CORS preflight. The browser is asking "may this origin send you an
// Authorization header?", and the honest answers are: yes for an origin that
// already holds a pairing, yes for a hosted origin asking about
// /api/pair/complete (the one route that exists to create one) or
// /api/pair/status (the probe that says whether it is paired), no otherwise.
// A refusal is a 403 with no CORS headers, which is what makes the browser
// block the real request.
//
// Chrome's Local Network Access (Chrome 142 and later) gates a public page's
// request to localhost behind a user permission, not behind a preflight, so
// nothing here grants or needs that permission. The older Private Network
// Access preflight header (Access-Control-Request-Private-Network) is still
// answered, for an allowed origin only, because a browser or an enterprise
// policy that still sends it would otherwise block the request.
const PAIRING_ROUTES = new Map([["/api/pair/complete", "POST"], ["/api/pair/status", "GET"]]);
function answerPreflight(req, res, pathname) {
  const origin = req.headers.origin;
  const wanted = String(req.headers["access-control-request-method"] || "").toUpperCase();
  // A preflight carries no Authorization header - that is what it is asking
  // about - so entitlement here is by ORIGIN only. The real request is still
  // judged on its token; this only decides whether the browser may send it.
  const knownOrigin = Boolean(origin) && cfgHasPairingFor(origin);
  const pairingAttempt = Boolean(origin) && PAIRING_ROUTES.has(pathname) && pairing.mayAttemptPairing(origin);
  if (!knownOrigin && !pairingAttempt) {
    logRefusedHosted(req, `preflight: ${pairing.refusalReason(origin, false)}`);
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "origin not allowed" }));
    return;
  }
  if (PAIRING_ROUTES.has(pathname) && wanted && wanted !== PAIRING_ROUTES.get(pathname)) {
    logRefusedHosted(req, `preflight: ${wanted} is not the method of ${pathname}`);
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "origin not allowed" }));
    return;
  }
  const headers = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (String(req.headers["access-control-request-private-network"] || "").toLowerCase() === "true") {
    headers["Access-Control-Allow-Private-Network"] = "true";
  }
  res.writeHead(204, headers);
  res.end();
}

// Does ANY pairing exist for this origin? Used only by the preflight, which
// cannot see a token. It leaks one bit (this origin has paired with this
// bridge) to a page that is already on the hosted list or already paired.
function cfgHasPairingFor(origin) {
  return cfg.pairings.some((x) => x.origin === String(origin));
}

// Step 2 and 3 of the handshake (lib/pairing.js has the whole shape). The
// origin comes from the browser's own Origin header, never from the body, so
// a page cannot claim to be somewhere else. The token is in the response and
// nowhere else, ever.
function handlePairComplete(req, res) {
  const origin = req.headers.origin;
  if (!origin || !pairing.mayAttemptPairing(origin)) {
    logRefusedHosted(req, origin ? "origin is not in hostedOrigins" : "a pairing without an Origin header");
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "origin not allowed" }));
    return;
  }
  readJsonBody(req, res, (parsed) => {
    const result = pairing.complete(parsed.code, origin, parsed.label, Date.now());
    res.writeHead(result.ok ? 200 : 400, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
    });
    res.end(JSON.stringify(result));
  });
}

// The probe a hosted page runs first (status() in lib/pairing.js). Readable by
// an origin on the hosted list or one holding a pairing, never by anyone
// else: a stranger is refused like any other caller, with no CORS headers, so
// a page off the list learns only what an opaque request already tells it,
// that something answered. The local page may read it too.
function handlePairStatus(req, res) {
  const origin = req.headers.origin;
  if (!origin || origin === ALLOWED_ORIGIN) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...pairing.status(null, ""), originAllowed: true, paired: false, local: true }));
    return;
  }
  const token = bearerToken(req);
  const body = pairing.status(origin, token);
  if (!body.originAllowed) {
    logRefusedHosted(req, pairing.refusalReason(origin, Boolean(token)));
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "origin not allowed" }));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // Every /api/ request is judged before any handler runs. A GET proves its
  // origin; anything else proves its origin and carries the pairing token.
  // A paired hosted origin satisfies both with its bearer token.
  let caller = null;
  if (p.startsWith("/api/")) {
    // A browser asks permission before it sends an Authorization header
    // cross-origin. Answering the preflight is part of the policy, not a
    // bypass of it: it says yes to exactly the callers the policy says yes to.
    if (req.method === "OPTIONS") return answerPreflight(req, res, p);
    // The one route a not-yet-paired hosted origin may reach, because there
    // is no way to become paired without it. Its own gate is inside.
    if (req.method === "POST" && p === "/api/pair/complete") return handlePairComplete(req, res);
    if (req.method === "GET" && p === "/api/pair/status") return handlePairStatus(req, res);
    if (req.method === "GET") {
      caller = authorizeRead(req, res, p);
    } else {
      caller = authorizeMutation(req, res, p);
    }
    if (!caller) return;
  }

  // The page's own bootstrap read: the token has to reach the UI somehow
  // before the UI can send it back.
  if (req.method === "GET" && p === "/api/pairing-token") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ token: PAIRING_TOKEN }));
    return;
  }

  if (req.method === "GET" && p === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "GET" && p.startsWith("/api/")) {
    if (p === "/api/state") {
      const assigned = bridge.lastAssigned.map((x) => ({
        slot: x.slotCfg.slot,
        name: x.slotCfg.name,
        keyID: config_agentKeyIDs()[x.slotCfg.slot],
        agent: x.agent ? { agent: x.agent.agent, status: require("./lib/herdr").statusOf(x.agent), focused: x.agent.focused, cwd: x.agent.cwd, paneID: x.agent.paneID } : null,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        deviceUp: bridge.deviceUp(), device: bridge.descriptor(),
        deviceError: bridge.deviceError, pairing: !!bridge.pairing,
        hostname: HOSTNAME,
        config: redactConfig(cfg), assigned,
      }));
      return;
    }
    if (p === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(redactConfig(cfg)));
      return;
    }
    // The pairings this bridge holds: who, what they called it, and when.
    // No token, no hash. `pending` is whether a code is on screen right now,
    // so the local dashboard can show the code box as live - the code itself
    // is only ever in the /api/pair/start response that put it on screen.
    if (p === "/api/pair") {
      const pending = pairing.pendingFor(Date.now());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        pairings: pairing.list(),
        hostedOrigins: pairing.hostedOrigins,
        pending: pending ? { expiresAt: pending.expiresAt } : null,
      }));
      return;
    }
    // Where action commands are searched for, so the settings editor can show
    // it rather than making the user guess.
    if (p === "/api/actions/paths") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ resolved: launcher.cmdDir(cfg), searched: launcher.describe(cfg) }));
      return;
    }
    // The effect list the outer-light animation picker renders from, so the UI
    // never hardcodes a set the firmware might not have.
    if (p === "/api/underglow/effects") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ effects: require("./lib/pad").underglowEffects }));
      return;
    }
    if (p === "/api/debug") {
      const herdr = require("./lib/herdr");
      const aieds = require("./lib/aieds");
      Promise.all([herdr.listAgents().catch(() => []), aieds.summary().catch(() => null)])
        .then(([agents, aiedsSummary]) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ agents, aieds: aiedsSummary }));
        })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); });
      return;
    }
    if (p === "/api/aieds/series") {
      const aieds = require("./lib/aieds");
      aieds.series(30)
        .then((series) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ series })); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); });
      return;
    }
    if (p === "/api/sys") {
      sysSnapshot()
        .then((s) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(s)); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); });
      return;
    }
    // The table scrolls, so send a useful depth rather than a screenful.
    if (p === "/api/sys/procs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ procs: watch.top(25), killable: watch.cfg.killable }));
      return;
    }
    // The watcher: rule table with defaults and reasons, what is alerting now,
    // what is snoozed, and whether the sampler is alive.
    if (p === "/api/watch") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Object.assign(watch.summary(Date.now()), {
        sampler: { running: !!samplerState.child, lastLineAt: samplerState.lastLineAt, restarts: samplerState.restarts },
      })));
      return;
    }
    // Does a keymap backup exist, and from when? Drives which of the two
    // device buttons the UI shows.
    if (p === "/api/keymap/backup-info") {
      const file = paths.keymapBackupPath();
      let info = { exists: false };
      try {
        const stat = fs.statSync(file);
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        info = { exists: true, savedAt: stat.mtime.toISOString(), bytes: (raw.data || "").length };
      } catch (_) { /* no backup yet */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(info));
      return;
    }
    res.writeHead(404); res.end();
    return;
  }

  // Step 1 of the handshake: mint a code and show it. LOCAL_ONLY_ROUTES keeps
  // a paired page out of here, and authorizeMutation has already proved the
  // local pairing token, so this is the owner at the machine.
  if (req.method === "POST" && p === "/api/pair/start") {
    const started = pairing.start(Date.now());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, code: started.code, expiresAt: started.expiresAt }));
    return;
  }

  // Revoke. Either end may do it: the owner from the local dashboard, or the
  // hosted page disconnecting itself. A paired caller may only revoke ITS OWN
  // pairing - one paired origin cannot cut another one off.
  if (req.method === "DELETE" && p.startsWith("/api/pair/")) {
    const id = decodeURIComponent(p.slice("/api/pair/".length));
    if (caller && caller.kind === "paired" && caller.id !== id) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "a paired origin may only revoke its own pairing" }));
      return;
    }
    const removed = pairing.revoke(id);
    res.writeHead(removed ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: removed, id }));
    return;
  }

  // End a process (taskkill /PID <pid> /F). Owner-only action from the UI.
  if (req.method === "POST" && p === "/api/sys/kill") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { pid, rule } = JSON.parse(body || "{}");
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("valid pid required");
        // Only a process on watch.killable can be ended from here. The name
        // comes from the watcher's last sample, never from the request.
        const name = watch.nameOf(pid);
        if (!watch.isKillable(name)) {
          watchLog({ event: "end", rule: rule || null, name, pid, who: "ui", ok: false, refused: true });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `${name || "pid " + pid} is not on watch.killable in config.json` }));
          return;
        }
        execFile("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
          watchLog({ event: "end", rule: rule || null, name, pid, who: "ui", ok: !err });
          if (err) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: (stderr || err.message).trim() })); return; }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, pid }));
        });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Silence one rule for watch.snoozeMs (30 min by default). Alerts of that
  // rule leave the banner now and come back only if still true afterwards.
  if (req.method === "POST" && p === "/api/watch/snooze") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { rule } = JSON.parse(body || "{}");
        const until = watch.snooze(String(rule || ""), Date.now());
        watchLog({ event: "snooze", rule, until: new Date(until).toISOString(), who: "ui" });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, rule, until }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && p === "/api/config") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const next = JSON.parse(body || "{}");
        // Only allow the editable surface: slot names + per-slot colors + underglow.
        // Only touch slots when the request actually carries them, so saving the
        // underglow alone does not wipe the slot names/colors.
        const patch = {};
        if (Array.isArray(next.slots)) {
          patch.slots = next.slots.map((s) => {
            const cur = cfg.slots[s.slot] || {};
            return Object.assign({}, cur, {
              name: typeof s.name === "string" ? s.name : cur.name,
              color: typeof s.color === "string" ? s.color : cur.color,
            });
          });
        }
        // Action keys: label, whether the key runs anything, and what it runs.
        // Only the six known keys are accepted, and only these three fields -
        // the request cannot introduce a new key or a new field.
        if (next.actions && typeof next.actions === "object") {
          const actions = {};
          for (const name of Object.keys(cfg.actions)) {
            const cur = cfg.actions[name] || {};
            const patchIn = next.actions[name];
            if (!patchIn || typeof patchIn !== "object") { actions[name] = cur; continue; }
            const label = typeof patchIn.label === "string" ? patchIn.label.slice(0, 40) : cur.label;
            const cmd = typeof patchIn.cmd === "string" ? patchIn.cmd.slice(0, 260) : cur.cmd;
            const wanted = patchIn.type === "cmd" || patchIn.type === "none" ? patchIn.type : cur.type;
            // Asking for "cmd" with nothing to run is just "none".
            const type = wanted === "cmd" && String(cmd || "").trim() ? "cmd" : (wanted === "cmd" ? "none" : wanted);
            actions[name] = Object.assign({}, cur, { label, type, cmd });
          }
          patch.actions = actions;
        }
        if (next.underglow) {
          patch.underglow = Object.assign({}, cfg.underglow, {
              mode: ["auto", "solid"].includes(next.underglow.mode) ? next.underglow.mode : cfg.underglow.mode,
              color: typeof next.underglow.color === "string" ? next.underglow.color : cfg.underglow.color,
              effect: [1, 5].includes(Number(next.underglow.effect)) ? Number(next.underglow.effect) : cfg.underglow.effect,
              // "state" or one of the firmware effect ids 0-6. Anything else is
              // ignored rather than passed through to the device.
              animation: next.underglow.animation === "state"
                ? "state"
                : ([0, 1, 2, 3, 4, 5, 6].includes(Number(next.underglow.animation))
                  ? Number(next.underglow.animation)
                  : (cfg.underglow.animation ?? "state")),
            });
        }
        const saved = config.save(patch);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, config: redactConfig(saved) }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // A key was pressed on the ON-SCREEN pad. This is a mutating route like any
  // other, so it has already proved its origin and carried the pairing token
  // before reaching here (see the gate at the top of the handler). Nothing
  // about the origin policy is loosened for it.
  //
  // Only a virtual pad accepts a press. When the real pad is live, the answer
  // is to press the real key: reporting a click as a hardware press would put
  // an event on the wire that the device never sent.
  if (req.method === "POST" && p === "/api/press") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { key } = JSON.parse(body || "{}");
        if (!Number.isInteger(key)) throw new Error("key must be a firmware key id");
        const sent = bridge.press(key);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, key, kind: bridge.deviceKind(), sent }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // PAIRING MODE
  // Bluetooth pairing is a firmware behavior: hold the touch sensor 3s, the
  // underglow turns blue, tap to pick a channel. None of that is visible while
  // this app repaints the LEDs every 2.5s, so pairing mode stops the loop and
  // hands the lighting back to the device.
  if (req.method === "POST" && p === "/api/pair") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      try {
        const { active } = JSON.parse(body || "{}");
        const state = await bridge.setPairing(!!active);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pairing: state }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // KEYMAP BACKUP AND REVERT
  // keymap-backup.json is the device's ORIGINAL layout, taken before
  // bind-dial-joy.js rewrote the encoder and joystick. It is the only way back
  // to stock, so the backup endpoint REFUSES to overwrite an existing file
  // unless it is explicitly forced - re-taking a backup now would capture the
  // modified keymap and quietly destroy the thing revert depends on.
  if (req.method === "POST" && p === "/api/keymap/backup") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const file = paths.keymapBackupPath();
      let force = false;
      try { force = !!JSON.parse(body || "{}").force; } catch (_) {}
      if (fs.existsSync(file) && !force) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "a backup already exists; refusing to overwrite the original" }));
        return;
      }
      // The keymap lives in the device flash. A virtual pad has none, so this
      // needs the real thing: an invented keymap written over keymap-backup.json
      // would destroy the only route back to stock.
      if (!bridge.deviceUp()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: bridge.dev ? "the keymap needs the physical pad" : "device not connected" }));
        return;
      }
      try {
        const raw = await bridge.dev.call("fs.read", { file: "keymap.json" });
        paths.writePrivate(file, JSON.stringify(raw, null, 2));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, bytes: (raw.data || "").length }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && p === "/api/keymap/restore") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const file = paths.keymapBackupPath();
      if (!fs.existsSync(file)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "no keymap-backup.json to restore from" }));
        return;
      }
      // The keymap lives in the device flash. A virtual pad has none, so this
      // needs the real thing: an invented keymap written over keymap-backup.json
      // would destroy the only route back to stock.
      if (!bridge.deviceUp()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: bridge.dev ? "the keymap needs the physical pad" : "device not connected" }));
        return;
      }
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!raw.data) throw new Error("backup has no .data string");
        await bridge.dev.call("fs.write", { file: "keymap.json", data: raw.data });
        // The firmware returns ok for anything, so read it back and compare.
        const after = await bridge.dev.call("fs.read", { file: "keymap.json" });
        const identical = after.data === raw.data;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: identical,
          verified: identical,
          note: identical
            ? "device restored to the backed-up keymap; re-run bind-dial-joy.js to get the dial and joystick back"
            : "write accepted but the read-back did not match - check the device",
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // The on-screen dial and toggle drive the SAME bridge methods the physical
  // encoder and joystick do - cycleModel and joyDirection - so the two paths
  // cannot drift apart. Both report the bridge's own notice text back, which is
  // how "no focused agent" surfaces instead of silently doing nothing.
  if (req.method === "POST" && p === "/api/dial") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      let note = null;
      const once = (n) => { note = n.text; };
      bridge.on("notice", once);
      try {
        const { dir } = JSON.parse(body || "{}");
        await bridge.cycleModel(Number(dir) < 0 ? -1 : 1);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, note }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      } finally {
        bridge.listeners = bridge.listeners.filter(([, fn]) => fn !== once);
      }
    });
    return;
  }

  if (req.method === "POST" && p === "/api/joy") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      // AG15 north, AG16 west, AG17 south, AG18 east - the same indices the
      // joystick sectors are bound to in bind-dial-joy.js.
      const AG = { n: 15, w: 16, s: 17, e: 18 };
      let note = null;
      const once = (n) => { note = n.text; };
      bridge.on("notice", once);
      try {
        const { dir } = JSON.parse(body || "{}");
        const index = AG[String(dir || "").toLowerCase()];
        if (!index) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "dir must be n, s, e or w" }));
          return;
        }
        await bridge.joyDirection(index);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, note }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      } finally {
        bridge.listeners = bridge.listeners.filter(([, fn]) => fn !== once);
      }
    });
    return;
  }

  if (req.method === "POST" && p === "/api/action") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { key } = JSON.parse(body || "{}");
        const action = cfg.actions[key];
        const r = action ? runAction(action) : { ok: false, error: `unknown key ${key}` };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Send a command to the currently focused Herdr tab's agent.
  if (req.method === "POST" && p === "/api/send") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { command } = JSON.parse(body || "{}");
        if (!command) throw new Error("command required");
        bridge.sendToFocused(command)
          .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); })
          .catch((err) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: err.message })); });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // cd an agent into a workspace folder (via herdr send-keys: cd + enter).
  if (req.method === "POST" && p === "/api/cd") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { pane, cwd } = JSON.parse(body || "{}");
        if (!pane || !cwd) throw new Error("pane and cwd required");
        const herdr = require("./lib/herdr");
        herdr.cd(pane, cwd)
          .then(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); })
          .catch((err) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: err.message })); });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Debug data: herdr agent status/cwd for all + AiEDs aggregate for claude.
  // (GET handler lives in the /api/ GET block above.)

  if (req.method === "POST" && p === "/api/talk") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { active } = JSON.parse(body || "{}");
        const state = bridge.setTalk(!!active);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, talkActive: state }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && p === "/api/light") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { keyID, color, effect } = JSON.parse(body || "{}");
        if (typeof keyID !== "number") throw new Error("keyID required");
        bridge.setKey(keyID, color || 0xff4124, effect || 1)
          .then(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); })
          .catch((err) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: err.message })); });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  serveStatic(req, res, p === "/" ? "/index.html" : p);
});

// expose raw key ids for the state endpoint without re-importing pad
function config_agentKeyIDs() { return require("./lib/pad").agentKeyIDs; }

server.listen(PORT, () => {
  console.log(`RK MicroPad server on http://localhost:${PORT}`);
  const kind = bridge.deviceKind();
  console.log(`device: ${kind === "hid" ? "connected" : kind === "virtual" ? "virtual pad (no hardware attached)" : "NOT connected"}`);
  if (kind !== "hid" && bridge.deviceError) console.log(`  hid: ${bridge.deviceError}`);
  // The hosted pages this bridge will pair with, said once at startup: a
  // config.json written before a host was added keeps its old list, and this
  // line is where that shows.
  const hosted = pairing.hostedOrigins;
  console.log(`hosted origins allowed to pair: ${hosted.length ? hosted.join(", ") : "none"}`);
});
