"use strict";
// Sessions that report themselves (lib/sessions.js, hooks/session-report.js,
// scripts/session-hooks.js). What these hold:
//
//   - a report is a provider, an id and one of four states, and nothing else
//     gets in;
//   - a session leaves when it says so or when it goes quiet;
//   - a Claude Code event maps to the state the table in the hook says;
//   - the bridge lights a reported session on the same keys Herdr agents use;
//   - the settings installer adds and removes only its own entries.
//
// No bridge is started, no hook is run and no settings file is touched.

const test = require("node:test");
const assert = require("node:assert");
const { Sessions, MAX_SESSIONS } = require("../lib/sessions");
const { claudeStatus, reportFor } = require("../hooks/session-report");
const hooks = require("../scripts/session-hooks");
const { MicropadBridge } = require("../lib/bridge");
const mapper = require("../lib/mapper");
const pad = require("../lib/pad");

test("a report lands in the roster in the shape the mapper reads", () => {
  const s = new Sessions();
  assert.deepEqual(s.report({ provider: "claude", id: "abc", status: "working", cwd: "/work/site", title: "site" }, 1000), { ok: true, changed: true });
  assert.deepEqual(s.list(1000), [{
    agent: "claude", status: "working", focused: false, cwd: "/work/site", foregroundCwd: "/work/site",
    paneID: null, tabID: null, terminalID: null, title: "site", sessionID: "abc", source: "session",
  }]);
});

test("the same state twice is not a change, a new state is", () => {
  const s = new Sessions();
  s.report({ provider: "claude", id: "a", status: "working" }, 1);
  assert.equal(s.report({ provider: "claude", id: "a", status: "working" }, 2).changed, false);
  assert.equal(s.report({ provider: "claude", id: "a", status: "blocked" }, 3).changed, true);
  assert.equal(s.list(3)[0].status, "blocked");
});

test("a later report without a folder keeps the folder it had", () => {
  const s = new Sessions();
  s.report({ provider: "claude", id: "a", status: "idle", cwd: "/work/site", title: "site" }, 1);
  s.report({ provider: "claude", id: "a", status: "working" }, 2);
  assert.equal(s.list(2)[0].cwd, "/work/site");
  assert.equal(s.list(2)[0].title, "site");
});

test("gone removes the session, and gone for a stranger changes nothing", () => {
  const s = new Sessions();
  s.report({ provider: "claude", id: "a", status: "done" }, 1);
  assert.deepEqual(s.report({ provider: "claude", id: "nobody", status: "gone" }, 2), { ok: true, changed: false });
  assert.deepEqual(s.report({ provider: "claude", id: "a", status: "gone" }, 3), { ok: true, changed: true });
  assert.deepEqual(s.list(3), []);
});

test("a session that goes quiet is dropped after staleMs", () => {
  const s = new Sessions({ staleMs: 60000 });
  s.report({ provider: "claude", id: "a", status: "working" }, 0);
  assert.equal(s.list(60000).length, 1, "exactly at the limit it is still there");
  assert.equal(s.list(60001).length, 0);
});

test("sessions keep first-seen order, so a session keeps its key", () => {
  const s = new Sessions();
  s.report({ provider: "claude", id: "first", status: "working" }, 1);
  s.report({ provider: "claude", id: "second", status: "working" }, 2);
  s.report({ provider: "claude", id: "first", status: "done" }, 3);
  assert.deepEqual(s.list(3).map((a) => a.sessionID), ["first", "second"]);
});

test("a malformed report is refused and stores nothing", () => {
  const s = new Sessions();
  const bad = [
    null,
    {},
    { provider: "claude", status: "working" },
    { provider: "Claude Code!", id: "a", status: "working" },
    { provider: "claude", id: "a", status: "thinking" },
    { provider: "claude", id: "a" },
    { provider: 7, id: "a", status: "working" },
  ];
  for (const r of bad) assert.equal(s.report(r, 1).ok, false, JSON.stringify(r));
  assert.deepEqual(s.list(1), []);
});

test("text fields are cut to length and lose control characters", () => {
  const s = new Sessions();
  s.report({ provider: "claude", id: "a", status: "idle", cwd: "x".repeat(900), title: "one\ntwo\u0000" + "y".repeat(300) }, 1);
  const [a] = s.list(1);
  assert.equal(a.cwd.length, 400);
  assert.equal(a.title.length, 120);
  assert.ok(!/[\u0000-\u001f]/.test(a.title));
});

