#!/usr/bin/env node
/*
 * aieds-local.js - AiEDs v2 logger for LOCAL Claude Code CLI sessions.
 *
 * WHAT THIS IS
 * A Claude Code hook target. Claude Code runs it at SessionEnd and hands it a
 * JSON payload on stdin. The script reads the session's real transcript,
 * adds up the real token counts the API reported, runs them through the SAME
 * AiEDs v2 formula the app uses, and appends one line per model to
 * aieds-local.jsonl (where: see WHERE THIS LIVES NOW below).
 *
 * WHAT THIS IS NOT
 * This does NOT write the app's Firestore collection users/{uid}/aiedsUsage.
 * That write needs per-user auth this script must not hold. This log is a
 * separate, clearly labelled local file. Every row carries
 * source:"claude-code-cli-local" so it can never be mistaken for an app row.
 *
 * THE FORMULA IS COPIED, NOT REINVENTED
 * The constants and the two functions below are a literal port of
 * the reference implementation in the hosted app's server code,
 *   functions/src/index.ts:
 *   lines 225-257    the constants and the per-model-prefix profiles
 *   lines 1210-1235  aiedsProfileForModel and estimateAiedsImpact
 * That TypeScript is itself a mirror of rk_ai lib/src/impact/ai_impact.dart,
 * and a Dart sync test pins the literals, so the numbers here match the app.
 * Do not "improve" these values. Change the app first, then re-copy.
 *
 * THE ONE JUDGEMENT CALL: WHAT COUNTS AS AN INPUT TOKEN
 * The app reads Anthropic's usage.input_tokens straight off a single-shot
 * call that uses no prompt caching, so input_tokens IS the whole prompt there.
 * Claude Code caches aggressively. In a cached turn input_tokens is often 2,
 * while tens of thousands of tokens arrive as cache_creation_input_tokens and
 * cache_read_input_tokens. Those tokens are still prefilled by the model and
 * still cost energy, so counting only input_tokens would understate a session
 * by roughly a thousand times.
 * So tokensIn here = input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens. The formula is unchanged; only the input figure fed
 * into it is defined for a cached client. Every row carries the raw breakdown
 * in tokensInBreakdown so the choice stays auditable.
 *
 * TWO TRANSCRIPT FACTS THIS RELIES ON (verified against real files, not docs)
 * 1. One API response is written as SEVERAL transcript lines, one per content
 *    block (thinking, text, tool_use...), and each line repeats the IDENTICAL
 *    usage object. Checked on a real 1363-row session: 518 message ids
 *    appeared more than once, and every repeat carried byte-identical usage.
 *    Summing every line would multiply the real number. Rows are therefore
 *    deduplicated by message.id.
 * 2. Subagent turns are NOT in the main transcript. They live in
 *    <transcript-dir>/<session-id>/subagents/agent-*.jsonl and can run a
 *    different model. They burn real energy, so they are included.
 *
 * TIMING (added 2026-09-01)
 * The transcript has no duration field, but every row carries an ISO timestamp,
 * so three timings are derived and each is labelled for what it is:
 *   sessionDurationMs - wall clock from the first to the last row counted in
 *     this run. Includes idle time; a session left open overnight is hours.
 *   sessionActiveMs   - the same span with every gap longer than IDLE_GAP_CAP_MS
 *     dropped, i.e. time the session was actually doing something.
 *   avgResponseMs     - per model, the mean gap between the previous transcript
 *     row and the assistant row that answered it, gaps over RESPONSE_CAP_MS
 *     discarded as think time / idle. responseMsTotal and responseSamples are
 *     emitted with it so any average can be recomputed or re-weighted.
 * Rows written before this change have none of these fields. Nothing back-fills
 * them - the timings are only as good as the transcript still on disk.
 *
 * COST (added 2026-09-01)
 * Claude Code here is subscription billed, so no per-token money changes hands.
 * costUsdModeled is what the same tokens would cost at published API list
 * prices, and it is only ever produced from lib/aieds-rates.json - a model
 * the owner has not priced there gets NO cost field rather than a guess. The
 * arithmetic lives in lib/aieds-cost.js and prices cache writes and cache
 * reads at their own multipliers, which matters enormously for a cache-heavy
 * client. Every priced row carries costBasis:"list-price-modeled" and the
 * ratesVersion that produced it.
 *
 * SAFETY
 * Never blocks a session: every failure path writes a diagnostic line to
 * aieds-local.log beside the log and exits 0.
 * Never invents a number: if no usage rows are found, NOTHING is appended.
 *
 * WHERE THIS LIVES NOW
 * This ships inside the micr0pad repo (hooks/aieds-local.js). Point Claude
 * Code at it from ~/.claude/settings.json:
 *   "hooks": { "SessionEnd": [ { "hooks": [
 *     { "type": "command", "command": "node",
 *       "args": ["<path-to-repo>/hooks/aieds-local.js"] } ] } ] }
 * The log defaults to aieds-local.jsonl in the per-user micr0pad directory
 * (lib/paths.js: %APPDATA%\micr0pad on Windows, ~/Library/Application
 * Support/micr0pad on macOS, $XDG_CONFIG_HOME/micr0pad or ~/.config/micr0pad
 * on Linux), which is where the server looks first. Set AIEDS_LOG_PATH to put
 * it somewhere else, and set the SAME value for the server so the reader and
 * the writer agree on one file.
 *
 * MANUAL RUN (for testing, same code path as the hook):
 *   node aieds-local.js --transcript <path-to-session.jsonl>
 *   node aieds-local.js --transcript <path> --dry-run
 *   node aieds-local.js --transcript <path> --reset-cursor
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Shared with any reader that wants a cost for older rows; see the COST note
// above. Loaded defensively: a missing rates file must not break the logger.
let aiedsCost = null;
for (const candidate of ["../lib/aieds-cost", "./aieds-cost"]) {
  try {
    aiedsCost = require(candidate);
    break;
  } catch (_) { /* try the next location */ }
}

