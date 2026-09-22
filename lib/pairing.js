"use strict";
// pairing.js - how a HOSTED page earns the right to talk to this local bridge.
//
// The local dashboard on http://localhost:PORT has always been the only origin
// this server answers, for reads as well as for writes. That is correct for a
// local-only app and fatal for a hosted one: a page on https://rand0m.ai is a
// different origin, so it was refused before any handler ran.
//
// Pairing is the one narrow door through that. It is deliberately a
// three-party handshake with a human in the middle:
//
//   1. The owner, on the LOCAL dashboard, presses "pair a hosted page". The
//      bridge mints an 8-character code and shows it. The code lives for five
//      minutes and is worth one use.
//   2. The owner types that code into the hosted page. The hosted page POSTs
//      it to /api/pair/complete with its own Origin header attached by the
//      browser, which the page cannot forge.
//   3. The bridge checks the code, checks that the Origin is one of the
//      hosted origins it is willing to pair with at all, mints a 32-byte
//      token, returns it ONCE, and stores only its SHA-256 hash.
//
// From then on that exact origin, presenting that exact bearer token, is
// allowed. Nothing else about the local policy moves.
//
// Three properties worth stating, because each one is a decision:
//
// - The token is returned exactly once and stored only as a hash. A leaked
//   config.json therefore does not hand anyone a working hosted session, the
//   way a leaked pairingToken does. (The local pairingToken predates this and
//   is a different thing: it is the LOCAL page's proof, and it is stored in
//   clear because the local page has to be handed it to work at all.)
// - The origin is pinned into the pairing. A token stolen from one hosted
//   origin does not work from another, because the browser sets Origin and
//   the bridge compares the stored one.
// - The set of origins that may even ATTEMPT to pair is a fixed list, never a
//   wildcard. A code shown on screen is a weak secret, so the code alone is
//   not allowed to be the whole gate.
const crypto = require("crypto");

// No I, O, 0 or 1: the code is read off one screen and typed into another, and
// those four are the pairs people transcribe wrong. 32 symbols over 8
// characters is 40 bits, which is not a password, which is why it expires in
// five minutes, is single use, and only ever admits an origin already on the
// hosted list.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_TTL_MS = 5 * 60 * 1000;

// The hosted origins allowed to attempt a pairing. Overridable in config.json
// under "hostedOrigins", never a wildcard: an entry of "*" is dropped on load
// rather than honored, because a wildcard here would re-open the hole this
// module exists to keep shut.
// The shipped default is the production site a public user pairs from, and
// nothing else. www.rand0m.ai redirects to it, so it never arrives as an
// Origin of its own. A developer who reviews on a staging host adds that
// host to "hostedOrigins" in their own config.json (docs/DEVELOPMENT.md):
// the browser sends each host's own name as the Origin, so a host that is
// not listed by name is refused before any code is checked.
const DEFAULT_HOSTED_ORIGINS = ["https://rand0m.ai"];

