"use strict";
// lights-off.js - blank the whole pad (threads + zones). The firmware keeps
// thread state over zone state, so both must be cleared.
const { open } = require("./lib/wldevice");
const pad = require("./lib/pad");

(async () => {
  const dev = open();
  try {
    const dark = Array.from({ length: pad.maxThreadID + 1 }, (_, id) => ({ id, b: 0, e: 0, sk: 0, sa: 0 }));
    await dev.call("v.oai.thstatus", dark);
    const z = { e: 0, b: 0, s: 0.5, m: 1, c: 0 };
    await dev.call("v.oai.rgbcfg", { keys: z, ambient: z });
    console.log("Pad turned off.");
  } finally {
    dev.close();
    process.exit(0);
  }
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
