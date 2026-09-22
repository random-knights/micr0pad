"use strict";
// smoke-pack.js - install the packed tarball the way a stranger would and
// prove the bin starts the server.
//
//   1. `npm pack` this checkout into a scratch folder;
//   2. `npm install` that tarball into an EMPTY folder, from the registry for
//      its dependencies, so node-hid arrives as its prebuilt binary;
//   3. run the `micr0pad` bin there with RK_MICROPAD_NO_DEVICE=1, so no HID
//      handle is ever opened, on a scratch port;
//   4. poll GET /api/state until it answers 200, check the first-run
//      config.json was written inside the installed package, then stop it.
//
// It also reports whether node-hid had to be compiled (a build/ folder) or
// used a prebuilt binary, because "installs with no toolchain" is the claim.
// It never prints config.json: that file holds the pairing token.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.SMOKE_PORT || 4199);
const DEADLINE_MS = 60000;
const WIN = process.platform === "win32";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: WIN });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout;
}

function getState() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/state", timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ code: res.statusCode, json });
      });
    });
    req.on("error", () => resolve({ code: 0, json: null }));
    req.on("timeout", () => { req.destroy(); resolve({ code: 0, json: null }); });
  });
}

function stop(child) {
  if (child.exitCode !== null) return;
  if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else {
    try { process.kill(-child.pid, "SIGTERM"); } catch (_) { child.kill("SIGTERM"); }
  }
}

// Run the installed bin until /api/state answers 200, then stop it.
async function boot(appDir, scratch, noDevice) {
  const env = Object.assign({}, process.env, {
    RK_MICROPAD_PORT: String(PORT),
    AIEDS_LOG_PATH: path.join(scratch, "aieds-local.jsonl"),
  });
  delete env.RK_MICROPAD_CONFIG;
  if (noDevice) env.RK_MICROPAD_NO_DEVICE = "1";
  else delete env.RK_MICROPAD_NO_DEVICE;
  const child = spawn("npx", ["--no", "micr0pad"], { cwd: appDir, env, shell: WIN, detached: !WIN, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });

  const start = Date.now();
  let state = { code: 0, json: null };
  while (Date.now() - start < DEADLINE_MS && child.exitCode === null) {
    state = await getState();
    if (state.code === 200) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  stop(child);
  if (state.code !== 200) {
    throw new Error(`the bin never answered /api/state 200 (last ${state.code}, exit ${child.exitCode}):\n${output}`);
  }
  console.log(`GET /api/state -> 200 after ${Date.now() - start} ms`);
  const lines = output.split("\n").filter((l) => l.trim() && !/token/i.test(l)).slice(0, 6);
  console.log(`bin output:\n  ${lines.join("\n  ")}`);
  return state.json;
}

function install(scratch, name, tarball, extra) {
  const appDir = path.join(scratch, name);
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, "package.json"), '{ "private": true }\n');
  run("npm", ["install", "--no-audit", "--no-fund", ...extra, tarball], appDir);
  return appDir;
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "micr0pad-smoke-"));
  const packDir = path.join(scratch, "pack");
  fs.mkdirSync(packDir);

  const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], ROOT)
    .replace(/^[^[]*/, ""))[0];
  const tarball = path.join(packDir, packed.filename);
  console.log(`packed ${packed.name}@${packed.version}: ${packed.entryCount} files, ${packed.size} bytes`);

  // Phase 1: a normal install, the bin with the device disabled.
  const appDir = install(scratch, "app", tarball, []);
  const installed = path.join(appDir, "node_modules", ...packed.name.split("/"));
  const hid = path.join(appDir, "node_modules", "node-hid");
  if (!fs.existsSync(hid)) {
    console.log("node-hid: not installed (optional dependency skipped); the virtual pad is the only pad");
  } else if (fs.existsSync(path.join(hid, "build"))) {
    console.log("node-hid: COMPILED from source (build/ exists), so this platform needed a toolchain");
  } else {
    const prebuilds = fs.readdirSync(path.join(hid, "prebuilds"));
    const mine = prebuilds.filter((d) => d.includes(`${process.platform}-${process.arch}`));
    console.log(`node-hid: prebuilt binary, no compile (${mine.join(", ") || "none matched " + process.platform + "-" + process.arch})`);
  }
  if (fs.existsSync(path.join(installed, "config.json"))) {
    throw new Error("the tarball shipped a config.json");
  }
  await boot(appDir, scratch, true);
  if (!fs.existsSync(path.join(installed, "config.json"))) {
    throw new Error("the first run did not write config.json in the installed package");
  }
  console.log("first-run config.json written inside the installed package (contents not printed)");

  // Phase 2, CI only: no native module at all (node-hid omitted, as npm does
  // when a platform has no prebuilt binary and no compiler), and the device
  // path left ON. With node-hid absent there is nothing that can open a HID
  // handle, and the app must fall back to the virtual pad. Skipped outside CI
  // so a developer's machine never runs the device path from this script.
  if (process.env.CI === "true") {
    const bare = install(scratch, "bare", tarball, ["--omit=optional"]);
    if (fs.existsSync(path.join(bare, "node_modules", "node-hid"))) {
      throw new Error("--omit=optional still installed node-hid");
    }
    const state = await boot(bare, scratch, false);
    const kind = state && state.device && state.device.kind;
    if (kind !== "virtual") throw new Error(`expected the virtual pad with no node-hid, got ${JSON.stringify(state && state.device)}`);
    console.log("no native module: the virtual pad is serving");
  } else {
    console.log("no-native-module phase skipped (runs in CI only)");
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("smoke passed");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
