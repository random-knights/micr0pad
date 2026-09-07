"use strict";
/*
 * aieds-cost.js - the one place that turns AiEDs token counts into a dollar
 * figure, shared by the SessionEnd hook (hooks/aieds-local.js, which stamps the
 * cost onto each new row) and by the reader that wants a cost for rows written
 * before the hook recorded one (lib/aieds.js).
 *
 * IT IS A MODELLED LIST PRICE, NOT A BILL.
 * Claude Code on this machine is subscription billed, so the marginal cost of a
 * session is zero. What this computes is what the same tokens would have cost
 * at published per-token API list prices. Every row it stamps carries
 * costBasis:"list-price-modeled" and the ratesVersion, so a figure can always
 * be traced back to the numbers that produced it.
 *
 * PRICES LIVE IN DATA, NOT IN CODE: lib/aieds-rates.json. A model with no
 * entry there gets no cost at all - null, never an assumed rate.
 *
 * CACHE TOKENS ARE PRICED SEPARATELY. Claude Code sends the bulk of its input
 * as cache reads (~0.1x an input token) and cache writes (~1.25x). Pricing the
 * combined tokensIn at the plain input rate would overstate a session by
 * roughly 8x, so the breakdown is required for an accurate figure; a row
 * without one falls back to pricing all input at the plain rate and says so
 * via costInputBasis:"combined-no-breakdown".
 */

const fs = require("fs");
const path = require("path");

const RATES_PATH = path.join(__dirname, "aieds-rates.json");

let cached = null;
function loadRates() {
  if (cached) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(RATES_PATH, "utf8"));
    const cm = raw.cacheMultipliers || {};
    cached = {
      ratesVersion: raw.ratesVersion || "unknown",
      currency: raw.currency || "USD",
      write: Number.isFinite(cm.write) ? cm.write : 1.25,
      read: Number.isFinite(cm.read) ? cm.read : 0.1,
      models: raw.models || {},
      // Longest prefix wins, so claude-opus-4-8 beats a hypothetical claude-opus.
      prefixes: (raw.prefixes || [])
        .slice()
        .sort((a, b) => String(b.prefix).length - String(a.prefix).length),
    };
  } catch (_) {
    cached = null; // No rates file (or unreadable): no cost, never a guess.
  }
  return cached;
}

/** Rate pair for a model id, or null when the owner has not priced it. */
function rateForModel(modelId, rates) {
  if (!rates) return null;
  const id = String(modelId || "").trim();
  if (!id) return null;
  const exact = rates.models[id];
  if (exact) return exact;
  for (const entry of rates.prefixes) {
    if (id.startsWith(entry.prefix)) return entry;
  }
  return null;
}

/**
 * Cost for one AiEDs row.
 * Returns null when the model has no published rate in aieds-rates.json.
 * `row` needs tokensOut plus either tokensInBreakdown {input, cacheCreation,
 * cacheRead} or a plain tokensIn.
 */
function costForRow(row) {
  const rates = loadRates();
  const rate = rateForModel(row && row.model, rates);
  if (!rate) return null;

  const b = (row && row.tokensInBreakdown) || null;
  const inRate = Number(rate.inPer1M) || 0;
  const outRate = Number(rate.outPer1M) || 0;
  const out = Number(row.tokensOut) || 0;

  let inputUsd;
  let inputBasis;
  if (b) {
    const plain = Number(b.input) || 0;
    const write = Number(b.cacheCreation) || 0;
    const read = Number(b.cacheRead) || 0;
    inputUsd =
      ((plain + write * rates.write + read * rates.read) * inRate) / 1e6;
    inputBasis = "breakdown";
  } else {
    inputUsd = ((Number(row.tokensIn) || 0) * inRate) / 1e6;
    inputBasis = "combined-no-breakdown";
  }

  return {
    costUsd: inputUsd + (out * outRate) / 1e6,
    costBasis: "list-price-modeled",
    costInputBasis: inputBasis,
    costRatesVersion: rates.ratesVersion,
    costCurrency: rates.currency,
  };
}

module.exports = { loadRates, rateForModel, costForRow, RATES_PATH };
