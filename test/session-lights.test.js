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
  assert.deepEqual(s.report({ provider: "claude", id: "abc", status: "working", cwd: "/work/site", title: "site" }, 1000), { ok: true, changed: true, wantWindow: true });
  assert.deepEqual(s.list(1000), [{
    agent: "claude", status: "working", focused: false, cwd: "/work/site", foregroundCwd: "/work/site",
    paneID: null, tabID: null, terminalID: null, title: "site", sessionID: "abc", windowPid: 0, source: "session",
  }]);
});

test("the bridge asks for the window once, and stops asking when told there is none", () => {
  const s = new Sessions();
  assert.equal(s.report({ provider: "claude", id: "a", status: "idle" }, 1).wantWindow, true);
  assert.equal(s.report({ provider: "claude", id: "a", status: "idle", windowPid: 4242 }, 2).wantWindow, false);
  assert.equal(s.report({ provider: "claude", id: "a", status: "working" }, 3).wantWindow, false, "a later report keeps it");
  assert.equal(s.list(3)[0].windowPid, 4242);
  assert.equal(s.report({ provider: "claude", id: "b", status: "idle", windowPid: 0 }, 4).wantWindow, false, "0 is an answer: none");
  assert.equal(s.report({ provider: "claude", id: "c", status: "idle", windowPid: -5 }, 5).wantWindow, true, "a bad pid is no answer");
  assert.equal(s.report({ provider: "claude", id: "d", status: "idle", windowPid: "12" }, 6).wantWindow, true);
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
  assert.equal(s.report({ provider: "claude", id: "a", status: "gone" }, 4).wantWindow, undefined, "a closing session is not asked for its window");
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

function bridgeWith(sessions, herdrAgents = [], raiseResult = null) {
  const cfg = { pollIntervalMs: 2500, slots: pad.defaultSlots, statusColors: pad.statusColors, underglow: pad.underglow, actions: {} };
  const raised = [];
  const bridge = new MicropadBridge(cfg, {
    openHid: () => { throw new Error("no pad"); },
    herdr: herdrWith(herdrAgents),
    sessions,
    raiseWindow: (pid, done) => { raised.push(pid); done(raiseResult); },
  });
  const states = [];
  const notices = [];
  bridge.on("state", (s) => states.push(s));
  bridge.on("notice", (n) => notices.push(n.text));
  return { bridge, states, notices, raised };
}

test("a reported Claude session lights the first claude key, with no Herdr at all", async () => {
  const sessions = new Sessions();
  sessions.report({ provider: "claude", id: "abc", status: "working", cwd: "/work/site", title: "site" });
  const { bridge, states } = bridgeWith(sessions);
  await bridge.refresh();
  const [slot0, slot1] = states[0].assigned;
  assert.deepEqual(slot0.agent, { agent: "claude", status: "working", focused: false, cwd: "/work/site", paneID: null, title: "site", source: "session" }, "and no process id goes to the page");
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

test("pressing the key of a reported session brings its window forward, never through Herdr", async () => {
  const sessions = new Sessions();
  sessions.report({ provider: "claude", id: "abc", status: "working", windowPid: 4242 });
  const { bridge, notices, raised } = bridgeWith(sessions);
  await bridge.refresh();
  assert.deepEqual(await bridge.focusAgentForSlot(0), { ok: true, text: "opened claude 1" });
  assert.deepEqual(raised, [4242]);
  assert.ok(notices.includes("opened claude 1"));
});

test("a session whose window is not known yet says so and raises nothing", async () => {
  const sessions = new Sessions();
  sessions.report({ provider: "claude", id: "abc", status: "working" });
  const { bridge, raised } = bridgeWith(sessions);
  await bridge.refresh();
  assert.deepEqual(await bridge.focusAgentForSlot(0), { ok: false, text: "claude 1 has not said which window it is in yet" });
  assert.deepEqual(raised, []);
});

test("a window that will not come forward is reported, not swallowed", async () => {
  const sessions = new Sessions();
  sessions.report({ provider: "claude", id: "abc", status: "working", windowPid: 4242 });
  const { bridge } = bridgeWith(sessions, [], "that session's window is gone, or Windows would not bring it forward");
  await bridge.refresh();
  const out = await bridge.focusAgentForSlot(0);
  assert.equal(out.ok, false);
  assert.match(out.text, /^claude 1: that session's window is gone/);
});

test("an empty key has nothing to open", async () => {
  const { bridge } = bridgeWith(new Sessions());
  await bridge.refresh();
  assert.deepEqual(await bridge.focusAgentForSlot(3), { ok: false, text: "slot 3 has no agent to focus" });
});

test("a Herdr agent's key still focuses its Herdr tab", async () => {
  const focused = [];
  const sessions = new Sessions();
  const { bridge } = bridgeWith(sessions, [{ agent: "claude", status: "working", paneID: "p1" }]);
  bridge.herdr.focus = async (pane) => { focused.push(pane); };
  await bridge.refresh();
  assert.deepEqual(await bridge.focusAgentForSlot(0), { ok: true, text: "focused claude 1" });
  assert.deepEqual(focused, ["p1"]);
});

test("only a real process id ever reaches a window script", () => {
  const focus = require("../lib/focus");
  for (const bad of [0, -1, 1.5, "12", null, undefined, NaN, 4294967296, "1; Remove-Item x"]) {
    assert.equal(focus.isPid(bad), false, String(bad));
    assert.equal(focus.windowOwnerOf(bad, () => { throw new Error("must not run"); }), 0);
  }
  let ran = 0;
  focus.raiseWindow("1; Remove-Item x", (why) => { assert.ok(why); }, () => { ran++; });
  assert.equal(ran, 0, "nothing is executed for a value that is not a pid");
  assert.match(focus.raiseScript(4242), /Get-Process -Id 4242 /);
  assert.match(focus.ownerScript(4242), /^\$id = 4242; /);
});

test("the window lookup reads a pid from the script's output and nothing else", { skip: process.platform !== "win32" }, () => {
  const focus = require("../lib/focus");
  assert.equal(focus.windowOwnerOf(100, () => "8123\r\n"), 8123);
  assert.equal(focus.windowOwnerOf(100, () => "not a pid"), 0);
  assert.equal(focus.windowOwnerOf(100, () => { throw new Error("exit 1"); }), 0);
});

test("the page title the bridge raises is the page's real title", () => {
  const fs = require("fs");
  const path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const title = /<title>([^<]*)<\/title>/.exec(html)[1];
  assert.ok(title.startsWith(require("../lib/focus").TITLE), `"${title}" starts with the title AppActivate looks for`);
});

test("dictation is live and continuous, and talk raises the page by default", () => {
  const fs = require("fs");
  const path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(app, /rec\.continuous = true;/);
  assert.match(app, /rec\.interimResults = true;/);
  assert.match(app, /window\.addEventListener\("focus", onFocus/, "a background talk press waits for the page to come forward");
  assert.equal(require("../lib/config").defaults().talkRaisesPage, true);
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
    const ours = after.hooks[event].flatMap((g) => g.hooks).filter((h) => hooks.isOurs(h));
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

test("each Codex event maps to the state the hook documents", () => {
  const { codexStatus } = require("../hooks/session-report");
  const cases = [
    ["SessionStart", "idle"], ["UserPromptSubmit", "working"], ["PreToolUse", "working"], ["PostToolUse", "working"],
    ["PermissionRequest", "blocked"], ["Stop", "done"], ["Interrupt", "done"], ["SessionEnd", "gone"],
    ["PreModelRequest", null], ["PostModelRequest", null], ["PreCompact", null], ["PostCompact", null],
    ["SubagentStart", null], ["SubagentStop", null], ["Notification", null],
  ];
  for (const [event, want] of cases) assert.equal(codexStatus({ hook_event_name: event }), want, event);
  assert.equal(codexStatus({}), null);
});

test("a Codex payload becomes a codex report with no content in it", () => {
  // The shape Codex documents for a command hook, with fields this must not forward.
  const body = reportFor("codex", {
    session_id: "thr_123", transcript_path: "/workspace/.codex/rollout.jsonl", cwd: "/workspace/api",
    hook_event_name: "PermissionRequest", model: "some-model", turn_id: "t1", permission_mode: "default",
    tool_name: "Bash", tool_input: { command: "echo secret", description: "run it" },
  });
  assert.deepEqual(body, { provider: "codex", id: "thr_123", status: "blocked", cwd: "/workspace/api", title: "api" });
});

test("a reported Codex session lights the codex key and leaves the claude keys alone", async () => {
  const sessions = new Sessions();
  sessions.report(reportFor("codex", { session_id: "thr_123", cwd: "/workspace/api", hook_event_name: "PreToolUse" }));
  const { bridge, states } = bridgeWith(sessions);
  await bridge.refresh();
  const a = states[0].assigned;
  assert.equal(a[0].agent, null);
  assert.equal(a[1].agent, null);
  assert.deepEqual([a[2].agent.agent, a[2].agent.status, a[2].agent.title, a[2].light], ["codex", "working", "api", "#00b0ff"]);
});

test("the Codex installer writes the hooks.json shape Codex documents, in the background", () => {
  const command = 'node "/app/hooks/session-report.js" codex';
  const after = hooks.withHooks({ description: "mine" }, command, "codex");
  assert.equal(after.description, "mine");
  assert.deepEqual(Object.keys(after.hooks), hooks.PROVIDERS.codex.events);
  assert.deepEqual(after.hooks.PreToolUse, [{ hooks: [{ type: "command", command, async: true, timeout: 5 }] }]);
  assert.equal(after.hooks.SessionEnd[0].hooks[0].timeout, 3, "Codex caps SessionEnd at three seconds");
  assert.equal(after.hooks.Interrupt[0].hooks[0].timeout, 3);
  assert.ok(!("Notification" in after.hooks), "Codex has no Notification event");
  assert.deepEqual(hooks.without(after, "codex"), { description: "mine" });
});

test("in one file, removing one provider's hooks leaves the other's", () => {
  const claude = 'node "/app/hooks/session-report.js" claude';
  const codex = 'node "/app/hooks/session-report.js" codex';
  const both = hooks.withHooks(hooks.withHooks({}, claude, "claude"), codex, "codex");
  const left = hooks.without(both, "codex");
  assert.deepEqual(left, hooks.withHooks({}, claude, "claude"));
  assert.equal(hooks.isOurs({ command: claude }, "codex"), false);
  assert.equal(hooks.isOurs({ command: claude }, "claude"), true);
  assert.equal(hooks.isOurs({ command: claude }), true);
});

test("every event the installer registers is one the hook maps to a state", () => {
  const { MAPPERS } = require("../hooks/session-report");
  for (const [provider, spec] of Object.entries(hooks.PROVIDERS)) {
    for (const event of spec.events) {
      const payload = { hook_event_name: event, notification_type: "permission_prompt" };
      assert.ok(MAPPERS[provider](payload), `${provider} ${event} would run the hook for nothing`);
    }
  }
});

test("the hook command quotes the path and names the provider", () => {
  assert.match(hooks.hookCommand("/opt/micr0pad", "codex"), / codex$/);
  const command = hooks.hookCommand("/opt/micr0pad");
  assert.match(command, /^node ".*\/hooks\/session-report\.js" claude$/);
  assert.ok(!command.includes("\\"), "forward slashes only");
});
