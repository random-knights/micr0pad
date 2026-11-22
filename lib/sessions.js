"use strict";
// sessions.js - agent sessions that report themselves to the bridge.
//
// Herdr is one way the bridge learns what agents are doing: it asks. This is
// the other: a session that is not running inside Herdr (a desktop app, an
// IDE, a plain terminal) tells the bridge its own state through a small hook
// (hooks/session-report.js) and POST /api/session.
//
// The store is in memory and nothing here is written to disk. A report holds a
// provider name, an opaque session id, a state, and the folder and title the
// session chose to send. No prompt, no output, no file content: the hook does
// not read them and this module has no field for them.
//
// A session leaves the list when it says so ("gone"), or when nothing has been
// heard from it for `staleMs`. The second rule exists because a session that
// crashes never says goodbye, and a key that stays lit for a dead session is a
// light that lies.

const STATES = new Set(["idle", "working", "blocked", "done"]);
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAX_SESSIONS = 32;
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

// Printable text only, cut to a length: these strings end up on a page.
function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

class Sessions {
  constructor(opts = {}) {
    const stale = Number(opts.staleMs);
    this.staleMs = Number.isFinite(stale) && stale >= 60000 ? stale : DEFAULT_STALE_MS;
    this.byKey = new Map(); // "provider:id" -> record, in first-seen order
  }

  // Take one report. Returns { ok: true, changed } or { ok: false, error }.
  // `changed` says whether the list a reader would see is different now, so
  // the caller can repaint at once and skip a repaint that would show nothing.
  report(input, now = Date.now()) {
    const r = input && typeof input === "object" ? input : {};
    const provider = typeof r.provider === "string" ? r.provider.toLowerCase() : "";
    if (!PROVIDER.test(provider)) return { ok: false, error: "provider must be a short lowercase name" };
    const id = clean(r.id, 128);
    if (!id) return { ok: false, error: "id required" };
    const key = `${provider}:${id}`;
    if (r.status === "gone") {
      return { ok: true, changed: this.byKey.delete(key) };
    }
    if (!STATES.has(r.status)) return { ok: false, error: "status must be idle, working, blocked, done or gone" };
    const had = this.byKey.get(key);
    if (!had && this.byKey.size >= MAX_SESSIONS) {
      this.prune(now);
      if (this.byKey.size >= MAX_SESSIONS) return { ok: false, error: "too many sessions" };
    }
    const next = {
      provider,
      id,
      status: r.status,
      cwd: clean(r.cwd, 400) || (had ? had.cwd : ""),
      title: clean(r.title, 120) || (had ? had.title : ""),
      // The process that owns the window this session lives in, so a key
      // press can bring it forward. null: nobody has looked yet. 0: the hook
      // looked and found none. A report that does not carry one keeps it.
      windowPid: Number.isInteger(r.windowPid) && r.windowPid >= 0 && r.windowPid < 4294967296
        ? r.windowPid
        : (had ? had.windowPid : null),
      firstSeen: had ? had.firstSeen : now,
      lastSeen: now,
    };
    this.byKey.set(key, next);
    return {
      ok: true,
      changed: !had || had.status !== next.status || had.cwd !== next.cwd || had.title !== next.title,
      // Asks the hook to look for the window, once per session: the lookup is
      // the slow part of a report and nothing else needs repeating.
      wantWindow: next.windowPid === null,
    };
  }

  prune(now = Date.now()) {
    for (const [key, s] of this.byKey) {
      if (now - s.lastSeen > this.staleMs) this.byKey.delete(key);
    }
  }

  // The live sessions in the shape lib/herdr.js gives the mapper, oldest
  // first so a session keeps its key while newer ones come and go. There is no
  // Herdr pane and no terminal to type into: those fields are null. What a
  // key press can do is bring the session's window forward (windowPid).
  list(now = Date.now()) {
    this.prune(now);
    return Array.from(this.byKey.values()).map((s) => ({
      agent: s.provider,
      status: s.status,
      focused: false,
      cwd: s.cwd,
      foregroundCwd: s.cwd,
      paneID: null,
      tabID: null,
      terminalID: null,
      title: s.title,
      sessionID: s.id,
      windowPid: s.windowPid || 0,
      source: "session",
    }));
  }
}

module.exports = { Sessions, STATES, MAX_SESSIONS, DEFAULT_STALE_MS };
