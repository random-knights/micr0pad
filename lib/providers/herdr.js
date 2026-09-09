"use strict";
// providers/herdr.js - Herdr, the terminal multiplexer, as a status source.
//
// This is the source the pad has always read. `herdr agent list` returns one
// row per agent pane with a live agent_status, the pane's title and cwd. It
// carries no model, token or cost field (observed 2026-09-07 and 2026-09-08
// against the installed herdr; see the README matrix).
//
// The CLI call itself lives in lib/herdr.js, which the bridge also uses for
// focus, prompt and navigation. This adapter only turns its rows into the
// normalized shape and owns the poll contract (never throws).
const herdr = require("../herdr");

const id = "herdr";
const name = "Herdr";
const logo = "herdr";

const capabilities = {
  status: "live",   // agent_status
  title: "live",    // terminal_title_stripped
  cwd: "live",      // cwd
  model: "none",    // no field in the payload
  tokens: "none",
  cost: "none",
};

const defaults = { enabled: true };

function create(pcfg, deps) {
  const listAgents = (deps && deps.herdrListAgents) || herdr.listAgents;
  return {
    lastError: null,
    lastCount: 0,
    connect() { /* nothing to hold: each poll is one CLI call */ },
    dispose() { /* nothing to release */ },
    async poll() {
      try {
        const rows = await listAgents();
        this.lastError = null;
        this.lastCount = rows.length;
        return rows.map(normalize);
      } catch (e) {
        this.lastError = e.message;
        this.lastCount = 0;
        return [];
      }
    },
  };
}

// lib/herdr.js already maps the CLI row to camelCase; this adds the provider
// fields and drops nothing the mapper or the bridge reads.
function normalize(a) {
  return {
    id: a.paneID || a.terminalID || a.sessionId || a.agent,
    agent: a.agent,
    status: a.status,
    title: a.title,
    cwd: a.cwd,
    focused: a.focused,
    paneID: a.paneID,
    tabID: a.tabID,
    terminalID: a.terminalID,
    sessionId: a.sessionId,
    model: null,
    tokens: null,
    cost: null,
    lastChangeAt: null,
    stateChangeSeq: a.stateChangeSeq,
  };
}

module.exports = { id, name, logo, capabilities, defaults, create, normalize };
