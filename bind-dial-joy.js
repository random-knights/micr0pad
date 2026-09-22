"use strict";
// bind-dial-joy.js - bind the dial (encoder) and joystick to AG13-18 so the
// bridge can drive model cycling and navigation from the physical device.
//
//   encoder[0] = [CW, CCW, press]  -> AG13 (CW), AG14 (CCW)
//   joystick sectors (8 radial)    -> AG15 (N), AG16 (W), AG17 (S), AG18 (E)
//
// DANGER: this WRITES to the device (flash write). A backup is made first.
// Usage: node bind-dial-joy.js
const fs = require("fs");
const path = require("path");
const { open } = require("./lib/wldevice");

// The per-user directory (lib/paths.js), shared with the server, so a backup
// taken here is the one the page reverts from.
const BACKUP = require("./lib/paths").keymapBackupPath();

// Sector center -> direction, per the reference hacking.md table.
// 0.000 east, 0.125 NE, 0.250 north, 0.375 NW, 0.500 west,
// 0.625 SW, 0.750 south, 0.875 SE.
const CARDINALS = {
  0.25: "KV_OAI_AG15", // north
  0.50: "KV_OAI_AG16", // west
  0.75: "KV_OAI_AG17", // south
  0.00: "KV_OAI_AG18", // east
};
const centre = (a1, a2) => ((a2 >= a1 ? (a1 + a2) / 2 : (a1 + a2 + 1) / 2) % 1);

(async () => {
  const dev = open();
  try {
    const raw = await dev.call("fs.read", { file: "keymap.json" });
    const cfg = JSON.parse(raw.data);
    const layer = cfg.profiles[cfg.activeProfileId ?? 0].layers[0];

    // 1. Dial: bind encoder CW/CCW to AG13/AG14.
    if (layer.layout.encoders && layer.layout.encoders[0]) {
      layer.layout.encoders[0][0] = "KV_OAI_AG13"; // CW
      layer.layout.encoders[0][1] = "KV_OAI_AG14"; // CCW
    } else {
      throw new Error("no encoder[0] in layout");
    }

    // 2. Joystick: set radial sectors bound to AG15-18.
    // Sector i is centered on i/8 (0, 0.125, 0.25, ...) and spans 0.125 wide,
    // so a1 = (i-0.5)/8, a2 = (i+0.5)/8 (mod 1). The east sector wraps through 0.
    const sectors = [];
    for (let i = 0; i < 8; i++) {
      const c = i / 8;
      const a1 = ((i - 0.5) / 8 + 1) % 1;
      const a2 = ((i + 0.5) / 8) % 1;
      const hit = Object.keys(CARDINALS).find((k) => Math.abs(Number(k) - c) < 0.01);
      sectors.push({ a1, a2, k: hit ? CARDINALS[hit] : "KC_NO" });
    }
    layer.layout.joystick = { type: "RADIAL", sectors };

    // Write back.
    const out = JSON.stringify(cfg);
    const w = await dev.call("fs.write", { file: "keymap.json", data: out });
    console.log("write ->", JSON.stringify(w));

    // Verify by reading back.
    const after = await dev.call("fs.read", { file: "keymap.json" });
    const k2 = JSON.parse(after.data);
    const l2 = k2.profiles[k2.activeProfileId ?? 0].layers[0];
    console.log("encoders now:", JSON.stringify(l2.layout.encoders));
    console.log("joystick now:", JSON.stringify(l2.layout.joystick));
    console.log("byte-identical:", after.data === out);
  } finally {
    dev.close();
    process.exit(0);
  }
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
