"use strict";
// aieds.js - read the local AiEDs v2 log and produce a compact aggregate for
// the System panel. This is the same file the SessionEnd hook in hooks/ appends
// to; it carries real token/energy/carbon per model.
const fs = require("fs");
const path = require("path");

// Where the AiEDs log lives, in priority order, so a fresh clone works with no
// edits and this checkout keeps working unchanged:
//   1. AIEDS_LOG_PATH        - explicit, wins over everything
//   2. <app>/aieds-local.jsonl - the default for a standalone install
//   3. ../../../../_state    - a shared state dir, for installs that keep the
// Nothing is created here: no log means the panel shows its empty state.
const APP_DIR = path.join(__dirname, "..");
const WORKSPACE_STATE = path.join(__dirname, "..", "..", "..", "..", "_state");

function firstExisting(candidates, fallback) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return fallback;
}

// An explicit AIEDS_LOG_PATH wins even when the file does not exist yet -
// that is how a new user points at a log the hook has not written its first
// row into. Only the fallbacks are existence-checked.
const LOG_PATH = process.env.AIEDS_LOG_PATH
  ? path.resolve(process.env.AIEDS_LOG_PATH)
  : firstExisting(
      [path.join(APP_DIR, "aieds-local.jsonl"), path.join(WORKSPACE_STATE, "aieds-local.jsonl")],
      path.join(APP_DIR, "aieds-local.jsonl"),
    );
const STATE_DIR = path.dirname(LOG_PATH);

// Cost is a MODELLED list price, never a bill - see the header of
// lib/aieds-cost.js. The hook stamps costUsdModeled on rows it writes; rows
// written before that shipped are priced here from the same rates file so the
// history is not a hole in the chart. A model that is not priced in
// aieds-rates.json contributes nothing, rather than a guessed number.
let aiedsCost = null;
for (const candidate of [
  path.join(APP_DIR, "lib", "aieds-cost.js"),
  path.join(APP_DIR, "aieds-cost.js"),
  path.join(STATE_DIR, "aieds-cost.js"),
  path.join(WORKSPACE_STATE, "aieds-cost.js"),
]) {
  try {
    if (fs.existsSync(candidate)) { aiedsCost = require(candidate); break; }
  } catch (_) { /* try the next one */ }
}
// No rates module found: every cost figure stays 0 rather than guessed.

function rowCostUsd(r) {
  if (typeof r.costUsdModeled === "number") return r.costUsdModeled;
  if (!aiedsCost) return 0;
  try {
    const c = aiedsCost.costForRow(r);
    return c ? c.costUsd : 0;
  } catch (_) {
    return 0;
  }
}

// Aggregate the whole log (or the last N rows) into per-model totals.
function summary(limitRows = 0) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(LOG_PATH)) return resolve(null);
    const rows = [];
    const stream = fs.createReadStream(LOG_PATH, { encoding: "utf8" });
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { rows.push(JSON.parse(line)); } catch (_) {}
      }
    });
    stream.on("end", () => {
      try {
        if (buf.trim()) { try { rows.push(JSON.parse(buf.trim())); } catch (_) {} }
        const slice = limitRows > 0 ? rows.slice(-limitRows) : rows;
        const byModel = {};
        let totalTokens = 0, totalEnergyWh = 0, totalCarbonG = 0, totalTreeMin = 0;
        let totalCostUsd = 0, pricedRows = 0;
        for (const r of slice) {
          const m = r.model || "(unknown)";
          if (!byModel[m]) byModel[m] = { model: m, sessions: 0, tokensIn: 0, tokensOut: 0, tokensTotal: 0, energyWh: 0, carbonG: 0, treeTimeMin: 0, costUsd: 0 };
          const a = byModel[m];
          a.sessions += 1;
          a.tokensIn += r.tokensIn || 0;
          a.tokensOut += r.tokensOut || 0;
          a.tokensTotal += r.tokensTotal || 0;
          a.energyWh += r.energyWh || 0;
          a.carbonG += r.carbonG || 0;
          a.treeTimeMin += r.treeTimeMin || 0;
          const cost = rowCostUsd(r);
          if (cost > 0) {
            a.costUsd += cost;
            totalCostUsd += cost;
            pricedRows += 1;
          }
          totalTokens += r.tokensTotal || 0;
          totalEnergyWh += r.energyWh || 0;
          totalCarbonG += r.carbonG || 0;
          totalTreeMin += r.treeTimeMin || 0;
        }
        resolve({
          source: "aieds-local.jsonl",
          path: LOG_PATH,
          rows: slice.length,
          totalTokens,
          totalEnergyWh,
          totalCarbonG,
          totalTreeMin,
          // Modelled list price, and how many rows carried a priced model.
          totalCostUsd,
          pricedRows,
          byModel: Object.values(byModel),
        });
      } catch (e) { reject(e); }
    });
    stream.on("error", reject);
  });
}

// Time-series aggregate: one point per day (or per N days) for the chart.
// Each point carries tokens, energy, carbon, tree-time, a session count, the
// modelled cost, and response timing.
//
// avgResponseMs is a WEIGHTED mean: responseMsTotal / responseSamples across
// the day's rows, not the mean of per-row averages, so a session with 200
// responses counts for more than one with 3. Rows logged before the hook
// recorded timing carry no samples and simply do not contribute.
function series(days = 30) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(LOG_PATH)) return resolve([]);
    const rows = [];
    const stream = fs.createReadStream(LOG_PATH, { encoding: "utf8" });
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { rows.push(JSON.parse(line)); } catch (_) {}
      }
    });
    stream.on("end", () => {
      try {
        if (buf.trim()) { try { rows.push(JSON.parse(buf.trim())); } catch (_) {} }
        const byDay = {};
        const cutoff = Date.now() - days * 86400000;
        for (const r of rows) {
          const ts = r.tsUtc ? new Date(r.tsUtc).getTime() : 0;
          if (!ts || ts < cutoff) continue;
          const day = new Date(ts).toISOString().slice(0, 10);
          if (!byDay[day]) {
            byDay[day] = {
              day,
              sessions: 0,
              tokens: 0,
              energyWh: 0,
              carbonG: 0,
              treeTimeMin: 0,
              costUsd: 0,
              responseMsTotal: 0,
              responseSamples: 0,
              avgResponseMs: 0,
              activeMsTotal: 0,
            };
          }
          const d = byDay[day];
          d.sessions += 1;
          d.tokens += r.tokensTotal || 0;
          d.energyWh += r.energyWh || 0;
          d.carbonG += r.carbonG || 0;
          d.treeTimeMin += r.treeTimeMin || 0;
          d.costUsd += rowCostUsd(r);
          d.responseMsTotal += r.responseMsTotal || 0;
          d.responseSamples += r.responseSamples || 0;
          d.activeMsTotal += r.sessionActiveMs || 0;
        }
        // NB: not `days` - that is this function's parameter.
        const points = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
        for (const d of points) {
          d.avgResponseMs = d.responseSamples
            ? d.responseMsTotal / d.responseSamples
            : 0;
        }
        resolve(points);
      } catch (e) { reject(e); }
    });
    stream.on("error", reject);
  });
}

module.exports = { summary, series, LOG_PATH };
