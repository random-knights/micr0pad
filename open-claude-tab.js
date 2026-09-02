"use strict";
// open-claude-tab.js - open a NEW Herdr tab running Claude Code.
// Uses the herdr CLI: creates a tab, then starts claude in its root pane.
// Usage: node open-claude-tab.js [cwd]
const { execFile } = require("child_process");

const cwd = process.argv[2] || "C:\\rand0m";

function run(args) {
  return new Promise((resolve, reject) => {
    execFile("herdr", args, { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || "").trim() || err.message));
      resolve(stdout);
    });
  });
}

(async () => {
  // Create a focused tab at the given cwd.
  const created = JSON.parse(await run(["tab", "create", "--cwd", cwd, "--label", "claude", "--focus"]));
  const pane = created.result && created.result.root_pane && created.result.root_pane.pane_id;
  if (!pane) throw new Error("no root pane in tab create response");
  // Start claude in the new pane. Agent name must be unique among live agents.
  const name = "claude" + Math.floor(Math.random() * 100000);
  await run(["agent", "start", name, "--kind", "claude", "--pane", pane]);
  console.log("Opened a new Herdr claude tab in " + cwd);
})().catch((e) => { console.error("FATAL: " + e.message); process.exit(1); });