// A gap longer than this is idle, not work. Used for sessionActiveMs and to
// discard a "response" that is really a user coming back from lunch.
const IDLE_GAP_CAP_MS = 5 * 60 * 1000;
const RESPONSE_CAP_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// AiEDs impact model v2 - literal copy of functions/src/index.ts 225-257.
// Energy-first (never energy-from-carbon).
// ---------------------------------------------------------------------------

const aiedsImpactModelVersion = "v2";
const aiedsGridIntensityGramsCo2ePerKwh = 429.0; // modelled global avg
const aieds_matureTreeCo2eGramsPerYear = 21000.0; // 21 kg CO2e/year MRT
const aieds_minutesPerYear = 525600.0;

// whPer1kOut is always 4x whPer1kIn (decode sequential, prefill parallel).
// pue is 1.0 when the vendor basis figure is already all-in.
const aiedsEnergyProfiles = [
  { prefixes: ["gemini"], whPer1kIn: 0.12, whPer1kOut: 0.48, pue: 1.0, confidence: "vendorPublished" },
  { prefixes: ["gpt", "o1", "o3", "o4", "chatgpt"], whPer1kIn: 0.17, whPer1kOut: 0.68, pue: 1.0, confidence: "vendorPublished" },
  { prefixes: ["claude"], whPer1kIn: 0.145, whPer1kOut: 0.58, pue: 1.2, confidence: "classEstimated" },
  { prefixes: ["grok"], whPer1kIn: 0.145, whPer1kOut: 0.58, pue: 1.2, confidence: "unknown" },
];
const aiedsUnknownProfile = {
  prefixes: [],
  whPer1kIn: 0.145,
  whPer1kOut: 0.58,
  pue: 1.2,
  confidence: "unknown",
};

function aiedsProfileForModel(modelId) {
  const id = (modelId ?? "").trim().toLowerCase();
  for (const profile of aiedsEnergyProfiles) {
    if (profile.prefixes.some((prefix) => id.startsWith(prefix))) {
      return profile;
    }
  }
  return aiedsUnknownProfile;
}