test("the roster is capped", () => {
  const s = new Sessions();
  for (let i = 0; i < MAX_SESSIONS; i++) assert.equal(s.report({ provider: "claude", id: "s" + i, status: "idle" }, 1).ok, true);
  assert.deepEqual(s.report({ provider: "claude", id: "one-too-many", status: "idle" }, 1), { ok: false, error: "too many sessions" });
});

test("each Claude Code event maps to the state the hook documents", () => {
  const cases = [
    [{ hook_event_name: "SessionStart" }, "idle"],
    [{ hook_event_name: "UserPromptSubmit" }, "working"],
    [{ hook_event_name: "PreToolUse" }, "working"],
    [{ hook_event_name: "PostToolUse" }, "working"],
    [{ hook_event_name: "PermissionRequest" }, "blocked"],
    [{ hook_event_name: "Notification", notification_type: "permission_prompt" }, "blocked"],
    [{ hook_event_name: "Notification", notification_type: "elicitation_dialog" }, "blocked"],
    [{ hook_event_name: "Notification", notification_type: "idle_prompt" }, null],
    [{ hook_event_name: "Notification", notification_type: "auth_success" }, null],
    [{ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }, "blocked"],
    [{ hook_event_name: "Notification", message: "Claude has been idle and is waiting for your input" }, null],
    [{ hook_event_name: "Stop" }, "done"],
    [{ hook_event_name: "SessionEnd" }, "gone"],
    [{ hook_event_name: "PreCompact" }, null],
    [{}, null],
  ];
  for (const [payload, want] of cases) assert.equal(claudeStatus(payload), want, JSON.stringify(payload));
});

test("the hook's body is provider, id, state, folder and folder name, and nothing else", () => {
  const body = reportFor("claude", {
    hook_event_name: "PreToolUse", session_id: "abc", cwd: "/work/site",
    transcript_path: "/somewhere/t.jsonl", tool_name: "Bash", tool_input: { command: "echo secret" }, prompt: "do the thing",
  });
  assert.deepEqual(body, { provider: "claude", id: "abc", status: "working", cwd: "/work/site", title: "site" });
});

test("the hook says nothing without a session id, a state, or a provider it knows", () => {
  assert.equal(reportFor("claude", { hook_event_name: "PreToolUse" }), null);
  assert.equal(reportFor("claude", { hook_event_name: "PreCompact", session_id: "abc" }), null);
  assert.equal(reportFor("someone-else", { hook_event_name: "PreToolUse", session_id: "abc" }), null);
  assert.equal(reportFor("claude", null), null);
});

const herdrWith = (agents) => ({
  listAgents: async () => agents,
  statusOf: require("../lib/herdr").statusOf,
  focusedAgent: async () => null,
  focus: async () => { throw new Error("focus must not be called for a session with no tab"); },
  prompt: async () => {},
  navigate: async () => {},
});

function bridgeWith(sessions, herdrAgents = []) {
  const cfg = { pollIntervalMs: 2500, slots: pad.defaultSlots, statusColors: pad.statusColors, underglow: pad.underglow, actions: {} };
  const bridge = new MicropadBridge(cfg, {
    openHid: () => { throw new Error("no pad"); },
    herdr: herdrWith(herdrAgents),
    sessions,
  });
  const states = [];
  const notices = [];
  bridge.on("state", (s) => states.push(s));
  bridge.on("notice", (n) => notices.push(n.text));
  return { bridge, states, notices };
}

test("a reported Claude session lights the first claude key, with no Herdr at all", async () => {
  const sessions = new Sessions();
  sessions.report({ provider: "claude", id: "abc", status: "working", cwd: "/work/site", title: "site" });
  const { bridge, states } = bridgeWith(sessions);
  await bridge.refresh();
  const [slot0, slot1] = states[0].assigned;
  assert.deepEqual(slot0.agent, { agent: "claude", status: "working", focused: false, cwd: "/work/site", paneID: null, title: "site", source: "session" });
  assert.equal(slot0.light, "#ff4124", "working wears the slot's own color");
  assert.equal(slot1.agent, null, "one session, one key");
  const key0 = bridge.dev.snapshot().threads.find((t) => t.id === 0);
  assert.equal(key0.e, pad.statusColors.working.effect, "and pulses");
});

