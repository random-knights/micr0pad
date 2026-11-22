#!/usr/bin/env node
"use strict";
// launcher.js - the desktop launcher: a small window that loops the pad
// drawing, and one click on it that does the whole start.
//
//   node launcher/launcher.js        (or: npm run launcher)
//
// One click on the pad:
//   1. starts the bridge (bin/micr0pad.js) if nothing answers on its port,
//      and leaves it running after this window closes;
//   2. reads what the bridge is holding: a physical pad, or the virtual one;
//   3. shows the family colors on the six status keys, once, as a hello. The
//      bridge repaints the keys from agent state on its next poll, so the
//      hello lasts one poll interval and changes nothing that is saved;
//   4. opens the hosted pairing page when the site says that page is live,
//      and the local app otherwise. The site's own feature list decides, so
//      nothing here has to be edited on the day the page opens.
//
// What this file is NOT: a second way into the bridge. It adds no route and
// no header to server.js. It reads state the way the local page does, and it
// lights the keys through the same /api/light the local page uses, with the
// local token the bridge hands to its own origin. It runs on the machine the
// bridge runs on, as the same user, which is the trust the bridge already
// extends to anything that can read its config file.
//
// The window is served from 127.0.0.1 on a port the OS picks. The one route
// that does anything carries a random path segment minted per run, and no
// response sets Access-Control-Allow-Origin, so another page cannot read the
// segment and cannot press the button.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const HERE = __dirname;
const APP_DIR = path.join(HERE, "..");
const BRIDGE_PORT = process.env.RK_MICROPAD_PORT || 4120;
const BRIDGE_URL = `http://localhost:${BRIDGE_PORT}`;

// The site that hosts the pairing page, the file that says whether the page
// is open, and the entry in it that speaks for this tool.
const HOSTED_ORIGIN = "https://randomly.engineering";
const FEATURES_PATH = "/data/features.json";
const FEATURE_ID = "micr0pad";

// The family link colors, in the order the site footer lists them: the app,
// then org, llc and xyz. Six keys and four colors, so the row of four takes
// one each and the two keys above it take the primary.
const FAMILY = { app: "#ff4124", org: "#f45d43", llc: "#e97862", xyz: "#faafa5" };
const HELLO_KEYS = [
  { keyID: 0, color: FAMILY.app },
  { keyID: 1, color: FAMILY.app },
  { keyID: 2, color: FAMILY.app },
  { keyID: 3, color: FAMILY.org },
  { keyID: 4, color: FAMILY.llc },
  { keyID: 5, color: FAMILY.xyz },
];

