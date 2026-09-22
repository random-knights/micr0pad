"use strict";
// herdr.js - read live agent state from Herdr via the CLI.
// Uses `herdr agent list` (JSON on stdout), which is the same state the
// micro-manager bridge reads over its socket, and works on any machine with
// the herdr CLI on its PATH (or at HERDR_BIN_PATH).
const { execFile } = require("child_process");

function herdrCmd() {
  // allow override; fall back to PATH
  return process.env.HERDR_BIN_PATH || "herdr";
}

// `execImpl` defaults to the real child_process.execFile; tests inject a
// fake so the parser can be proven against recorded output (and the
// missing-binary path) without shelling out. Production call sites are
// unchanged: listAgents() with no argument behaves exactly as before.
function listAgents(execImpl = execFile) {
  return new Promise((resolve, reject) => {
    execImpl(herdrCmd(), ["agent", "list"], { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // herdr.exe prints a lot to stderr on Windows; only surface a real failure
        return reject(new Error(`herdr agent list failed: ${err.message} ${(stderr || "").slice(0, 200)}`));
      }
      let parsed;
      try { parsed = JSON.parse(stdout); } catch (e) { return reject(new Error("herdr agent list returned non-JSON")); }
      const result = parsed.result || parsed;
      const agents = Array.isArray(result) ? result : result.agents;
      if (!Array.isArray(agents)) return reject(new Error("herdr agent list: no agents array"));
      resolve(agents.map(normalizeAgent));
    });
  });
}

function normalizeAgent(a) {
  return {
    agent: a.agent || "agent",
    status: a.agent_status || "unknown",
    focused: !!a.focused,
    cwd: a.cwd,
    foregroundCwd: a.foreground_cwd,
    paneID: a.pane_id,
    tabID: a.tab_id,
    terminalID: a.terminal_id,
    title: a.terminal_title_stripped || a.terminal_title || "",
  };
}

// Returns the status state we use for the pad, mapped from Herdr's vocabulary.
// Herdr reports idle / working / blocked / done (and variants). We keep the raw
// status; the mapper translates anything unrecognized to "unknown".
function statusOf(agent) {
  const s = (agent.status || "").toLowerCase();
  if (["blocked", "working", "done", "idle"].includes(s)) return s;
  return "unknown";
}

// The currently focused agent (the one the user is looking at in Herdr).
function focusedAgent() {
  return listAgents().then((agents) => agents.find((a) => a.focused) || null);
}

// Submit a prompt to a specific agent pane (by pane id or agent name).
function prompt(target, text) {
  return new Promise((resolve, reject) => {
    execFile(herdrCmd(), ["agent", "prompt", target, text], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || "").trim() || err.message));
      resolve(stdout);
    });
  });
}

// Send a navigation key to a pane via herdr pane send-keys.
// Herdr's send-keys accepts canonical key names (esc, enter, tab, arrows, etc.).
function navigate(pane, direction) {
  const key = { "tab-prev": "ctrl+shift+[", "tab-next": "ctrl+shift+]", "pane-prev": "ctrl+alt+left", "pane-next": "ctrl+alt+right" }[direction];
  return new Promise((resolve, reject) => {
    execFile(herdrCmd(), ["pane", "send-keys", pane, key], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || "").trim() || err.message));
      resolve(stdout);
    });
  });
}

// cd an agent's terminal into a folder: send literal text `cd <path>` then Enter.
function cd(pane, cwd) {
  return new Promise((resolve, reject) => {
    execFile(herdrCmd(), ["pane", "send-text", pane, `cd ${cwd}`], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || "").trim() || err.message));
      execFile(herdrCmd(), ["pane", "send-keys", pane, "enter"], { windowsHide: true, timeout: 15000 }, (err2, out2, err2s) => {
        if (err2) return reject(new Error((err2s || "").trim() || err2.message));
        resolve(out2);
      });
    });
  });
}

// Focus an agent's tab in Herdr so the user lands on it. Accepts a pane id or
// an agent name; herdr resolves it. Used by the device agent keys.
function focus(target) {
  return new Promise((resolve, reject) => {
    execFile(herdrCmd(), ["agent", "focus", target], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || "").trim() || err.message));
      resolve(stdout);
    });
  });
}

module.exports = { listAgents, statusOf, herdrCmd, focusedAgent, prompt, navigate, cd, focus };
