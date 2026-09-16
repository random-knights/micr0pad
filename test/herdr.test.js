"use strict";
// What these tests hold in place: `herdr agent list` output parses into the
// pad's agent shape (status, focused, cwd, pane/tab/terminal ids) for idle,
// working, blocked, done and an unrecognized status (-> unknown), and the
// optional-herdr path fails with a clear error rather than a hang or a
// silent empty roster when the binary is missing.
//
// The fixture (test/fixtures/herdr-agent-list.json) was recorded from a real
// `herdr agent list` run on this machine (herdr 0.9.0, Windows) - the field
// shape is exactly what the real binary printed. The VALUES were sanitized
// before committing: session ids, terminal titles and cwd paths were
// replaced with generic placeholders; agent_status and the agent kinds were
// chosen to cover idle/working/blocked/done/unknown, which the live session
// did not all show at once.
//
// No process is spawned: execFile is injected (lib/herdr.js's listAgents(execImpl)
// seam), so the parser is proven against fixed input instead of whatever is
// running on this machine right now.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const herdr = require("../lib/herdr");

const fixturePath = path.join(__dirname, "fixtures", "herdr-agent-list.json");
const fixtureRaw = fs.readFileSync(fixturePath, "utf8");

// A fake execFile with the same (cmd, args, opts, cb) signature herdr.js
// calls: `(err, stdout, stderr) => ...`.
function fakeExec(stdout, err) {
  return (cmd, args, opts, cb) => cb(err || null, stdout, "");
}

test("listAgents parses the fixture into 5 agents with the pad's field names", async () => {
  const agents = await herdr.listAgents(fakeExec(fixtureRaw));
  assert.equal(agents.length, 5);
  const claude1 = agents[0];
  assert.equal(claude1.agent, "claude");
  assert.equal(claude1.status, "blocked");
  assert.equal(claude1.focused, true);
  assert.equal(claude1.cwd, "C:\\Users\\dev\\project");
  assert.equal(claude1.paneID, "w1:p1");
  assert.equal(claude1.tabID, "w1:t1");
  assert.equal(claude1.terminalID, "term_aaaaaaaaaaaaaa");
  assert.equal(claude1.title, "task one", "prefers terminal_title_stripped");
});

test("listAgents carries focused=false for every agent but the one Herdr marks focused", () => {
  return herdr.listAgents(fakeExec(fixtureRaw)).then((agents) => {
    assert.equal(agents.filter((a) => a.focused).length, 1);
    assert.equal(agents.filter((a) => a.focused)[0].agent, "claude");
  });
});

test("statusOf maps idle, working, blocked, done straight through", async () => {
  const agents = await herdr.listAgents(fakeExec(fixtureRaw));
  const byPane = Object.fromEntries(agents.map((a) => [a.paneID, a]));
  assert.equal(herdr.statusOf(byPane["w1:p1"]), "blocked");
  assert.equal(herdr.statusOf(byPane["w1:p2"]), "working");
  assert.equal(herdr.statusOf(byPane["w1:p3"]), "done");
  assert.equal(herdr.statusOf(byPane["w1:p4"]), "idle");
});

test("statusOf maps an unrecognized status ('reviewing') to unknown", async () => {
  const agents = await herdr.listAgents(fakeExec(fixtureRaw));
  const grok = agents.find((a) => a.agent === "grok");
  assert.equal(grok.status, "reviewing", "the raw status is kept on the agent record");
  assert.equal(herdr.statusOf(grok), "unknown", "but statusOf translates it for the pad");
});

test("statusOf maps a done row straight through", async () => {
  const agents = await herdr.listAgents(fakeExec(fixtureRaw));
  const done = agents.find((a) => a.agent_status === "done" || a.status === "done");
  assert.ok(done, "fixture has a done row");
  assert.equal(herdr.statusOf(done), "done");
});

test("listAgents rejects with a clear message when the herdr binary is missing", async () => {
  const notFound = Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" });
  await assert.rejects(
    () => herdr.listAgents(fakeExec("", notFound)),
    /herdr agent list failed/,
    "the optional-herdr path names the failure instead of hanging or returning an empty roster silently"
  );
});

test("listAgents rejects when herdr prints something that is not JSON", async () => {
  await assert.rejects(
    () => herdr.listAgents(fakeExec("not json at all")),
    /non-JSON/
  );
});

test("listAgents rejects when the parsed output has no agents array", async () => {
  await assert.rejects(
    () => herdr.listAgents(fakeExec(JSON.stringify({ result: { type: "agent_list" } }))),
    /no agents array/
  );
});

test("listAgents accepts a bare array result as well as {agents: [...]}", async () => {
  const bare = JSON.stringify([{ agent: "claude", agent_status: "idle" }]);
  const agents = await herdr.listAgents(fakeExec(bare));
  assert.equal(agents.length, 1);
  assert.equal(agents[0].agent, "claude");
});

test("listAgents with no argument still returns a Promise (production path unchanged)", () => {
  // Proves the seam is a default, not a required parameter: listAgents()
  // must still shell out to the real `herdr` on PATH exactly as before, not
  // throw for lack of an injected exec. Whether that resolves or rejects
  // depends on whether herdr is installed on the machine running the test,
  // which is exactly what this seam lets the rest of the suite avoid relying
  // on - so the rejection is swallowed here, not asserted on.
  const p = herdr.listAgents();
  assert.ok(p instanceof Promise);
  p.catch(() => {});
});

// --- Fail-first target: a dropped field in the parser, caught by name. ---
test("normalizeAgent keeps terminalID - dropping it would break the focus/navigate keys silently", async () => {
  const agents = await herdr.listAgents(fakeExec(fixtureRaw));
  for (const a of agents) {
    assert.ok(a.terminalID, `agent ${a.agent} is missing terminalID`);
  }
});