function packed(hex) {
  return parseInt(String(hex).replace(/^#/, ""), 16);
}

// Pure: where one click should land, given the site's feature list (or null
// when it could not be read). The hosted page only when the site itself says
// it is live; anything else, an unreadable list included, is the local app.
function pickDestination(features, bridgeUrl = BRIDGE_URL) {
  const list = features && Array.isArray(features.features) ? features.features : [];
  const entry = list.find((f) => f && f.id === FEATURE_ID);
  if (entry && entry.state === "live" && typeof entry.href === "string" && entry.href.startsWith("/")) {
    return { kind: "hosted", url: HOSTED_ORIGIN + entry.href };
  }
  return { kind: "local", url: bridgeUrl };
}

// Pure: the first browser that can open a bare app window, or null. `exists`
// is injected so the test does not depend on what is installed.
function findAppBrowser(env = process.env, exists = fs.existsSync, platform = process.platform) {
  if (platform !== "win32") return null;
  const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  const tails = [
    ["Microsoft", "Edge", "Application", "msedge.exe"],
    ["Google", "Chrome", "Application", "chrome.exe"],
  ];
  for (const tail of tails) {
    for (const root of roots) {
      const full = path.join(root, ...tail);
      if (exists(full)) return full;
    }
  }
  return null;
}

async function getJson(url, { headers = {}, timeoutMs = 4000, method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).pathname}`);
  return res.json();
}

async function bridgeState() {
  return getJson(`${BRIDGE_URL}/api/state`, { timeoutMs: 2500 });
}

function startBridge() {
  const child = spawn(process.execPath, [path.join(APP_DIR, "bin", "micr0pad.js")], {
    cwd: APP_DIR,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

// Start the bridge when nothing answers, then wait for it. Returns the state
// and whether this call is what started it.
async function ensureBridge({ waitMs = 25000 } = {}) {
  try {
    return { started: false, state: await bridgeState() };
  } catch (_) { /* not running yet */ }
  startBridge();
  const deadline = Date.now() + waitMs;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      return { started: true, state: await bridgeState() };
    } catch (e) { last = e; }
  }
  throw new Error(`the bridge did not answer on port ${BRIDGE_PORT}: ${last ? last.message : "no response"}`);
}

// The hello. Every frame is accepted or refused by the bridge; an accepted
// frame is not a lit key (the firmware says ok to anything), so the result
// says "sent", never "lit".
async function sayHello() {
  const { token } = await getJson(`${BRIDGE_URL}/api/pairing-token`, { timeoutMs: 2500 });
  const headers = {
    "Content-Type": "application/json",
    Origin: BRIDGE_URL,
    "X-Pairing-Token": token,
  };
  for (const { keyID, color } of HELLO_KEYS) {
    await getJson(`${BRIDGE_URL}/api/light`, {
      method: "POST",
      headers,
      body: JSON.stringify({ keyID, color: packed(color), effect: 1 }),
      timeoutMs: 6000,
    });
  }
}

async function siteFeatures() {
  try {
    return await getJson(HOSTED_ORIGIN + FEATURES_PATH, { timeoutMs: 4000 });
  } catch (_) {
    return null;
  }
}

function openInBrowser(url) {
  const opts = { detached: true, stdio: "ignore", windowsHide: true };
  if (process.platform === "win32") {
    // rundll32 hands the URL to the default browser without a shell, so the
    // URL is one argument and never parsed as a command line.
    spawn("rundll32", ["url.dll,FileProtocolHandler", url], opts).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], opts).unref();
  } else {
    spawn("xdg-open", [url], opts).unref();
  }
}

// The whole click, as steps the window can show one by one.
async function go(report = () => {}) {
  report({ step: "bridge", text: "starting the bridge" });
  const { started, state } = await ensureBridge();
  const kind = state && state.device ? state.device.kind : "none";
  const model = state && state.device && state.device.model ? state.device.model : null;
  report({ step: "bridge", text: started ? "bridge started" : "bridge was already running" });

  let lights = "skipped";
  if (kind === "hid" || kind === "virtual") {
    try {
      await sayHello();
      lights = "sent";
    } catch (e) {
      lights = `failed: ${e.message}`;
    }
  }

  const destination = pickDestination(await siteFeatures());
  openInBrowser(destination.url);
  return {
    ok: true,
    bridge: started ? "started" : "already running",
    device: { kind, model },
    deviceError: kind === "hid" ? null : (state && state.deviceError) || null,
    lights,
    destination,
  };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".webp": "image/webp", ".png": "image/png" };

function createServer({ nonce = crypto.randomBytes(16).toString("hex"), run = go, onIdle = null } = {}) {
  let watchers = 0;
  let idleTimer = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const own = `http://127.0.0.1:${server.address().port}`;
    // A browser attaches Origin to every POST. A page on another origin is
    // refused here; a page on this one is the window itself.
    if (req.headers.origin && req.headers.origin !== own) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "origin not allowed" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8").replace(/__NONCE__/g, nonce);
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/pad.webp" || url.pathname === "/favicon.png")) {
      const file = url.pathname === "/pad.webp"
        ? path.join(HERE, "pad.webp")
        : path.join(APP_DIR, "public", "favicon.png");
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] });
      fs.createReadStream(file).pipe(res);
      return;
    }
    // The window holds this open for as long as it exists. When the last one
    // closes, the launcher has nothing left to serve and exits; the bridge
    // was started detached and keeps running.
    if (req.method === "GET" && url.pathname === `/${nonce}/alive`) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": open\n\n");
      watchers += 1;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      req.on("close", () => {
        watchers -= 1;
        if (watchers <= 0 && onIdle) idleTimer = setTimeout(onIdle, 3000);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === `/${nonce}/go`) {
      run()
        .then((result) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        })
        .catch((e) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  return { server, nonce };
}

function openWindow(url) {
  const browser = findAppBrowser();
  if (!browser) {
    openInBrowser(url);
    return;
  }
  spawn(browser, [`--app=${url}`, "--window-size=460,560"], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  }).unref();
}

function main() {
  const { server } = createServer({ onIdle: () => process.exit(0) });
  server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`micr0pad launcher window: ${url}`);
    openWindow(url);
  });
  // A window that never opened would leave this process behind forever.
  setTimeout(() => {
    server.getConnections((_, n) => { if (!n) process.exit(0); });
  }, 60000).unref();
}

if (require.main === module) main();

module.exports = {
  FAMILY, HELLO_KEYS, HOSTED_ORIGIN, FEATURE_ID,
  packed, pickDestination, findAppBrowser, createServer,
  ensureBridge, sayHello, siteFeatures,
};