/** v2: energy from tokens (output 4x input) -> carbon -> tree-time. */
function estimateAiedsImpact(modelId, inputTokens, outputTokens) {
  const profile = aiedsProfileForModel(modelId);
  const energyWh =
    ((inputTokens / 1000) * profile.whPer1kIn +
      (outputTokens / 1000) * profile.whPer1kOut) *
    profile.pue;
  const carbonG = (energyWh / 1000) * aiedsGridIntensityGramsCo2ePerKwh;
  const treeTimeMin =
    (carbonG / aieds_matureTreeCo2eGramsPerYear) * aieds_minutesPerYear;
  return { energyWh, carbonG, treeTimeMin, confidence: profile.confidence };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// AIEDS_LOG_PATH wins so the writer and the reader (lib/aieds.js, same env var)
// can be pointed at one file; otherwise everything sits in the per-user
// directory, which survives an npx upgrade where the app directory does not.
const OUT_PATH = process.env.AIEDS_LOG_PATH
  ? path.resolve(process.env.AIEDS_LOG_PATH)
  : path.join(require("../lib/paths").dataDir(), "aieds-local.jsonl");
const STATE_DIR = path.dirname(OUT_PATH);
const CURSOR_PATH = path.join(STATE_DIR, "aieds-local-cursor.json");
const LOG_PATH = path.join(STATE_DIR, "aieds-local.log");
const LAST_PAYLOAD_PATH = path.join(STATE_DIR, "aieds-hook-last-payload.json");

// The per-user directory does not exist until something writes to it, and a
// hook may well be the first thing that does. Never throws.
function ensureStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (_) {
    // The write that follows reports the real failure.
  }
}

function diag(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    ensureStateDir();
    fs.appendFileSync(LOG_PATH, line, "utf8");
  } catch (_) {
    // Nothing useful left to do; never throw out of a hook.
  }
}

// ---------------------------------------------------------------------------
// Cursor - so a RESUMED session is not counted twice.
// Claude Code appends to the same transcript file when a session resumes, and
// SessionEnd fires again. The cursor records how many bytes of each transcript
// file have already been accounted for. Lines are whole JSON objects, so a
// byte offset always lands on a line boundary.
// ---------------------------------------------------------------------------

function readCursor() {
  try {
    return JSON.parse(fs.readFileSync(CURSOR_PATH, "utf8"));
  } catch (_) {
    return {};
  }
}

