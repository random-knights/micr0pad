"use strict";
// analytics-report.js - print what the local analytics log says.
//
//   npm run analytics
//
// Reads the file lib/analytics.js writes and totals it. If analytics were
// never turned on there is no file, and this says so rather than printing
// zeroes that look like measurements.

const analytics = require("../lib/analytics");
const config = require("../lib/config");

function format(ms) {
  const minutes = ms / 60000;
  if (minutes < 90) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

function main() {
  let cfg = {};
  try {
    cfg = config.load();
  } catch (_) {
    // No config yet is fine: analytics are off by default anyway.
  }
  const { enabled, logPath } = analytics.settings(cfg);
  const totals = analytics.summarizeFile(logPath);

  console.log(`analytics: ${enabled ? "on" : "off"}`);
  console.log(`log:       ${logPath}`);
  if (totals.runs === 0) {
    console.log("no runs recorded yet.");
    if (!enabled) {
      console.log('turn it on with "analytics": { "enabled": true } in config.json,');
      console.log("or MICR0PAD_ANALYTICS=1 in the environment.");
    }
    return;
  }
  console.log(`runs:      ${totals.runs}`);
  console.log(`ran for:   ${format(totals.sessionMs)}`);
  console.log(`pad on:    ${format(totals.deviceConnectedMs)}`);
  console.log(`repaints:  ${totals.padRepaints}`);
  console.log(`cpu time:  ${format(totals.hostCpuMs)}`);
  console.log("energy:    not modelled, no sourced power figure for this device");
}

if (require.main === module) main();

module.exports = { format, main };
