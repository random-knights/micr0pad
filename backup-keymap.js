"use strict";
// backup-keymap.js - read the device keymap.json and save a byte-exact backup.
// Safe: read-only on the device. Restore later with `npm run restore-keymap`.
//
//   node backup-keymap.js            # writes keymap-backup.json, once
//   node backup-keymap.js --force    # overwrite an existing backup
//
// It REFUSES to overwrite an existing backup. That refusal is the point of
// the file: the first backup is the stock keymap, the only way back to a pad
// that behaves like the one you bought. Run this after add-layers or
// bind-dial-joy has flashed the device and a plain overwrite would replace
// the stock copy with the modified one, quietly, and the way back would be
// gone. The docs said this was already true. It was not, so it is now.
const fs = require("fs");
const path = require("path");
const { open } = require("./lib/wldevice");

const OUT = path.join(__dirname, "keymap-backup.json");
const force = process.argv.includes("--force");

if (fs.existsSync(OUT) && !force) {
  console.log(`A backup already exists: ${OUT}`);
  console.log("Leaving it alone. It is probably your stock keymap, and this");
  console.log("would replace it with whatever the device holds right now.");
  console.log("Pass --force if you are sure you want to overwrite it.");
  process.exit(0);
}

(async () => {
  const dev = open();
  try {
    const raw = await dev.call("fs.read", { file: "keymap.json" });
    fs.writeFileSync(OUT, JSON.stringify(raw, null, 2), "utf8");
    console.log("Backed up keymap to", OUT, `(${raw.data.length} chars of config)`);
    const version = await dev.call("sys.version");
    console.log("firmware:", version.version);
  } finally {
    dev.close();
    process.exit(0);
  }
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
