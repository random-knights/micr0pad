#!/usr/bin/env node
"use strict";
// launcher.js - what the desktop shortcut runs. No window of its own.
//
//   node launcher/launcher.js        (or: npm run launcher)
//
// One double-click:
//   1. starts the bridge (bin/micr0pad.js) if nothing answers on its port,
//      and leaves it running;
//   2. opens the hosted pairing page when the site says that page is live,
//      and the local app otherwise. The site's own feature list decides, so
//      nothing here has to be edited on the day the page opens.
// Then it exits. If the bridge cannot be started it says so in a message box,
// because a shortcut that does nothing and says nothing is the worst outcome.
//
// The family colors on the keys are the bridge's own doing (lib/mapper.js
// rests an empty slot in its family color), so they are there for as long as
// the bridge runs and this file sends no light at all.
//
// What this file is NOT: a second way into the bridge. It adds no route and
// no header to server.js, and the only thing it asks the bridge is the public
// /api/state, to learn whether it is up.

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
  const features = deps.siteFeatures || siteFeatures;
  const open = deps.openInBrowser || openInBrowser;

  const { started, state } = await ensure();
  const kind = state && state.device ? state.device.kind : "none";
  const destination = pickDestination(await features());
  open(destination.url);
  return { bridge: started ? "started" : "already running", device: kind, destination };
}

async function main() {
  try {
    const out = await go();
    console.log(`bridge ${out.bridge}; pad: ${out.device}; opened ${out.destination.url}`);
  } catch (e) {
    console.error(e.message);
    showFailure(`micr0pad could not start.\n\n${e.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  HOSTED_ORIGIN, FEATURE_ID,
  pickDestination, go, ensureBridge, siteFeatures,
};
