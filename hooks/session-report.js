#!/usr/bin/env node
"use strict";
/*
 * session-report.js - tell the local micr0pad bridge what this agent session
 * is doing, so its status key lights without Herdr.
 *
 *   node hooks/session-report.js <provider>      (payload as JSON on stdin)
 *
 * WHAT THIS IS
 * A hook target. The agent runs it at the moments its state changes and hands
 * it a small JSON payload on stdin. For Claude Code that payload names the
 * event (hook_event_name), the session (session_id) and the folder (cwd).
 * This script turns the event into one of four states and POSTs it to
 * http://localhost:<port>/api/session on the same machine.
 *
 * WHAT IT SENDS
 * provider, session id, state, the folder path and the folder's name. That is
 * the whole body. It never opens the transcript, and it sends no prompt, no
 * tool input and no tool output: it does not read them.
 *
 * WHAT IT COSTS
 * No model call and no network beyond localhost. One short node process per
 * event. If the bridge is not running the request fails in well under a
 * second and nothing happens.
 *
 * IT MUST NEVER GET IN THE WAY
 * Every path exits 0 and prints nothing. A hook that fails or talks can block
 * or confuse the session it is attached to, and a status light is not worth
 * that. Errors are swallowed on purpose.
 *
 * THE TOKEN
 * /api/session is a mutating route, so it takes the bridge's local pairing
 * token. This script reads it from the bridge's own config.json, as the same
 * user on the same machine, and sends it in one header. It is never printed.
 */
const fs = require("fs");
const path = require("path");

const PORT = process.env.RK_MICROPAD_PORT || 4120;
const BRIDGE = `http://localhost:${PORT}`;
const TIMEOUT_MS = 800;

// Claude Code event -> pad state. null means "this event says nothing about
// state", and nothing is sent.
//
//   SessionStart       the session exists and is waiting       idle
//   UserPromptSubmit   a turn began                            working
//   PreToolUse         a tool is about to run                  working
//   PostToolUse        a tool finished (also: an approval was  working
//                      granted and the tool has now run)
//   PermissionRequest  it stopped to ask                       blocked
//   Notification       permission or a question for the user   blocked
//                      the idle reminder                       (nothing: Stop
//                                                              already said done)
//   Stop               the turn finished                       done
//   SessionEnd         the session closed                      gone
function claudeStatus(payload) {
  const p = payload || {};
  switch (p.hook_event_name) {
    case "SessionStart": return "idle";
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse": return "working";
    case "PermissionRequest": return "blocked";
    case "Notification": {
      const type = String(p.notification_type || "").toLowerCase();
      if (type === "permission_prompt" || type === "elicitation_dialog") return "blocked";
      if (type) return null;
      // Older builds send no type, only a sentence.
      return /permission|approval|approve|waiting for your input/i.test(String(p.message || "")) && !/idle/i.test(String(p.message || ""))
        ? "blocked"
        : null;
    }
    case "Stop": return "done";
    case "SessionEnd": return "gone";
    default: return null;
  }
}

const MAPPERS = { claude: claudeStatus };

// Pure: the body to send, or null when there is nothing to say.
function reportFor(provider, payload) {
  const mapper = MAPPERS[provider];
  if (!mapper || !payload || typeof payload !== "object") return null;
  const status = mapper(payload);
  const id = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!status || !id) return null;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  return { provider, id, status, cwd, title: cwd ? path.basename(cwd) : "" };
}

function readToken() {
  const { CONFIG_PATH } = require("../lib/config");
  const token = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).pairingToken;
  return typeof token === "string" ? token : "";
}

async function send(body) {
  const token = readToken();
  if (!token) return;
  await fetch(`${BRIDGE}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BRIDGE, "X-Pairing-Token": token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { if (text.length < 1 << 20) text += c; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });
}

async function main() {
  try {
    const provider = String(process.argv[2] || "").toLowerCase();
    const payload = JSON.parse((await readStdin()) || "{}");
    const body = reportFor(provider, payload);
    if (body) await send(body);
  } catch (_) {
    // Silent by design: see IT MUST NEVER GET IN THE WAY above.
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { claudeStatus, reportFor, MAPPERS };
