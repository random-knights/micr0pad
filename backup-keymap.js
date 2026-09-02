"use strict";
// backup-keymap.js - read the device keymap.json and save a byte-exact backup.
// Safe: read-only on the device. Restore later with fs.write of the same data.
const fs = require("fs");
const path = require("path");
const { open } = require("./lib/wldevice");

(async () => {
  const dev = open();
  try {
    const raw = await dev.call("fs.read", { file: "keymap.json" });
    const out = path.join(__dirname, "keymap-backup.json");
    fs.writeFileSync(out, JSON.stringify(raw, null, 2), "utf8");
    console.log("Backed up keymap to", out, `(${raw.data.length} chars of config)`);
    const version = await dev.call("sys.version");
    console.log("firmware:", version.version);
  } finally {
    dev.close();
    process.exit(0);
  }
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
