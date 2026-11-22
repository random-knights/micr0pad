#!/usr/bin/env node
"use strict";
// launcher.js - what the desktop shortcut runs. No window of its own.
//
//   node launcher/launcher.js        (or: npm run launcher)
//
// One double-click:
//   1. starts the bridge (bin/micr0pad.js) if nothing answers on its port,
//      and leaves it running;
//   2. shows the family colors on the six status keys, once, as a hello. The
//      bridge repaints the keys from agent state on its next poll, so the
//      hello lasts one poll interval and changes nothing that is saved;
//   3. opens the hosted pairing page when the site says that page is live,
//      and the local app otherwise. The site's own feature list decides, so
//      nothing here has to be edited on the day the page opens.
// Then it exits. If the bridge cannot be started it says so in a message box,
// because a shortcut that does nothing and says nothing is the worst outcome.
//
// What this file is NOT: a second way into the bridge. It adds no route and
// no header to server.js. It reads state the way the local page does, and it
// lights the keys through the same /api/light the local page uses, with the
// local token the bridge hands to its own origin. It runs on the machine the
// bridge runs on, as the same user, which is the trust the bridge already
// extends to anything that can read its config file.

const path = require("path");
const { spawn } = require("child_process");

const APP_DIR = path.join(__dirname, "..");
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

// Pure: where the click should land, given the site's feature list (or null
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

async function getJson(url, { headers = {}, timeoutMs = 4000, method = "GET", body } = {}) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
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

const DETACHED = { detached: true, stdio: "ignore", windowsHide: true };

function openInBrowser(url) {
  if (process.platform === "win32") {
    // rundll32 hands the URL to the default browser without a shell, so the
    // URL is one argument and never parsed as a command line.
    spawn("rundll32", ["url.dll,FileProtocolHandler", url], DETACHED).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], DETACHED).unref();
  } else {
    spawn("xdg-open", [url], DETACHED).unref();
  }
}

// The one thing this launcher ever puts on screen, and only on failure. The
// text travels in an environment variable, never in the command line, so
// nothing in an error message is parsed as script.
function showFailure(text) {
  if (process.platform !== "win32") return;
  spawn("powershell", [
    "-NoProfile", "-WindowStyle", "Hidden", "-Command",
    "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($env:RK_MICROPAD_LAUNCH_ERROR, 'micr0pad')",
  ], { ...DETACHED, env: { ...process.env, RK_MICROPAD_LAUNCH_ERROR: String(text).slice(0, 400) } }).unref();
}

// The whole double-click. `deps` exists so the test can run it with no
// bridge, no site and no browser.
async function go(deps = {}) {
  const ensure = deps.ensureBridge || ensureBridge;
  const hello = deps.sayHello || sayHello;
  const features = deps.siteFeatures || siteFeatures;
  const open = deps.openInBrowser || openInBrowser;

  const { started, state } = await ensure();
  const kind = state && state.device ? state.device.kind : "none";
  let lights = "skipped";
  if (kind === "hid" || kind === "virtual") {
    try {
      await hello();
      lights = "sent";
    } catch (e) {
      lights = `failed: ${e.message}`;
    }
  }
  const destination = pickDestination(await features());
  open(destination.url);
  return { bridge: started ? "started" : "already running", device: kind, lights, destination };
}

async function main() {
  try {
    const out = await go();
    console.log(`bridge ${out.bridge}; pad: ${out.device}; family colors: ${out.lights}; opened ${out.destination.url}`);
  } catch (e) {
    console.error(e.message);
    showFailure(`micr0pad could not start.\n\n${e.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  FAMILY, HELLO_KEYS, HOSTED_ORIGIN, FEATURE_ID,
  packed, pickDestination, go, ensureBridge, sayHello, siteFeatures,
};
