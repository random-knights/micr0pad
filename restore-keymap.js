"use strict";
// restore-keymap.js - restore the keymap from a backup file back to the device.
// DANGER: this WRITES to the device (flash write). Only run with a backup you
// made with backup-keymap.js. Usage: node restore-keymap.js [backupFile]
const fs = require("fs");
const path = require("path");
const { open } = require("./lib/wldevice");

(async () => {
  const backupFile = process.argv[2] || require("./lib/paths").keymapBackupPath();
  if (!fs.existsSync(backupFile)) { console.error("backup not found:", backupFile); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(backupFile, "utf8"));
  if (!raw.data) { console.error("backup has no .data string; wrong file?"); process.exit(1); }

  const dev = open();
  try {
    const r = await dev.call("fs.write", { file: "keymap.json", data: raw.data });
    console.log("write ->", JSON.stringify(r));
    // verify by reading back
    const after = await dev.call("fs.read", { file: "keymap.json" });
    console.log("restored byte-identical:", after.data === raw.data);
    console.log("You may need to re-run the bridge/app to re-bind per-key lighting.");
  } finally {
    dev.close();
    process.exit(0);
  }
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