test("a blocked session turns its key the blocked color, whatever the slot color", async () => {
  const sessions = new Sessions();
  sessions.report({ provider: "claude", id: "abc", status: "blocked" });
  const { bridge, states } = bridgeWith(sessions);
  await bridge.refresh();
  assert.equal(states[0].assigned[0].light, "#ff2d2d");
  const key0 = bridge.dev.snapshot().threads.find((t) => t.id === 0);
  assert.equal(key0.e, pad.statusColors.blocked.effect);
  assert.equal(bridge.dev.snapshot().zones.ambient.c, pad.statusColors.blocked.color, "the outer light follows");
});

test("Herdr agents take keys first, reported sessions take the next ones", async () => {
  const sessions = new Sessions();
  sessions.report({ provider: "claude", id: "abc", status: "done" });
  const fromHerdr = { agent: "claude", status: "working", focused: true, cwd: "/h", paneID: "p1", title: "herdr one" };
  const { bridge, states } = bridgeWith(sessions, [fromHerdr]);
  await bridge.refresh();
  assert.equal(states[0].assigned[0].agent.source, "herdr");
  assert.equal(states[0].assigned[1].agent.source, "session");
});

test("a session that says gone gives its key back to the resting color", async () => {
  const sessions = new Sessions();
  sessions.report({ provider: "codex", id: "x", status: "working" });
  const { bridge, states } = bridgeWith(sessions);
  await bridge.refresh();
  assert.equal(states[0].assigned[2].agent.agent, "codex");
  sessions.report({ provider: "codex", id: "x", status: "gone" });
  await bridge.refresh();
  assert.equal(states[1].assigned[2].agent, null);
  assert.equal(states[1].assigned[2].light, "#ff4124");
});

test("pressing the key of a session with no Herdr tab says so and focuses nothing", async () => {
  const sessions = new Sessions();
  sessions.report({ provider: "claude", id: "abc", status: "working" });
  const { bridge, notices } = bridgeWith(sessions);
  await bridge.refresh();
  await bridge.focusAgentForSlot(0);
  assert.ok(notices.includes("claude 1 is not in Herdr, so there is no tab to focus"));
});

test("blocked is the one state that overrides a slot color", () => {
  const slot = { slot: 0, color: "#00ff00" };
  assert.equal(mapper.threadFor({ status: "blocked" }, slot).c, pad.statusColors.blocked.color);
  for (const status of ["working", "done", "idle"]) assert.equal(mapper.threadFor({ status }, slot).c, 0x00ff00, status);
});

test("working and done differ on the pad even when the slot color is the same", () => {
  const slot = { slot: 0, color: "#ff4124" };
  assert.notEqual(mapper.threadFor({ status: "working" }, slot).e, mapper.threadFor({ status: "done" }, slot).e);
});

test("the installer adds one entry per event and leaves other hooks alone", () => {
  const mine = { type: "command", command: "node other.js" };
  const before = { model: "x", hooks: { SessionEnd: [{ hooks: [mine] }], PreCompact: [{ hooks: [mine] }] } };
  const after = hooks.withHooks(before, 'node "/app/hooks/session-report.js" claude');
  assert.equal(after.model, "x");
  assert.deepEqual(before.hooks.SessionEnd, [{ hooks: [mine] }], "the input is not mutated");
  for (const event of hooks.EVENTS) {
    const ours = after.hooks[event].flatMap((g) => g.hooks).filter(hooks.isOurs);
    assert.equal(ours.length, 1, event);
  }
  assert.deepEqual(after.hooks.SessionEnd[0], { hooks: [mine] }, "the hook that was there is still first");
  assert.deepEqual(after.hooks.PreCompact, [{ hooks: [mine] }]);
});

test("installing twice is the same as installing once, and removing puts it back", () => {
  const mine = { type: "command", command: "node other.js" };
  const before = { hooks: { SessionEnd: [{ hooks: [mine] }] } };
  const command = 'node "/app/hooks/session-report.js" claude';
  const once = hooks.withHooks(before, command);
  assert.deepEqual(hooks.withHooks(once, command), once);
  assert.deepEqual(hooks.without(once), before);
  assert.deepEqual(hooks.without(hooks.withHooks({}, command)), {}, "an empty file goes back to empty");
});

test("the hook command quotes the path and names the provider", () => {
  const command = hooks.hookCommand("/opt/micr0pad");
  assert.match(command, /^node ".*\/hooks\/session-report\.js" claude$/);
  assert.ok(!command.includes("\\"), "forward slashes only");
});