function writeCursor(cursor) {
  try {
    ensureStateDir();
    fs.writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2), "utf8");
  } catch (err) {
    diag(`cursor write failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Transcript reading
// ---------------------------------------------------------------------------

/**
 * Main transcript plus every subagent transcript for the same session.
 * Paths are run through path.resolve so the cursor keys are stable. The hook
 * payload gives a backslash path and a manual --transcript run may give a
 * forward-slash one; unnormalised they look like two different files and the
 * same session gets counted twice.
 */
function transcriptFilesFor(mainTranscriptPath) {
  const main = path.resolve(mainTranscriptPath);
  const files = [];
  if (fs.existsSync(main)) files.push(main);

  const dir = path.dirname(main);
  const sessionId = path.basename(main, ".jsonl");
  const subagentDir = path.join(dir, sessionId, "subagents");
  try {
    for (const name of fs.readdirSync(subagentDir)) {
      if (name.startsWith("agent-") && name.endsWith(".jsonl")) {
        files.push(path.resolve(path.join(subagentDir, name)));
      }
    }
  } catch (_) {
    // No subagents ran in this session. Normal.
  }
  return files;
}

/**
 * Read one transcript file from `startByte` to EOF and fold its assistant
 * usage rows into `acc`, deduplicating by message.id. Timestamps from EVERY
 * row (not just the counted ones) feed `span`, which carries the session
 * wall-clock and active-time totals.
 * Returns the byte length actually consumed.
 */
function foldTranscript(filePath, startByte, acc, seenIds, span) {
  const size = fs.statSync(filePath).size;
  if (startByte >= size) return size;

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, {
      start: startByte,
      encoding: "utf8",
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    // Previous row's timestamp WITHIN THIS FILE. Latency is measured against
    // the row that preceded a response in the same transcript; a subagent file
    // has its own clock and its own chain.
    let prevTs = NaN;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let row;
      try {
        row = JSON.parse(line);
      } catch (_) {
        return; // A partially flushed final line. Skip it, never guess at it.
      }

      const ts = row && row.timestamp ? Date.parse(row.timestamp) : NaN;
      let gapFromPrev = NaN;
      if (Number.isFinite(ts)) {
        if (!Number.isFinite(span.firstTs) || ts < span.firstTs) span.firstTs = ts;
        if (!Number.isFinite(span.lastTs) || ts > span.lastTs) span.lastTs = ts;
        if (Number.isFinite(prevTs)) {
          gapFromPrev = ts - prevTs;
          if (gapFromPrev > 0 && gapFromPrev <= IDLE_GAP_CAP_MS) {
            span.activeMs += gapFromPrev;
          }
        }
        prevTs = ts;
      }

      const msg = row && row.message;
      if (!msg || !msg.usage || row.type !== "assistant") return;

      const id = msg.id;
      if (!id || seenIds.has(id)) return; // See transcript fact 1 in the header.
      seenIds.add(id);

      const u = msg.usage;
      const model = msg.model || "(unknown)";
      const inPlain = Number(u.input_tokens) || 0;
      const inCacheCreate = Number(u.cache_creation_input_tokens) || 0;
      const inCacheRead = Number(u.cache_read_input_tokens) || 0;
      const out = Number(u.output_tokens) || 0;

      if (!acc[model]) {
        acc[model] = {
          tokensIn: 0,
          tokensOut: 0,
          inPlain: 0,
          inCacheCreate: 0,
          inCacheRead: 0,
          messages: 0,
          subagentMessages: 0,
          responseMsTotal: 0,
          responseSamples: 0,
          claudeCodeVersion: undefined,
        };
      }
      const a = acc[model];
      if (row.version) a.claudeCodeVersion = row.version;
      a.tokensIn += inPlain + inCacheCreate + inCacheRead;
      a.tokensOut += out;
      a.inPlain += inPlain;
      a.inCacheCreate += inCacheCreate;
      a.inCacheRead += inCacheRead;
      a.messages += 1;
      if (row.isSidechain) a.subagentMessages += 1;
      // Turnaround for this response: the gap since the row that prompted it.
      // Only the first content block of a response survives the id dedup, so
      // this is measured once per response, not once per block.
      if (Number.isFinite(gapFromPrev) && gapFromPrev > 0 && gapFromPrev <= RESPONSE_CAP_MS) {
        a.responseMsTotal += gapFromPrev;
        a.responseSamples += 1;
      }
    });

    rl.on("close", () => resolve(size));
    stream.on("error", (err) => {
      diag(`read failed ${filePath}: ${err.message}`);
      resolve(startByte);
    });
  });
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(data);
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 3000).unref(); // Never hang a session end.
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dryRun = argv.includes("--dry-run");
  const resetCursor = argv.includes("--reset-cursor");

  const raw = await readStdin();
  let payload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      diag(`stdin was not JSON (${err.message}); first 200 chars: ${raw.slice(0, 200)}`);
    }
  }

  // Keep the last raw payload on disk. Hook payload shapes change between
  // Claude Code versions, and this is the only honest record of what arrived.
  if (raw.trim()) {
    try {
      ensureStateDir();
      fs.writeFileSync(LAST_PAYLOAD_PATH, raw, "utf8");
    } catch (err) {
      diag(`could not save last payload: ${err.message}`);
    }
  }

  const transcriptPath = argOf("--transcript") || payload.transcript_path;
  if (!transcriptPath) {
    diag(
      "no transcript path: neither --transcript nor payload.transcript_path. " +
        `payload keys: [${Object.keys(payload).join(",")}]`,
    );
    return;
  }
  if (!fs.existsSync(transcriptPath)) {
    diag(`transcript path does not exist: ${transcriptPath}`);
    return;
  }

  const sessionId =
    payload.session_id || path.basename(transcriptPath, ".jsonl");

  const cursor = readCursor();
  if (resetCursor) delete cursor[sessionId];
  const sessionCursor = cursor[sessionId] || {};
  // Normalise any keys written by an older build of this script.
  for (const key of Object.keys(sessionCursor)) {
    const resolved = path.resolve(key);
    if (resolved !== key) {
      sessionCursor[resolved] = Math.max(
        Number(sessionCursor[resolved]) || 0,
        Number(sessionCursor[key]) || 0,
      );
      delete sessionCursor[key];
    }
  }

  const files = transcriptFilesFor(transcriptPath);
  const acc = {};
  const seenIds = new Set();
  const nextCursor = {};
  const span = { firstTs: NaN, lastTs: NaN, activeMs: 0 };
  for (const file of files) {
    const start = Number(sessionCursor[file]) || 0;
    // eslint-disable-next-line no-await-in-loop
    nextCursor[file] = await foldTranscript(file, start, acc, seenIds, span);
  }

  const models = Object.keys(acc);
  if (models.length === 0) {
    diag(
      `no new assistant usage rows for session ${sessionId} ` +
        `(${files.length} transcript file(s) already at cursor). Nothing appended.`,
    );
    return;
  }

  const tsUtc = new Date().toISOString();
  // Session-level timings for the segment counted in THIS run. They repeat on
  // every model row of the session: averaging across rows gives the session
  // figure back, summing them would multiply it by the model count.
  const sessionDurationMs =
    Number.isFinite(span.firstTs) && Number.isFinite(span.lastTs)
      ? Math.max(0, span.lastTs - span.firstTs)
      : undefined;
  const sessionActiveMs = Number.isFinite(span.activeMs)
    ? Math.round(span.activeMs)
    : undefined;
  const lines = [];
  for (const model of models.sort()) {
    const a = acc[model];
    const impact = estimateAiedsImpact(model, a.tokensIn, a.tokensOut);
    lines.push({
      // Same field names as the app's users/{uid}/aiedsUsage doc.
      tsUtc,
      provider: "anthropic",
      model,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      tokensTotal: a.tokensIn + a.tokensOut,
      carbonG: impact.carbonG,
      energyWh: impact.energyWh,
      treeTimeMin: impact.treeTimeMin,
      aiedsModelVersion: aiedsImpactModelVersion,
      aiedsConfidence: impact.confidence,
      // Timings, all derived from transcript timestamps. See TIMING in the
      // header for exactly what each one measures.
      sessionDurationMs,
      sessionActiveMs,
      avgResponseMs: a.responseSamples
        ? Math.round(a.responseMsTotal / a.responseSamples)
        : undefined,
      responseMsTotal: a.responseSamples ? Math.round(a.responseMsTotal) : undefined,
      responseSamples: a.responseSamples || undefined,
      // Local-only provenance. Not in the app doc, and deliberately loud:
      // these rows must never be mistaken for app telemetry.
      // costUsdModeled below is a LIST PRICE, not a bill: this client is
      // subscription billed. See COST in the header.
      source: "claude-code-cli-local",
      sessionId,
      hookEvent: payload.hook_event_name || (argOf("--transcript") ? "manual" : "unknown"),
      sessionEndReason: payload.reason,
      cwd: payload.cwd,
      // From the transcript rows themselves; the SessionEnd payload does not
      // carry a version field in Claude Code 2.1.220.
      claudeCodeVersion: a.claudeCodeVersion,
      assistantMessages: a.messages,
      subagentMessages: a.subagentMessages,
      tokensInBreakdown: {
        input: a.inPlain,
        cacheCreation: a.inCacheCreate,
        cacheRead: a.inCacheRead,
      },
      transcriptFiles: files.length,
    });
  }

  // Stamp the modelled cost on each row. A model with no entry in
  // aieds-rates.json is left without any cost field, on purpose.
  if (aiedsCost) {
    for (const line of lines) {
      let cost = null;
      try {
        cost = aiedsCost.costForRow(line);
      } catch (err) {
        diag(`cost model failed for ${line.model}: ${err.message}`);
      }
      if (cost) {
        line.costUsdModeled = cost.costUsd;
        line.costBasis = cost.costBasis;
        line.costInputBasis = cost.costInputBasis;
        line.costRatesVersion = cost.costRatesVersion;
        line.costCurrency = cost.costCurrency;
      }
    }
  }

  if (dryRun) {
    process.stdout.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return;
  }

  try {
    ensureStateDir();
    fs.appendFileSync(
      OUT_PATH,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );
  } catch (err) {
    diag(`append to ${OUT_PATH} failed: ${err.message}`);
    return;
  }

  // MERGE, do not replace: a run that saw fewer files than a previous run
  // must not drop the offsets it did not look at.
  cursor[sessionId] = { ...sessionCursor, ...nextCursor };
  writeCursor(cursor);
  diag(
    `appended ${lines.length} row(s) for session ${sessionId} ` +
      `(models: ${models.join(", ")})`,
  );
}

main()
  .catch((err) => {
    diag(`unhandled: ${err && err.stack ? err.stack : String(err)}`);
  })
  .finally(() => {
    process.exit(0); // A telemetry hook must never fail a session.
  });
