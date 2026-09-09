"use strict";
// What these tests hold in place: the provider layer changes WHERE agents
// come from and nothing about WHAT the pad does with them. The herdr fixture
// is the payload shape observed from the installed herdr (field names as
// they arrive; paths and titles replaced), and the mapper output for it is
// pinned exactly. A provider that fails must cost the pad nothing.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const providers = require("../lib/providers");
const herdrProvider = require("../lib/providers/herdr");
const herdr = require("../lib/herdr");
const mapper = require("../lib/mapper");
const pad = require("../lib/pad");
const config = require("../lib/config");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "herdr-agent-list.json"), "utf8"));

// The same path lib/herdr.js takes from CLI stdout to normalized rows, minus
// the process spawn.
function herdrRows() {
  return FIXTURE.result.agents.map(herdr.normalizeAgent);
}

function fakeDeps(rows) {
  return { herdrListAgents: async () => rows };
}

test("every adapter module carries the interface and a full capability row", () => {
  assert.ok(providers.MODULES.length >= 1);
  for (const mod of providers.MODULES) {
    assert.equal(typeof mod.id, "string");
    assert.equal(typeof mod.name, "string");
    assert.equal(typeof mod.create, "function");
    assert.equal(typeof mod.defaults.enabled, "boolean");
    for (const col of ["status", "title", "cwd", "model", "tokens", "cost"]) {
      assert.ok(["live", "derived", "none"].includes(mod.capabilities[col]), `${mod.id}.capabilities.${col}`);
    }
  }
});

test("the herdr row is normalized without inventing fields", () => {
  const rows = herdrRows();
  assert.equal(rows.length, 5);
  const first = herdrProvider.normalize(rows[0]);
  assert.equal(first.agent, "claude");
  assert.equal(first.status, "working");
  assert.equal(first.title, "release notes");
  assert.equal(first.cwd, "C:\\path\\repo-a");
  assert.equal(first.focused, true);
  assert.equal(first.paneID, "w3:p1");
  assert.equal(first.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(first.stateChangeSeq, 10);
  // Herdr carries none of these; the matrix says NONE and the object agrees.
  assert.equal(first.model, null);
  assert.equal(first.tokens, null);
  assert.equal(first.cost, null);
  // A row with no agent_session has no session id, not a made-up one.
  assert.equal(herdrProvider.normalize(rows[2]).sessionId, undefined);
});

test("the dead foreground_cwd fallback is gone: cwd rules match on cwd alone", () => {
  // This herdr never sends foreground_cwd. The old mapper consulted it
  // anyway, which was harmless only because it was always undefined.
  assert.equal("foregroundCwd" in herdr.normalizeAgent(FIXTURE.result.agents[0]), false);
  const a = { agent: "claude", cwd: "C:\\path\\repo-a", title: "x" };
  assert.equal(mapper.agentMatches(a, { matchType: "cwd", match: "repo-a" }), true);
  assert.equal(mapper.agentMatches(a, { matchType: "cwd", match: "repo-z" }), false);
  assert.equal(mapper.agentMatches({ agent: "claude" }, { matchType: "cwd", match: "repo-a" }), false);
});

test("pollAll returns provider-tagged agents in the pad's status vocabulary", async () => {
  const cfg = { providers: { herdr: { enabled: true } } };
  const instances = providers.create(cfg, fakeDeps(herdrRows()));
  assert.equal(instances.length, 1);
  assert.equal(instances[0].id, "herdr");
  const agents = await providers.pollAll(instances);
  assert.equal(agents.length, 5);
  assert.ok(agents.every((a) => a.providerId === "herdr"));
  assert.deepEqual(agents.map((a) => a.status), ["working", "idle", "blocked", "done", "unknown"]);
  assert.equal(providers.describe(instances)[0].connected, true);
  assert.equal(providers.describe(instances)[0].lastCount, 5);
});

test("mapper output for the herdr fixture is unchanged by the refactor", async () => {
  // Pinned from the pre-refactor mapper run against the same rows: first
  // matching unused agent per slot, in herdr's order, no priority.
  const agents = await providers.pollAll(providers.create({ providers: { herdr: { enabled: true } } }, fakeDeps(herdrRows())));
  const assigned = mapper.assign(agents, pad.defaultSlots);
  assert.deepEqual(
    assigned.map((x) => [x.slotCfg.slot, x.slotCfg.name, x.agent ? x.agent.paneID : null, x.agent ? mapper.statusOf(x.agent) : null]),
    [
      [0, "claude 1", "w3:p1", "working"],
      [1, "claude 2", "w3:p2", "idle"],
      [2, "codex", "w3:p3", "blocked"],
      [3, "gemini", "w3:p5", "unknown"],
      [4, "grok", null, null],
      [5, "huggingface", null, null],
    ],
  );
  // The lighting for those slots, exactly as before.
  const threads = assigned.map((x) => mapper.threadFor(x.agent, x.slotCfg));
  assert.deepEqual(threads[0], { id: 0, color: 0xff4124, brightness: 1, effect: 1, speed: 0.5 });
  assert.deepEqual(threads[2], { id: 2, color: 0x00b0ff, brightness: 1, effect: 4, speed: 0.5 });
  assert.deepEqual(threads[4], { id: 4, brightness: 0, effect: 0 });
  // Underglow: blocked is present, so the strip breathes red.
  const zone = mapper.zoneFor(assigned, pad.underglow);
  assert.equal(zone.c, 0xff2d2d);
  assert.equal(zone.e, 4);
});

test("a provider that throws contributes nothing and reports the error", async () => {
  const instances = providers.create({ providers: { herdr: { enabled: true } } }, {
    herdrListAgents: async () => { throw new Error("herdr agent list failed: spawn ENOENT"); },
  });
  const agents = await providers.pollAll(instances);
  assert.deepEqual(agents, []);
  const [status] = providers.describe(instances);
  assert.equal(status.connected, false);
  assert.match(status.lastError, /ENOENT/);
  // The pad still paints: every slot dark, underglow off.
  const assigned = mapper.assign(agents, pad.defaultSlots);
  assert.ok(assigned.every((x) => x.agent === null));
  assert.equal(mapper.zoneFor(assigned, pad.underglow), null);
});

test("a disabled provider is never constructed", () => {
  let built = 0;
  const instances = providers.create({ providers: { herdr: { enabled: false } } }, {
    herdrListAgents: async () => { built++; return []; },
  });
  assert.equal(instances.length, 0);
  assert.equal(built, 0);
});

test("provider config merges one level deep and keeps defaults for unknown keys", () => {
  const base = { herdr: { enabled: true, extra: 1 } };
  assert.deepEqual(config.mergeProviders(base, { herdr: { enabled: false } }), { herdr: { enabled: false, extra: 1 } });
  assert.deepEqual(config.mergeProviders(base, undefined), base);
  // A provider the code does not know is dropped rather than constructed.
  assert.deepEqual(config.mergeProviders(base, { mystery: { enabled: true } }), base);
  assert.deepEqual(config.defaults().providers, providers.defaults());
});

test("normalizeStatus never invents a state", () => {
  assert.equal(providers.normalizeStatus("Working"), "working");
  assert.equal(providers.normalizeStatus("busy"), "unknown");
  assert.equal(providers.normalizeStatus(undefined), "unknown");
  assert.deepEqual(providers.STATUS_PRIORITY, ["blocked", "working", "done", "idle", "unknown"]);
});
