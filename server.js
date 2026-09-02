"use strict";
// server.js - serves the RK micropad UI + a JSON API for live state.
// Run: node server.js  then open http://localhost:PORT
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const config = require("./lib/config");
const { MicropadBridge } = require("./lib/bridge");

const PORT = process.env.RK_MICROPAD_PORT || 4120;
const PUBLIC = path.join(__dirname, "public");
const cfg = config.load();
config.writeExample();

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

// Read the top processes by memory (Windows tasklist CSV).
function readProcesses(limit) {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return resolve([]);
      const rows = [];
      for (const line of stdout.split("\n")) {
        // tasklist CSV: "Name","PID","Session Name","Session#","Mem Usage"
        const m = /^"([^"]*)","(\d+)","([^"]*)","(\d+)","([^"]*)"\s*$/.exec(line.trim());
        if (!m) continue;
        const memKb = parseInt(m[5].replace(/[, ]/g, ""), 10);
        rows.push({ name: m[1], pid: parseInt(m[2], 10), session: m[3], memKb: memKb || 0 });
      }
      rows.sort((a, b) => b.memKb - a.memKb);
      resolve(limit > 0 ? rows.slice(0, limit) : rows);
    });
  });
}

// One line of system metrics (CPU, RAM, disk, process count).
async function sysSnapshot() {
  const totalMem = os.totalmem(), freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const processes = await readProcesses(0);
  return {
    cpuPct: readCpu(),
    memUsedMb: Math.round(usedMem / 1048576),
    memTotalMb: Math.round(totalMem / 1048576),
    memPct: Math.round((usedMem / totalMem) * 100),
    processes: processes.length,
    hostname: HOSTNAME,
    uptimeSec: Math.round(os.uptime()),
  };
}

const launcher = require("./lib/launcher");
const bridge = new MicropadBridge(cfg);
bridge.start();

// SSE clients: the web UI subscribes so it can react to device key presses
// (talk toggle, action runs) without polling.
const sseClients = new Set();
bridge.on("notice", (n) => broadcast({ type: "notice", text: n.text }));
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
  if (!action || action.type !== "cmd" || !action.cmd) return { ok: false, error: "no cmd configured" };
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "GET" && p.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (p === "/api/state") {
      const assigned = bridge.lastAssigned.map((x) => ({
        slot: x.slotCfg.slot,
        name: x.slotCfg.name,
        keyID: config_agentKeyIDs()[x.slotCfg.slot],
        agent: x.agent ? { agent: x.agent.agent, status: require("./lib/herdr").statusOf(x.agent), focused: x.agent.focused, cwd: x.agent.cwd, paneID: x.agent.paneID } : null,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        deviceUp: bridge.deviceUp(), deviceError: bridge.deviceError, pairing: !!bridge.pairing,
        hostname: HOSTNAME,
        config: cfg, assigned,
      }));
      return;
    }
    if (p === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cfg));
      return;
    }
    // The effect list the outer-light animation picker renders from, so the UI
    // never hardcodes a set the firmware might not have.
    if (p === "/api/underglow/effects") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ effects: require("./lib/pad").underglowEffects }));
      return;
    }
    if (p === "/api/debug") {
      const herdr = require("./lib/herdr");
      const aieds = require("./lib/aieds");
      Promise.all([herdr.listAgents().catch(() => []), aieds.summary().catch(() => null)])
        .then(([agents, aiedsSummary]) => {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ agents, aieds: aiedsSummary }));
        })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); });
      return;
    }
    if (p === "/api/aieds/series") {
      const aieds = require("./lib/aieds");
      aieds.series(30)
        .then((series) => { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify({ series })); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); });
      return;
    }
    if (p === "/api/sys") {
      sysSnapshot()
        .then((s) => { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(s)); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); });
      return;
    }
    // The table scrolls, so send a useful depth rather than a screenful.
    if (p === "/api/sys/procs") {
      readProcesses(25)
        .then((procs) => { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify({ procs })); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); });
      return;
    }
    // Does a keymap backup exist, and from when? Drives which of the two
    // device buttons the UI shows.
    if (p === "/api/keymap/backup-info") {
      const file = require("path").join(__dirname, "keymap-backup.json");
      let info = { exists: false };
      try {
        const stat = fs.statSync(file);
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        info = { exists: true, savedAt: stat.mtime.toISOString(), bytes: (raw.data || "").length };
      } catch (_) { /* no backup yet */ }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(info));
      return;
    }
    res.writeHead(404); res.end();
    return;
  }

  // End a process (taskkill /PID <pid> /F). Owner-only action from the UI.
  if (req.method === "POST" && p === "/api/sys/kill") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { pid } = JSON.parse(body || "{}");
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("valid pid required");
        execFile("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
          if (err) { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify({ ok: false, error: (stderr || err.message).trim() })); return; }
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, pid }));
        });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
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
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true, config: saved }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // PAIRING MODE
  // Bluetooth pairing is a firmware behaviour: hold the touch sensor 3s, the
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
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
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
      const file = require("path").join(__dirname, "keymap-backup.json");
      let force = false;
      try { force = !!JSON.parse(body || "{}").force; } catch (_) {}
      if (fs.existsSync(file) && !force) {
        res.writeHead(409, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "a backup already exists; refusing to overwrite the original" }));
        return;
      }
      if (!bridge.dev) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "device not connected" }));
        return;
      }
      try {
        const raw = await bridge.dev.call("fs.read", { file: "keymap.json" });
        fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf8");
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
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
      const file = require("path").join(__dirname, "keymap-backup.json");
      if (!fs.existsSync(file)) {
        res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "no keymap-backup.json to restore from" }));
        return;
      }
      if (!bridge.dev) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "device not connected" }));
        return;
      }
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!raw.data) throw new Error("backup has no .data string");
        await bridge.dev.call("fs.write", { file: "keymap.json", data: raw.data });
        // The firmware returns ok for anything, so read it back and compare.
        const after = await bridge.dev.call("fs.read", { file: "keymap.json" });
        const identical = after.data === raw.data;
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
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
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
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
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
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
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Judge/Janitor: send a command to the currently focused Herdr tab's agent.
  if (req.method === "POST" && p === "/api/send") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { command } = JSON.parse(body || "{}");
        if (!command) throw new Error("command required");
        bridge.sendToFocused(command)
          .then((r) => { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(r)); })
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
          .then(() => { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify({ ok: true })); })
          .catch((err) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: err.message })); });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Debug data: herdr agent status/cwd for all + AIEDS aggregate for claude.
  // (GET handler lives in the /api/ GET block above.)

  if (req.method === "POST" && p === "/api/talk") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const { active } = JSON.parse(body || "{}");
        const state = bridge.setTalk(!!active);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
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
          .then(() => { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify({ ok: true })); })
          .catch((err) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: err.message })); });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  serveStatic(req, res, p === "/" ? "/index.html" : p);
});

// expose raw key ids for the state endpoint without re-importing pad
function config_agentKeyIDs() { return require("./lib/pad").agentKeyIDs; }

server.listen(PORT, () => {
  console.log(`RK MicroPad server on http://localhost:${PORT}`);
  console.log(`device: ${bridge.deviceUp() ? "connected" : "NOT connected"}`);
  if (!bridge.deviceUp()) console.log(`  error: ${bridge.deviceError}`);
});
