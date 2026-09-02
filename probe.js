"use strict";
// probe.js - inspect the attached Work Louder device: firmware, methods, keymap.
// Read-only; writes nothing to the device.
const { open } = require("./lib/wldevice");

(async () => {
  const dev = open();
  console.log("product:", dev.info.product);
  console.log("path:", dev.info.path);
  try { const v = await dev.call("sys.version"); console.log("firmware:", v.version); } catch (e) { console.log("sys.version:", e.message); }
  try { const s = await dev.call("device.status"); console.log("status:", JSON.stringify(s)); } catch (e) { console.log("device.status:", e.message); }
  for (const m of ["v.oai.thstatus", "v.oai.rgbcfg", "lights.preview"]) {
    try {
      const params = m === "v.oai.thstatus" ? [{ id: 0 }] : m === "v.oai.rgbcfg" ? { keys: {}, ambient: {} } : { backlight: {}, underglow: {} };
      const r = await dev.call(m, params);
      console.log(m, "->", JSON.stringify(r));
    } catch (e) { console.log(m, "ERROR:", e.message); }
  }
  try {
    const raw = await dev.call("fs.read", { file: "keymap.json" });
    try {
      const cfg = JSON.parse(raw.data);
      const layer = cfg.profiles[cfg.activeProfileId ?? 0].layers[0];
      console.log("keymap layout:", JSON.stringify(layer.layout));
    } catch (e) { console.log("keymap parse ERROR:", e.message); }
  } catch (e) { console.log("fs.read keymap ERROR:", e.message); }
  dev.close();
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
