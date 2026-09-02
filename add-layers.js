"use strict";
/*
 * add-layers.js - give the touch sensor something to cycle through.
 *
 * WHY THIS EXISTS
 * The Work Louder setup guide says "tap the sensor to cycle through the layers",
 * up to six. On this unit keymap.json defines exactly ONE layer, while the
 * firmware reports layer_index 1 - an index that does not exist - so tapping
 * has nothing to move to. This script copies the current layer into additional
 * layers so the sensor has real destinations.
 *
 * WHAT IT COPIES
 * Every new layer is a byte-copy of the active layer's layout, so the pad keeps
 * working identically whichever layer is selected: the six agent keys stay
 * AG-bound (only AG-bound keys can be lit), the action keys stay mapped, and
 * the dial and joystick keep their AG13-18 bindings. Only id, name and colour
 * differ. Edit the layouts afterwards in Work Louder's Input app if you want
 * the layers to actually differ.
 *
 * DANGER: this WRITES to the device (flash write).
 * A backup is required and is never overwritten - keymap-backup.json here is
 * the ORIGINAL pre-bind-dial-joy keymap and is the only way back to stock.
 * Take one with `npm run backup-keymap` first if it is missing.
 *
 * USAGE
 *   node add-layers.js            # dry run: prints what it would write
 *   node add-layers.js --write    # actually writes, then reads back to verify
 *   node add-layers.js --write --layers 4
 */

const fs = require("fs");
const path = require("path");
const { open } = require("./lib/wldevice");

const BACKUP = path.join(__dirname, "keymap-backup.json");
const LAYER_COLORS = ["#ff4124", "#00b0ff", "#00c853", "#e8bf03", "#7c4dff", "#90a4ae"];

(async () => {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const wantIdx = argv.indexOf("--layers");
  const want = wantIdx >= 0 ? Math.max(2, Math.min(6, Number(argv[wantIdx + 1]) || 3)) : 3;

  if (!fs.existsSync(BACKUP)) {
    console.error(
      "No keymap-backup.json. Run `npm run backup-keymap` first - without it there is no way back to stock.",
    );
    process.exit(1);
  }

  const dev = open();
  try {
    const raw = await dev.call("fs.read", { file: "keymap.json" });
    const cfg = JSON.parse(raw.data);
    const profile = cfg.profiles[cfg.activeProfileId ?? 0];
    const layers = profile.layers || [];
    console.log(`current: ${cfg.profiles.length} profile(s), ${layers.length} layer(s)`);
    if (layers.length >= want) {
      console.log(`already has ${layers.length} layers; nothing to do.`);
      return;
    }

    const base = layers[0];
    const usedIds = new Set(layers.map((l) => l.id));
    let nextId = 1;
    while (layers.length < want) {
      while (usedIds.has(nextId)) nextId += 1;
      const copy = JSON.parse(JSON.stringify(base));
      copy.id = nextId;
      copy.name = `Layer ${layers.length + 1}`;
      copy.color = LAYER_COLORS[layers.length % LAYER_COLORS.length];
      usedIds.add(nextId);
      layers.push(copy);
    }
    profile.layers = layers;
    const out = JSON.stringify(cfg);
    console.log(`would write ${layers.length} layers (${out.length} bytes):`,
      layers.map((l) => `${l.id}:${l.name}`).join(", "));

    if (!write) {
      console.log("dry run - pass --write to apply.");
      return;
    }

    await dev.call("fs.write", { file: "keymap.json", data: out });
    // The firmware returns ok for anything, so verify by reading back.
    const after = await dev.call("fs.read", { file: "keymap.json" });
    const verified = after.data === out;
    const back = JSON.parse(after.data);
    const n = (back.profiles[back.activeProfileId ?? 0].layers || []).length;
    console.log(`wrote. byte-identical read-back: ${verified}; layers on device now: ${n}`);
    console.log("Tap the touch sensor to cycle. The LEDs show the active layer.");
  } finally {
    dev.close();
    process.exit(0);
  }
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