function mintCode() {
  // rejection-free because 256 is a multiple of 32: every byte maps to one
  // symbol with no bias.
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

// Constant-time compare of two equal-length hex digests. Both sides are
// SHA-256 output here, so a length mismatch means a malformed store, not an
// attacker probing, and it is simply false.
function sameHash(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

function sameCode(a, b) {
  const x = Buffer.from(String(a).toUpperCase(), "utf8");
  const y = Buffer.from(String(b).toUpperCase(), "utf8");
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

class Pairing {
  // `cfg` is the live config object (mutated in place, the way lib/config.js
  // requires). `persist` writes it back to config.json; it is injected so the
  // tests can exercise the whole handshake without touching a real file.
  constructor(cfg, { persist } = {}) {
    this.cfg = cfg;
    this.persist = typeof persist === "function" ? persist : () => {};
    if (!Array.isArray(cfg.pairings)) cfg.pairings = [];
    this.hostedOrigins = Pairing.normalizeHostedOrigins(cfg.hostedOrigins);
    // The pending code is in MEMORY only. It never reaches config.json, so a
    // restart cancels an unfinished pairing, which is the behavior a
    // five-minute code should have anyway.
    this.pending = null;
  }

  static normalizeHostedOrigins(list) {
    const raw = Array.isArray(list) && list.length ? list : DEFAULT_HOSTED_ORIGINS;
    // https only, no wildcard, no trailing slash. An origin that does not
    // survive this is dropped rather than repaired: silently "fixing" an
    // entry is how a typo becomes an allowed origin nobody meant.
    return raw
      .map((o) => String(o || "").trim().replace(/\/+$/, ""))
      .filter((o) => /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(o));
  }

  mayAttemptPairing(origin) {
    return this.hostedOrigins.includes(String(origin || ""));
  }

  // Step 1. Local origin only - the caller enforces that; this module is not
  // where the local policy lives.
  start(now = Date.now()) {
    const code = mintCode();
    this.pending = { code, expiresAt: now + CODE_TTL_MS };
    return { code, expiresAt: this.pending.expiresAt };
  }

  cancel() {
    this.pending = null;
  }

  pendingFor(now = Date.now()) {
    if (!this.pending) return null;
    if (this.pending.expiresAt <= now) {
      this.pending = null;
      return null;
    }
    return { code: this.pending.code, expiresAt: this.pending.expiresAt };
  }

  // Step 3. Returns { ok: true, id, token } exactly once, or { ok: false,
  // error } with a reason the hosted page can show.
  //
  // The code is burned on ANY submission once it has been checked, success or
  // failure, so a wrong guess costs the owner a new code rather than buying an
  // attacker another try.
  complete(code, origin, label, now = Date.now()) {
    if (!this.mayAttemptPairing(origin)) {
      return { ok: false, error: "this origin cannot pair with this bridge" };
    }
    const pending = this.pendingFor(now);
    if (!pending) {
      return { ok: false, error: "no pairing code is active - start one on the local dashboard" };
    }
    this.pending = null;
    if (!sameCode(pending.code, code)) {
      return { ok: false, error: "that code does not match - start a new one on the local dashboard" };
    }
    const token = crypto.randomBytes(32).toString("hex");
    const record = {
      id: crypto.randomUUID(),
      origin: String(origin),
      tokenHash: hashToken(token),
      createdAt: new Date(now).toISOString(),
      label: String(label || origin).slice(0, 60),
    };
    this.cfg.pairings.push(record);
    this.persist(this.cfg.pairings);
    return { ok: true, id: record.id, token };
  }

  // What a listing may say. Never the hash, and there is no clear token to
  // leak: labels, origins and dates only.
  list() {
    return this.cfg.pairings.map((p) => ({
      id: p.id,
      origin: p.origin,
      label: p.label,
      createdAt: p.createdAt,
    }));
  }

  revoke(id) {
    const before = this.cfg.pairings.length;
    this.cfg.pairings = this.cfg.pairings.filter((p) => p.id !== String(id));
    if (this.cfg.pairings.length === before) return false;
    this.persist(this.cfg.pairings);
    return true;
  }

  // Why a hosted request was refused, in words that name the fix. Used for
  // the one log line per refused hosted request (server.js). It never sees
  // or prints a token: it is told only whether one was presented.
  refusalReason(origin, hadToken) {
    const o = String(origin || "");
    const listed = this.mayAttemptPairing(o);
    const paired = this.cfg.pairings.some((p) => p.origin === o);
    if (!listed && !paired) return "origin is not in hostedOrigins";
    if (!hadToken) return "origin is allowed but this page has not paired";
    return "the pairing token does not match a pairing for this origin";
  }

  // Step 0, the probe a hosted page runs before it knows anything: is a
  // bridge here, may this origin pair, and is it already paired? Readable
  // only by an origin on the hosted list or one that holds a pairing, so it
  // tells a stranger nothing. It carries no machine name and no token.
  status(origin, token) {
    const o = String(origin || "");
    const listed = this.mayAttemptPairing(o);
    const matched = this.match(o, token);
    return {
      ok: true,
      bridge: "micr0pad",
      originAllowed: listed || Boolean(matched),
      paired: Boolean(matched),
      pairingCodeActive: Boolean(this.pendingFor()),
    };
  }

  // The whole point: does this origin, with this bearer token, have a
  // pairing? Both must match the same record, so a token from one paired
  // origin cannot be replayed from another.
  match(origin, token) {
    if (!origin || !token) return null;
    const wanted = hashToken(token);
    return this.cfg.pairings.find(
      (p) => p.origin === String(origin) && sameHash(p.tokenHash, wanted),
    ) || null;
  }
}

module.exports = {
  Pairing,
  DEFAULT_HOSTED_ORIGINS,
  CODE_LENGTH,
  CODE_TTL_MS,
  hashToken,
};
