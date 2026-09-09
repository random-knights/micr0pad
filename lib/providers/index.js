"use strict";
// providers/index.js - the one place the bridge asks "who is running".
//
// Every status source is an adapter in this directory, behind one interface:
//
//   module.exports = {
//     id, name, logo,            // the row in the README matrix, in code
//     capabilities,              // { status, title, cwd, model, tokens, cost }
//                                //   each "live" | "derived" | "none"
//     defaults,                  // the config block a fresh install gets
//     create(providerCfg, deps)  // -> { connect(), poll(), dispose(), ... }
//   }
//
// An instance has connect() (own its external resources), poll() (return a
// normalized agent array and NEVER throw: on failure return [] and set
// lastError), and dispose() (release what connect() took). It owns its own
// timeout, which must be shorter than the bridge's pollIntervalMs.
//
// A normalized agent is:
//
//   { providerId, id, agent, status, title, cwd, focused,
//     paneID, tabID, terminalID, sessionId, model, tokens, cost, lastChangeAt }
//
// `agent` is the kind the slot rules match on ("claude", "codex", ...) and
// `status` is already in the pad's vocabulary. Raw payloads stay inside the
// adapter; nothing here forwards a provider's own field names.
//
// A disabled adapter is never constructed, so a broken one costs nothing
// while it is off.

const STATUSES = ["blocked", "working", "done", "idle", "unknown"];

// Owner decision Q1 (REPORT.md section 8): blocked is the state that wants a
// human, so it wins a slot. This is the order mapper.assign() sorts by.
const STATUS_PRIORITY = ["blocked", "working", "done", "idle", "unknown"];

// Map any provider's status word onto the pad's five. Anything unrecognized
// is "unknown", never a guess.
function normalizeStatus(s) {
  const v = String(s || "").toLowerCase();
  return STATUSES.includes(v) ? v : "unknown";
}

// Every adapter module, in the order the Settings page lists them.
const MODULES = [
  require("./herdr"),
];

function byId() {
  const m = {};
  for (const mod of MODULES) m[mod.id] = mod;
  return m;
}

// The provider config block a fresh install gets: each adapter's own
// defaults, keyed by id. config.js merges the user's file over this.
function defaults() {
  const out = {};
  for (const mod of MODULES) out[mod.id] = Object.assign({}, mod.defaults);
  return out;
}

// Build the enabled adapters for a config. `deps` lets a test hand in a fake
// CLI instead of spawning a real one; production passes nothing.
function create(cfg, deps) {
  const providersCfg = (cfg && cfg.providers) || {};
  const instances = [];
  for (const mod of MODULES) {
    const pcfg = Object.assign({}, mod.defaults, providersCfg[mod.id]);
    if (pcfg.enabled !== true) continue;
    const inst = mod.create(pcfg, deps || {});
    inst.id = mod.id;
    inst.name = mod.name;
    inst.capabilities = mod.capabilities;
    instances.push(inst);
  }
  return instances;
}

function connectAll(instances) {
  for (const inst of instances) {
    try { inst.connect(); } catch (e) { inst.lastError = e.message; }
  }
}

function disposeAll(instances) {
  for (const inst of instances) {
    try { inst.dispose(); } catch (_) { /* releasing; nothing to do */ }
  }
}

// Poll every adapter in parallel and concatenate. An adapter that rejects or
// throws contributes nothing this tick and carries the error on lastError;
// the others still paint. Each agent is stamped with its providerId so the
// mapper's tiebreak is deterministic across providers.
async function pollAll(instances) {
  const results = await Promise.all(instances.map(async (inst) => {
    try {
      const agents = await inst.poll();
      return Array.isArray(agents) ? agents.map((a) => Object.assign({ providerId: inst.id }, a, { status: normalizeStatus(a.status) })) : [];
    } catch (e) {
      inst.lastError = e.message;
      return [];
    }
  }));
  return results.flat();
}

// What the UI may know about each adapter: identity, capabilities, whether
// the last poll worked. No raw payload, no path, no pid.
function describe(instances) {
  return instances.map((inst) => ({
    id: inst.id,
    name: inst.name,
    capabilities: inst.capabilities,
    connected: !inst.lastError,
    lastError: inst.lastError || null,
    lastCount: inst.lastCount || 0,
  }));
}

module.exports = {
  STATUSES,
  STATUS_PRIORITY,
  MODULES,
  byId,
  defaults,
  normalizeStatus,
  create,
  connectAll,
  disposeAll,
  pollAll,
  describe,
};
