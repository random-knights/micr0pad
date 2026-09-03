"use strict";
// app.js - RK MicroPad UI: render the pad mirror, live slot table, action keys,
// light test, slot name/color editor, underglow editor, and debug panel.
// Polls /api/state and /api/debug.
const state = { assigned: [], config: null, deviceUp: false, debug: null };
// Track the last config JSON so the editors (slot names/colors, underglow) are
// only rebuilt when the config actually changes. Rebuilding them on every poll
// destroys an open <select> mid-interaction (the outer-light dropdown could
// never be used because the 2.5s poll wiped it before the click landed).
let lastConfigJson = "";

// Physical pad layout: reading order. Firmware ids per key. The keymap layout
// (verified live via probe) is in physical reading order: row0 = [AG00, AG01],
// so key 0 is the top-LEFT key and key 1 the top-RIGHT key.
const LAYOUT = [
  [0, 1],
  [2, 3, 4, 5],
  [6, 7, 8, 9],
  [10, 11, 12],
];
// Default key labels (firmware id -> name). Slot names override the top 6.
const KEY_NAMES = {
  0: "claude 1", 1: "claude 2", 2: "codex", 3: "gemini", 4: "grok", 5: "huggingface",
  6: "bolt", 7: "check", 8: "x", 9: "fork", 10: "talk", 11: "talk", 12: "cmd",
};

async function getJSON(url) {
  const r = await fetch(url);
  return await r.json();
}

// Slot names live in config.json. Every tile reads them through here, so a
// rename lands on the pad mirror, the Live Slots table and the light test at
// the same moment - not whenever the device bridge next re-snapshots.
function slotName(slot, fallback) {
  if (state.config && Array.isArray(state.config.slots)) {
    const s = state.config.slots.find((x) => x.slot === slot);
    if (s && typeof s.name === "string" && s.name.trim()) return s.name;
  }
  return fallback || "";
}

// Map firmware key id -> slot config (for names/colors).
function slotByKey() {
  const m = {};
  if (state.config && state.config.slots) {
    for (const s of state.config.slots) m[assignedKeyID(s.slot)] = s;
  }
  return m;
}
function assignedKeyID(slot) {
  // firmware key for a slot: slot 0 (claude 1) = top-left key 0, slot 1
  // (claude 2) = top-right key 1. Matches pad.js agentKeyIDs.
  return [0, 1, 2, 3, 4, 5][slot];
}

// The dial and the toggle mirror the device's encoder and joystick, and drive
// the same bridge methods the physical controls do (cycleModel / joyDirection),
// so the two paths cannot drift.
//   dial   - click cycles the focused agent's model forward (encoder CW),
//            right-click cycles it back (CCW).
//   toggle - click moves to the next Herdr pane (joystick east), right-click to
//            the previous one (west).
// Both flash when the PHYSICAL control is used, via the agkey SSE event.
function makeKnob(kind) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "pad-knob pad-knob-" + kind;
  el.dataset.knob = kind;
  el.innerHTML = '<span class="lbl">' + kind + "</span>";
  el.disabled = true;
  el.classList.add("is-disabled");
  el.title = kind === "dial"
    ? "Dial: mirrors the physical encoder. The on-screen control is not wired."
    : "Toggle: mirrors the physical joystick. The on-screen control is not wired.";
  const fire = async (forward) => {
    el.classList.add("knob-active");
    const url = kind === "dial" ? "/api/dial" : "/api/joy";
    const body = kind === "dial"
      ? { dir: forward ? 1 : -1 }
      : { dir: forward ? "e" : "w" };
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      // The bridge's own notice ("no focused agent to retune", "model -> x")
      // is the honest result here, so show it rather than a fake tick.
      if (j.note) knobNote(el, j.note);
      else if (!j.ok) knobNote(el, j.error || "failed");
    } catch (e) {
      knobNote(el, e.message);
    }
    setTimeout(() => el.classList.remove("knob-active"), 400);
  };
  // Handlers deliberately not attached while the control is display-only.
  void fire;
  return el;
}

function knobNote(el, text) {
  const box = document.getElementById("knobNote");
  if (!box) return;
  box.textContent = text;
  clearTimeout(knobNote.timer);
  knobNote.timer = setTimeout(() => { box.textContent = ""; }, 4000);
}

// The two marks in the Micropad heading turn over to credit their subjects:
// the developer mark names schacon's micro-manager, whose reverse engineering
// of this device made the bridge possible, and the engineer mark names the
// org that built this. The link inside must not re-flip the card on its way
// out, hence the credit-link guard.
// Revert puts the device back to the keymap captured in keymap-backup.json,
// which is the ORIGINAL layout from before bind-dial-joy.js rewrote the encoder
// and joystick. It is a flash write, so it asks first and reports what the
// read-back verification actually said rather than assuming success.
// The pad speaks to ONE host at a time: over USB on whichever machine holds
// the cable, or over one of the firmware's three BLE channels. Firmware v0.4.1
// exposes no BLE method over the vendor RPC (ble.status / ble.list /
// ble.channel all answer "Method not found", and the device filesystem holds
// only keymap.json), so the app CANNOT switch channels itself. What it can do
// is get out of the way - release the device - and show the exact key sequence,
// which is the manual path the firmware supports.
const BANDS = [
  { id: "usb", label: "USB-C", hint: "wired to this PC" },
  { id: "ble1", label: "BLE 1", hint: "hold sensor 3s, tap to channel 1" },
  { id: "ble2", label: "BLE 2", hint: "hold sensor 3s, tap to channel 2" },
  { id: "ble3", label: "BLE 3", hint: "hold sensor 3s, tap to channel 3" },
];

function renderBands() {
  const box = document.getElementById("bandList");
  if (!box) return;
  box.innerHTML = "";
  for (const b of BANDS) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "band" + (b.id === "usb" && state.deviceUp && !state.pairing ? " is-live" : "");
    el.innerHTML = '<span class="band-dot"></span><span>' + esc(b.label) + "</span>" +
      '<span class="band-hint">' + esc(b.hint) + "</span>";
    el.title = b.id === "usb"
      ? "This app talks to the pad over USB on this machine"
      : "Firmware v0.4.1 has no BLE control over USB, so this cannot be switched from the app. Click to release the device, then use the touch sensor.";
    el.onclick = async () => {
      if (b.id === "usb") {
        // Coming back to USB means taking the device back.
        if (state.pairing) await setPairing(false);
        knobNote(el, "USB is the live band while the cable is in this machine");
        return;
      }
      if (!state.pairing) await setPairing(true);
      knobNote(el, b.label + ": hold the touch sensor 3s until the underglow turns blue, then tap to reach the channel");
    };
    box.appendChild(el);
  }
}

// Shared by the bands and the pair button.
async function setPairing(active) {
  try {
    const r = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !!active }),
    });
    const j = await r.json();
    if (j.ok) {
      state.pairing = !!j.pairing;
      if (window.setPairButtonState) window.setPairButtonState(state.pairing);
      renderBands();
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function wirePairButton() {
  const btn = document.getElementById("pairMode");
  if (!btn) return;
  const paint = (on) => {
    btn.classList.toggle("is-on", on);
    btn.textContent = on ? "pairing..." : "pair";
    btn.title = on
      ? "Lights are released to the device. Hold the touch sensor 3s for BLE, tap to change channel. Click again to take the lights back."
      : "Release the LEDs so the device can show its own lighting and BLE pairing state";
  };
  paint(!!(state.config && state.pairing));
  btn.onclick = async () => {
    const turningOn = !btn.classList.contains("is-on");
    btn.disabled = true;
    const ok = await setPairing(turningOn);
    if (ok) {
      paint(state.pairing);
      knobNote(btn, state.pairing
        ? "device released - hold the touch sensor 3s for BLE, tap to pick a channel"
        : "device back under app control");
    } else {
      knobNote(btn, "pair failed");
    }
    btn.disabled = false;
  };
  // Keep the button honest if the mode is changed from elsewhere.
  window.setPairButtonState = paint;
}
wirePairButton();

async function wireKeymapButtons() {
  const revert = document.getElementById("revertKeymap");
  const backup = document.getElementById("backupKeymap");
  if (!revert || !backup) return;
  const say = (text) => knobNote(revert, text);

  let info = { exists: false };
  try { info = await getJSON("/api/keymap/backup-info"); } catch (_) { /* old server */ }
  // No backup means nothing to revert TO, and taking one now is the only way
  // to get a restore point - so that is the button we show instead.
  backup.hidden = !!info.exists;
  revert.disabled = !info.exists;
  revert.title = info.exists
    ? "Write the original keymap back to the device (saved " + String(info.savedAt || "").slice(0, 10) + ")"
    : "No keymap-backup.json yet - back up first";

  backup.onclick = async () => {
    backup.disabled = true;
    try {
      const r = await fetch("/api/keymap/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const j = await r.json();
      say(j.ok ? "keymap backed up - revert is now available" : "backup failed: " + (j.error || r.status));
      if (j.ok) { backup.hidden = true; revert.disabled = false; }
    } catch (e) {
      say("backup failed: " + e.message);
    }
    backup.disabled = false;
  };

  revert.onclick = async () => {
    const ok = confirm(
      "Restore the device to its original keymap?\n\n" +
      "This is a flash write. The pad's agent keys, dial and joystick bindings go back to stock, " +
      "so the status lights and the dial stop working until you run bind-dial-joy.js again.",
    );
    if (!ok) return;
    revert.disabled = true;
    say("restoring keymap...");
    try {
      const r = await fetch("/api/keymap/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json();
      say(j.ok ? j.note : "revert failed: " + (j.error || j.note || r.status));
    } catch (e) {
      say("revert failed: " + e.message);
    }
    revert.disabled = false;
  };
}
wireKeymapButtons();

function wireCreditFlip() {
  for (const el of document.querySelectorAll(".mark-flip")) {
    el.onclick = (e) => {
      if (e.target.closest(".credit-link")) return;
      el.classList.toggle("is-flipped");
    };
  }
}
wireCreditFlip();

// Physical dial / joystick presses flash the matching on-screen control.
function flashKnob(index) {
  const kind = index === 13 || index === 14 ? "dial" : (index >= 15 && index <= 18 ? "toggle" : null);
  if (!kind) return;
  const el = document.querySelector('.pad-knob-' + kind);
  if (!el) return;
  el.classList.add("knob-active");
  setTimeout(() => el.classList.remove("knob-active"), 400);
}

function renderPad() {
  const padEl = document.getElementById("pad");
  padEl.innerHTML = "";
  const byKey = {};
  if (state.assigned) for (const s of state.assigned) byKey[s.keyID] = s;
  const slots = slotByKey();
  const makeKey = (k, extraClass) => {
    const keyEl = document.createElement("div");
    keyEl.className = "pad-key" + (extraClass ? " " + extraClass : "");
    const info = byKey[k];
    const slotCfg = slots[k];
    const label = (slotCfg && slotCfg.name) || KEY_NAMES[k] || k;
    keyEl.innerHTML = `<span class="lbl">${label}</span>` +
      (info && info.agent ? `<span class="state">${info.agent.status}</span>` : "");
    if (info && info.agent) keyEl.classList.add("lit-" + info.agent.status);
    else keyEl.classList.add("off");
    return keyEl;
  };
  // Top row: dial | claude 1 | claude 2 | toggle. The dial and the toggle are
  // the physical encoder and joystick - they sit in the outer columns, over
  // the first and last keys of the row below, matching the hardware.
  const row0 = document.createElement("div");
  row0.className = "pad-row pad-row-top";
  row0.appendChild(makeKnob("dial"));
  row0.appendChild(makeKey(0));
  row0.appendChild(makeKey(1));
  row0.appendChild(makeKnob("toggle"));
  padEl.appendChild(row0);
  const row1 = document.createElement("div");
  row1.className = "pad-row";
  for (const k of [2, 3, 4, 5]) row1.appendChild(makeKey(k));
  padEl.appendChild(row1);
  // Bottom action area as a grid:
  //   row1: bolt, check, x, fork
  //   row2: talk (double width, firmware keys 10+11) then cmd on the right
  const grid = document.createElement("div");
  grid.className = "pad-grid";
  const bolt = makeKey(6); bolt.style.gridArea = "1 / 1";
  const check = makeKey(7); check.style.gridArea = "1 / 2";
  const x = makeKey(8); x.style.gridArea = "1 / 3";
  const fork = makeKey(9); fork.style.gridArea = "1 / 4";
  // Bottom row is right-aligned in the 4-column grid: talk (firmware keys
  // 10+11) spans the middle two columns, under check and x, and cmd (key 12)
  // sits in the last column under fork.
  const talk = makeKey(10, "mic"); talk.style.gridArea = "2 / 2 / 2 / 4";
  const cmd = makeKey(12); cmd.style.gridArea = "2 / 4";
  grid.appendChild(bolt); grid.appendChild(check); grid.appendChild(x);
  grid.appendChild(fork); grid.appendChild(cmd); grid.appendChild(talk);
  padEl.appendChild(grid);
}

function renderSlots() {
  const tbody = document.querySelector("#slotTable tbody");
  tbody.innerHTML = "";
  if (!state.assigned) return;
  // Join live-slot data with herdr agent data (title, focused) by pane id.
  const agentByPane = {};
  if (state.debug && state.debug.agents) {
    for (const a of state.debug.agents) agentByPane[a.paneID || a.pane_id] = a;
  }
  for (const s of state.assigned) {
    const tr = document.createElement("tr");
    const cwd = s.agent ? s.agent.cwd || "" : "";
    const pane = s.agent ? s.agent.paneID : "";
    const herdr = agentByPane[pane] || {};
    const title = s.agent ? (herdr.title || "") : "";
    const focused = s.agent ? (herdr.focused ? "yes" : "") : "";
    tr.innerHTML =
      `<td>${s.keyID}</td><td title="${esc(slotName(s.slot, s.name))}">${esc(slotName(s.slot, s.name))}</td>` +
      (s.agent
        ? `<td title="${s.agent.agent}">${s.agent.agent}</td><td class="status cell-${s.agent.status}">${s.agent.status}</td><td class="cwd-cell" title="${cwd}">${cwd}</td><td class="cwd-cell" title="${title}">${title}</td>`
        : `<td colspan="3" style="color:#666">n/a</td><td></td>`) +
      `<td><button class="cd-btn" data-pane="${pane}" data-cwd="${cwd}" title="cd into workspace"${s.agent ? "" : " disabled"}>cd</button></td>` +
      `<td>${focused}</td>`;
    tbody.appendChild(tr);
  }
  // wire cd buttons
  tbody.querySelectorAll(".cd-btn").forEach((btn) => {
    btn.onclick = async () => {
      const pane = btn.dataset.pane;
      const cwd = btn.dataset.cwd;
      if (!pane) return;
      const dir = prompt("cd this agent into which folder?", cwd || "");
      if (!dir) return;
      const r = await fetch("/api/cd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pane, cwd: dir }) });
      const j = await r.json();
      btn.textContent = j.ok ? "ok" : "err";
      setTimeout(() => { btn.textContent = "cd"; }, 1500);
    };
  });
}

function renderActions() {
  const box = document.getElementById("actionButtons");
  box.innerHTML = "";
  if (!state.config || !state.config.actions) return;
  // Row 1: bolt/check/x/fork, centered.
  const row1 = document.createElement("div");
  row1.className = "actions-row";
  for (const [key, action] of Object.entries(state.config.actions)) {
    if (key === "talk" || key === "terminal") continue; // talk + cmd on row 2
    const btn = document.createElement("button");
    btn.textContent = `${key}: ${action.label || key}`;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        });
        const j = await r.json();
        if (!j.ok) knobNote(btn, key + ": " + (j.error || "failed"));
      } catch (e) {
        knobNote(btn, key + ": " + e.message);
      }
      btn.disabled = false;
    };
    row1.appendChild(btn);
  }
  box.appendChild(row1);
  // Row 2: talk + cmd, centered.
  const row2 = document.createElement("div");
  row2.className = "actions-row";
  const talkBtn = document.createElement("button");
  talkBtn.id = "talkBtn";
  talkBtn.className = "talk-btn" + (talkListening ? " listening" : "");
  talkBtn.textContent = talkListening ? "talk: listening..." : "talk: Talk (voice)";
  talkBtn.onclick = () => toggleTalk(talkBtn);
  row2.appendChild(talkBtn);
  const t = state.config.actions.terminal;
  if (t) {
    const btn = document.createElement("button");
    btn.textContent = `>_: ${t.label || "Terminal"}`;
    btn.onclick = async () => {
      try {
        const r = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "terminal" }),
        });
        const j = await r.json();
        if (!j.ok) knobNote(btn, "terminal: " + (j.error || "failed"));
      } catch (e) {
        knobNote(btn, "terminal: " + e.message);
      }
    };
    row2.appendChild(btn);
  }
  box.appendChild(row2);
}

// Action key settings. The defaults ship unconfigured on purpose - naming one
// team's scripts would give every other install five dead buttons - so this is
// how a key gets its job: a label, whether it runs anything, and the command.
// The command is resolved server-side through lib/launcher.js, and the editor
// shows the directory it will be looked for in so nobody has to guess.
let actionPathInfo = null;

async function renderActionEditor() {
  const box = document.getElementById("actionEditor");
  if (!box || !state.config || !state.config.actions) return;
  if (!actionPathInfo) {
    try { actionPathInfo = await getJSON("/api/actions/paths"); } catch (_) { actionPathInfo = {}; }
  }
  const where = actionPathInfo.resolved
    ? "Commands are looked for in " + actionPathInfo.resolved
    : "No command directory found yet - create one (any of: " +
      (actionPathInfo.searched || []).slice(0, 3).map((c) => c.dir).join(", ") + ")";

  let html = '<p class="ae-where">' + esc(where) + "</p>";
  for (const [key, action] of Object.entries(state.config.actions)) {
    const isTalk = key === "talk";
    html +=
      '<div class="ae-row" data-key="' + esc(key) + '">' +
      '<span class="ae-key">' + esc(key) + "</span>" +
      '<input type="text" class="ae-label" value="' + esc(action.label || "") + '" maxlength="40" placeholder="label">' +
      (isTalk
        ? '<span class="ae-run">voice input - no command</span><span></span>'
        : '<input type="text" class="ae-cmd" value="' + esc(action.cmd || "") +
          '" maxlength="260" placeholder="something.cmd">' +
          '<label class="ae-run"><input type="checkbox" class="ae-type"' +
          (action.type === "cmd" ? " checked" : "") + "> run</label>") +
      "</div>";
  }
  html +=
    '<div class="section-actions">' +
    '<button id="saveActions" class="primary">Save</button>' +
    '<span id="actionsMsg" class="save-msg"></span>' +
    "</div>";
  box.innerHTML = html;

  document.getElementById("saveActions").onclick = async () => {
    const actions = {};
    for (const row of box.querySelectorAll(".ae-row")) {
      const key = row.dataset.key;
      const label = row.querySelector(".ae-label").value;
      const cmdEl = row.querySelector(".ae-cmd");
      const typeEl = row.querySelector(".ae-type");
      actions[key] = cmdEl
        ? { label, cmd: cmdEl.value.trim(), type: typeEl && typeEl.checked ? "cmd" : "none" }
        : { label };
    }
    const msg = document.getElementById("actionsMsg");
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actions }),
      });
      const j = await r.json();
      if (j.ok) {
        state.config = j.config;
        lastConfigJson = JSON.stringify(state.config);
        msg.textContent = "saved";
        renderActions();
        renderActionEditor();
      } else {
        msg.textContent = "error: " + (j.error || "unknown");
      }
    } catch (e) {
      msg.textContent = "error: " + e.message;
    }
    setTimeout(() => { msg.textContent = ""; }, 2500);
  };
}

function wireActionSettings() {
  const btn = document.getElementById("actionSettings");
  const box = document.getElementById("actionEditor");
  if (!btn || !box) return;
  btn.onclick = () => {
    const open = box.hidden;
    box.hidden = !open;
    btn.classList.toggle("is-on", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) renderActionEditor();
  };
}
wireActionSettings();

// Voice-to-text + gold-pulse talk toggle. Uses the Web Speech API when the
// browser supports it; the recognized words are copied to the clipboard so the
// user can paste them into the focused agent. The outer light pulses gold for
// the whole session via /api/talk.
let talkListening = false;
let talkRecognition = null;
// Where a transcript goes. The clipboard is the nice case but it needs a
// focused document, so the Notes box is written first - it always works, and
// it is visible, which the clipboard is not.
function deliverTranscript(text) {
  const notes = document.getElementById("notes");
  if (notes) {
    notes.value = notes.value ? notes.value.replace(/\s*$/, "") + "\n" + text : text;
  }
  navigator.clipboard.writeText(text)
    .then(() => talkNote("heard: " + text + " (in Notes and on the clipboard)"))
    .catch(() => talkNote("heard: " + text + " (in Notes; clipboard needs this tab focused)"));
}

function talkNote(text) {
  const box = document.getElementById("knobNote");
  if (!box) return;
  box.textContent = text;
  clearTimeout(talkNote.timer);
  talkNote.timer = setTimeout(() => { box.textContent = ""; }, 6000);
}

function toggleTalk(btn) {
  if (talkListening) {
    stopTalk(btn);
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    talkNote("this browser has no Web Speech API - use Chrome or Edge");
  } else if (!document.hasFocus()) {
    // The pad was pressed while the browser was in the background. The gold
    // pulse still runs, but Chrome will not listen for an unfocused document,
    // so say that instead of appearing to work.
    talkNote("talk is on, but dictation needs this tab focused - click it, or press talk again here");
  } else {
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      deliverTranscript(e.results[0][0].transcript);
      stopTalk(btn);
    };
    rec.onerror = (e) => {
      const why = {
        "not-allowed": "microphone permission was denied for this page",
        "service-not-allowed": "the browser blocked the speech service",
        "audio-capture": "no microphone was found",
        "no-speech": "nothing was heard",
        aborted: "listening was interrupted - the tab probably lost focus",
        network: "the speech service could not be reached",
      }[e.error] || ("speech error: " + e.error);
      talkNote(why);
      stopTalk(btn);
    };
    rec.onend = () => stopTalk(btn);
    talkRecognition = rec;
    try {
      rec.start();
    } catch (err) {
      talkRecognition = null;
      talkNote("could not start listening: " + err.message);
    }
  }
  talkListening = true;
  btn.classList.add("listening");
  btn.textContent = "talk: listening... (click to stop)";
  fetch("/api/talk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: true }) });
}

function stopTalk(btn) {
  if (talkRecognition) { try { talkRecognition.stop(); } catch (_) {} talkRecognition = null; }
  talkListening = false;
  if (btn) {
    btn.classList.remove("listening");
    btn.textContent = "talk: Talk (voice)";
  }
  fetch("/api/talk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: false }) });
}

// Light test renders ONLY the 6 agent keys (no action buttons) in physical
// reading order. Each button lights its firmware key id with the slot color.
function renderLightTest() {
  const box = document.getElementById("lightTest");
  if (!box) return; // section removed; test buttons now live in the slot editor
  box.innerHTML = "";
  if (!state.config) return;
  const slots = slotByKey();
  const agentRows = [LAYOUT[0], LAYOUT[1]]; // top two rows = the 6 agent keys
  for (const row of agentRows) {
    const rowEl = document.createElement("div");
    rowEl.className = "pad-row";
    for (const k of row) {
      const btn = document.createElement("button");
      const slotCfg = slots[k];
      const label = (slotCfg && slotCfg.name) || KEY_NAMES[k] || k;
      const c = (slotCfg && slotCfg.color) || "#ff4124";
      btn.textContent = label;
      btn.style.borderColor = c;
      btn.onclick = async () => {
        // effect 4 = breathing/pulse so the key visibly flashes on click,
        // confirming the index-to-physical-key mapping.
        await fetch("/api/light", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyID: k, color: parseInt(c.slice(1), 16), effect: 4 }) });
      };
      rowEl.appendChild(btn);
    }
    box.appendChild(rowEl);
  }
}

// Slot name/color editor (visual reference only; saved to config.json).
// Each row has a text input for the name, a color picker, AND a hex text input.
function renderSlotEdit() {
  const box = document.getElementById("slotEdit");
  box.innerHTML = "";
  if (!state.config || !state.config.slots) return;
  for (const s of state.config.slots) {
    const row = document.createElement("div");
    row.className = "slot-edit-row";
    const idx = document.createElement("span");
    idx.className = "slot-idx";
    idx.textContent = s.slot;
    const name = document.createElement("input");
    name.type = "text";
    name.value = s.name || "";
    name.maxLength = 14; // keep labels on one line in the pad/light test
    name.dataset.slot = s.slot;
    name.dataset.field = "name";
    const color = document.createElement("input");
    color.type = "color";
    color.value = s.color || "#ff4124";
    color.dataset.slot = s.slot;
    color.dataset.field = "color";
    const hex = document.createElement("input");
    hex.type = "text";
    hex.className = "hex-input";
    hex.value = (s.color || "#ff4124").toUpperCase();
    hex.dataset.slot = s.slot;
    hex.dataset.field = "hex";
    hex.placeholder = "#RRGGBB";
    // keep picker and hex in sync
    color.oninput = () => { hex.value = color.value.toUpperCase(); };
    hex.oninput = () => {
      const v = hex.value.trim();
      if (/^#?[0-9a-fA-F]{6}$/.test(v)) { color.value = (v.startsWith("#") ? v : "#" + v).toLowerCase(); }
    };
    row.appendChild(idx);
    row.appendChild(name);
    row.appendChild(color);
    row.appendChild(hex);
    // Test button: flash this slot's key to verify the mapping.
    const test = document.createElement("button");
    test.type = "button";
    test.className = "test-btn";
    test.textContent = "test";
    test.title = "Flash this key";
    test.onclick = async () => {
      const keyID = assignedKeyID(s.slot);
      const c = (s.color || "#ff4124");
      await fetch("/api/light", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyID, color: parseInt(c.slice(1), 16), effect: 4 }) });
    };
    row.appendChild(test);
    box.appendChild(row);
  }
  const saveBtn = document.getElementById("saveSlots");
  saveBtn.onclick = async () => {
    const slots = [];
    for (const s of state.config.slots) {
      const name = box.querySelector(`input[data-slot="${s.slot}"][data-field="name"]`).value;
      const color = box.querySelector(`input[data-slot="${s.slot}"][data-field="color"]`).value;
      slots.push({ slot: s.slot, name, color });
    }
    const r = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slots }) });
    const j = await r.json();
    const msg = document.getElementById("saveMsg");
    if (j.ok) {
      msg.textContent = "saved";
      state.config = j.config;
      lastConfigJson = JSON.stringify(state.config);
      renderPad(); renderSlots(); renderLightTest(); renderActions();
      poll(); // re-pull /api/state so the bridge snapshot agrees too
    } else {
      msg.textContent = "error: " + (j.error || "unknown");
    }
    setTimeout(() => { msg.textContent = ""; }, 2500);
  };
}

// Underglow (outer light) editor: mode (auto/solid), color, effect (solid/gradient).
function renderUnderglow() {
  const box = document.getElementById("underglowEdit");
  box.innerHTML = "";
  if (!state.config || !state.config.underglow) return;
  const ug = state.config.underglow;
  const row = document.createElement("div");
  row.className = "slot-edit-row";
  // One control instead of two. "auto" follows the worst agent state and keeps
  // that state's own effect, so a blocked agent breathes the outer light the
  // same way it breathes its key. "solid" and "gradient" are fixed colour, and
  // differ only in the firmware effect they ask for (1 vs 5).
  const currentMode = ug.mode === "auto" ? "auto" : (Number(ug.effect) === 5 ? "gradient" : "solid");
  const mode = document.createElement("select");
  mode.dataset.field = "mode";
  mode.innerHTML =
    `<option value="auto"${currentMode === "auto" ? " selected" : ""}>auto (follow agent state)</option>` +
    `<option value="solid"${currentMode === "solid" ? " selected" : ""}>solid (fixed color)</option>` +
    `<option value="gradient"${currentMode === "gradient" ? " selected" : ""}>gradient (fixed color)</option>`;
  const color = document.createElement("input");
  color.type = "color";
  color.value = ug.color || "#ff4124";
  color.dataset.field = "color";
  const hex = document.createElement("input");
  hex.type = "text";
  hex.className = "hex-input";
  hex.value = (ug.color || "#ff4124").toUpperCase();
  hex.dataset.field = "hex";
  color.oninput = () => { hex.value = color.value.toUpperCase(); };
  hex.oninput = () => {
    const v = hex.value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(v)) { color.value = (v.startsWith("#") ? v : "#" + v).toLowerCase(); }
  };
  row.appendChild(mode);
  row.appendChild(color);
  row.appendChild(hex);
  box.appendChild(row);
  // The colour only means anything when the mode is not auto.
  const syncColorState = () => {
    const auto = mode.value === "auto";
    color.disabled = auto;
    hex.disabled = auto;
    row.classList.toggle("is-auto", auto);
  };
  mode.onchange = syncColorState;
  syncColorState();
  renderUnderglowAnimation();

  const saveBtn = document.getElementById("saveUnderglow");
  saveBtn.onclick = async () => {
    // auto keeps the per-state effect; solid and gradient pin effect 1 or 5.
    const picked = box.querySelector('[data-field="mode"]').value;
    const animEl = document.querySelector('input[name="ugAnim"]:checked');
    const underglow = {
      mode: picked === "auto" ? "auto" : "solid",
      color: box.querySelector('[data-field="color"]').value,
      effect: picked === "gradient" ? 5 : 1,
      // "state" or a firmware effect id; the server validates the range.
      animation: animEl ? (animEl.value === "state" ? "state" : Number(animEl.value)) : "state",
    };
    const r = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ underglow }) });
    const j = await r.json();
    const msg = document.getElementById("ugMsg");
    if (j.ok) {
      msg.textContent = "saved";
      state.config = j.config;
    } else {
      msg.textContent = "error: " + (j.error || "unknown");
    }
    setTimeout(() => { msg.textContent = ""; }, 2500);
  };
}

// Outer light animation. The list comes from the server (lib/pad.js
// underglowEffects), which mirrors the firmware's own effect table:
// 0 off, 1 solid, 2 snake, 3 rainbow, 4 breathing, 5 gradient, 6 shallow breath.
// "Follow state" leaves the effect to the mode above - auto then uses each
// status's own effect, so a blocked agent still breathes the ring.
let ugEffects = null;
async function renderUnderglowAnimation() {
  const box = document.getElementById("underglowAnim");
  const section = document.getElementById("animSection");
  if (!box) return;
  if (!ugEffects) {
    try {
      const j = await getJSON("/api/underglow/effects");
      ugEffects = j.effects || [];
    } catch (_) {
      // Server predates the endpoint: leave the section hidden entirely.
      if (section) section.hidden = true;
      return;
    }
  }
  if (!ugEffects.length) {
    if (section) section.hidden = true;
    return;
  }
  if (section) section.hidden = false;
  const current = state.config && state.config.underglow
    ? (state.config.underglow.animation ?? "state")
    : "state";
  box.innerHTML = "";
  for (const e of ugEffects) {
    const id = String(e.id);
    const label = document.createElement("label");
    label.className = "anim-opt";
    label.title = e.hint || "";
    label.innerHTML =
      '<input type="radio" name="ugAnim" value="' + esc(id) + '"' +
      (String(current) === id ? " checked" : "") + ">" +
      '<span class="anim-label">' + esc(e.label) + "</span>" +
      '<span class="anim-hint">' + esc(e.hint || "") + "</span>";
    box.appendChild(label);
  }
}

// Debug panel: herdr agent status/cwd for all + AIEDS aggregate for claude.
async function renderDebug() {
  const agentsEl = document.getElementById("debugAgents");
  const aiedsEl = document.getElementById("debugAieds");
  try {
    const d = await getJSON("/api/debug");
    state.debug = d;
    // agents table (only if the element exists - it was removed from the HTML
    // when Live Slots absorbed the herdr agents table)
    if (agentsEl) {
      let html = "<table class='slot-table'><thead><tr><th>Agent</th><th>Status</th><th>Focused</th><th>Cwd</th><th>Title</th></tr></thead><tbody>";
      for (const a of d.agents || []) {
        html += `<tr><td>${a.agent}</td><td class="status cell-${a.status}">${a.status}</td><td>${a.focused ? "yes" : ""}</td><td class="cwd-cell">${a.cwd || ""}</td><td class="cwd-cell">${a.title || ""}</td></tr>`;
      }
      html += "</tbody></table>";
      agentsEl.innerHTML = html;
    }
    // aieds aggregate
    if (d.aieds && d.aieds.rows > 0) {
      const a = d.aieds;
      let h = "<table class='slot-table'><thead><tr><th>Model</th><th>Sessions</th><th>Tokens</th><th>Energy Wh</th><th>gCO2e</th></tr></thead><tbody>";
      for (const m of a.byModel || []) {
        h += `<tr><td title="${esc(m.model || "unattributed")}">${esc(m.model || "unattributed")}</td><td>${fmtDec(m.sessions, 0)}</td><td>${fmt(m.tokensTotal)}</td><td>${fmtDec(m.energyWh, 1)}</td><td>${fmtDec(m.carbonG, 1)}</td></tr>`;
      }
      h += "</tbody></table>";
      aiedsEl.innerHTML = h;
      renderAiedsTotals(a);
    } else {
      // No stats recorded yet: show the engineer placeholder centered, plus a
      // short description drawn from the AIEDS reference (randomknights.xyz/aieds).
      aiedsEl.innerHTML = `
        <div class="aieds-empty">
          <img src="engineer.png" alt="AIEDS engineer placeholder" class="aieds-placeholder" />
          <p class="aieds-empty-title">No AIEDS stats recorded yet.</p>
          <p>AIEDS is the provider-neutral standard for reporting modeled energy and carbon from AI work. Methodology 2.0.0 is energy-first:</p>
          <ul>
            <li><strong>Energy</strong> = (input/1000 &times; whPer1kIn + output/1000 &times; whPer1kOut) &times; PUE.</li>
            <li><strong>Carbon</strong> = energy (kWh) &times; grid intensity (429 gCO2e/kWh).</li>
            <li><strong>Tree-time</strong> = gCO2e / 21000 &times; 525600 (one Mature Reference Tree at 21 kg CO2e/yr).</li>
          </ul>
          <p>Stats appear here as sessions complete. See the full reference at <a href="https://randomknights.xyz/aieds/reference" target="_blank" rel="noopener">randomknights.xyz/aieds/reference</a>.</p>
        </div>`;
      renderAiedsTotals(null);
    }
  } catch (e) {
    agentsEl.innerHTML = "<p class='hint'>debug unavailable: " + e.message + "</p>";
  }
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// AIEDS aggregate strip. Tree-time is the same calculation as before, in
// mature-reference-tree YEARS: minutes / 525600. In minutes it read as a
// meaningless eight-digit number.
function renderAiedsTotals(a) {
  const box = document.getElementById("aiedsStats");
  const row = document.getElementById("aiedsChartRow");
  if (!box) return;
  if (!a || !a.rows) {
    box.hidden = true;
    if (row) row.hidden = true;
    return;
  }
  const treeYears = (+a.totalTreeMin || 0) / 525600;
  // Terse labels so all six figures fit one line in the tile; the long form
  // lives in each item's tooltip.
  box.innerHTML =
    `<span title="sessions in the local AIEDS log"><b>${fmtDec(a.rows, 0)}</b> sessions</span>` +
    `<span title="total tokens"><b>${fmt(a.totalTokens)}</b> tokens</span>` +
    `<span title="modeled energy"><b>${fmtDec((+a.totalEnergyWh || 0) / 1000, 1)}</b> kWh</span>` +
    `<span title="modeled carbon in kilograms CO2e"><b>${fmtDec((+a.totalCarbonG || 0) / 1000, 1)}</b> kg</span>` +
    `<span title="mature-reference-tree years to offset that carbon"><b>${fmtDec(treeYears, 1)}</b> tree-yrs</span>` +
    (a.totalCostUsd > 0
      ? `<span title="List-price equivalent, modelled for ${fmtDec(a.pricedRows || 0, 0)} of ${fmtDec(a.rows, 0)} rows. This client is subscription billed - no such sum was charged."><b>${fmt(a.totalCostUsd)}</b> USD est.</span>`
      : "");
  box.hidden = false;
}

// 30-day trend, one point per day, drawn as an inline SVG overlay.
//
// Cost and runtime come from the SessionEnd hook as of 2026-09-01:
//   cost    - costUsdModeled, a MODELLED LIST PRICE, not billed spend (this
//             client is subscription billed). Priced from lib/aieds-rates.json;
//             a model with no entry there contributes nothing. Older rows are
//             priced on read from the same table, so the history is complete.
//   runtime - avgResponseMs, the mean gap between the row that prompted a
//             response and the response itself, idle gaps over 5 min dropped.
//             Only sessions that ended after the hook change carry it, so this
//             line starts empty and fills in from here.
// A chip whose series is entirely zero disables itself and says why.
//
// Energy, carbon and tree-time are fixed multiples of each other in AIEDS v2
// (carbon = energy * grid intensity, tree-time = carbon / tree rate), so those
// three lines coincide exactly by construction. Each line is scaled to its own
// peak, and the scale is log by default because a single heavy day is ~15x a
// normal one and flattens everything else on a linear axis.
const METRICS = [
  { key: "sessions", label: "sessions", color: "#90a4ae", get: (d) => d.sessions, fmtVal: (v) => fmt(v), on: true },
  { key: "tokens", label: "tokens", color: "#00b0ff", get: (d) => d.tokens, fmtVal: (v) => fmt(v), on: true },
  { key: "energyWh", label: "energy Wh", color: "#ff7a55", get: (d) => d.energyWh, fmtVal: (v) => fmt(v) + " Wh", on: true },
  { key: "carbonG", label: "gCO2e", color: "#e8bf03", get: (d) => d.carbonG, fmtVal: (v) => fmt(v) + " g", on: false },
  { key: "treeTimeMin", label: "tree-min", color: "#00c853", get: (d) => d.treeTimeMin, fmtVal: (v) => fmt(v) + " min", on: false },
  {
    key: "runtime",
    label: "avg runtime",
    color: "#c7b6f5",
    get: (d) => d.avgResponseMs,
    fmtVal: (v) => (v / 1000).toFixed(1) + "s",
    aggregate: "mean",
    on: false,
    emptyNote: "no session has ended since response timing was added to the hook",
  },
  {
    key: "cost",
    label: "cost",
    color: "#faafa5",
    get: (d) => d.costUsd,
    fmtVal: (v) => "$" + fmtDec(v, 2),
    on: false,
    emptyNote: "no model in this window has a price in lib/aieds-rates.json",
  },
];
let aiedsSeries = null;
let aiedsLogScale = true;

async function loadAiedsSeries() {
  try {
    const j = await getJSON("/api/aieds/series");
    aiedsSeries = Array.isArray(j.series) ? j.series : [];
    renderAiedsChips();
    drawAiedsChart();
  } catch (_) { /* chart stays hidden */ }
}

function metricHasData(m) {
  return !!(aiedsSeries || []).some((d) => (+m.get(d) || 0) > 0);
}

function renderAiedsChips() {
  const box = document.getElementById("aiedsChips");
  if (!box || box.dataset.built === "1") return;
  box.dataset.built = "1";
  for (const m of METRICS) {
    const empty = !metricHasData(m);
    if (empty) m.on = false;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "aieds-chip" + (m.on ? " on" : "");
    b.style.color = m.on ? m.color : "";
    b.innerHTML = '<i style="background:' + m.color + '"></i>' + m.label;
    if (empty) {
      b.disabled = true;
      b.title = m.emptyNote || "no data for this metric in the last 30 days";
    } else {
      b.title = "show or hide " + m.label;
      b.onclick = () => {
        m.on = !m.on;
        b.classList.toggle("on", m.on);
        b.style.color = m.on ? m.color : "";
        drawAiedsChart();
      };
    }
    box.appendChild(b);
  }
  const scale = document.createElement("button");
  scale.type = "button";
  scale.className = "aieds-chip on";
  scale.textContent = "log";
  scale.title = "switch between a log and a linear scale";
  scale.onclick = () => {
    aiedsLogScale = !aiedsLogScale;
    scale.textContent = aiedsLogScale ? "log" : "linear";
    drawAiedsChart();
  };
  box.appendChild(scale);
}

function drawAiedsChart() {
  const svg = document.getElementById("aiedsChart");
  const row = document.getElementById("aiedsChartRow");
  if (!svg || !row || !aiedsSeries || aiedsSeries.length < 2) return;
  const w = 320, h = 100, padL = 3, padR = 3, padT = 8, padB = 6;
  const n = aiedsSeries.length;
  const x = (i) => padL + (i * (w - padL - padR)) / (n - 1);
  const norm = (v, max) => {
    if (max <= 0) return 0;
    if (!aiedsLogScale) return v / max;
    return Math.log10(1 + v) / Math.log10(1 + max);
  };
  let svgHtml =
    '<line x1="0" y1="' + (h - padB) + '" x2="' + w + '" y2="' + (h - padB) +
    '" stroke="rgba(255,124,72,0.22)" stroke-width="1" vector-effect="non-scaling-stroke"/>';
  const shown = METRICS.filter((m) => m.on && !m.missing);
  for (const m of shown) {
    const vals = aiedsSeries.map((d) => +m.get(d) || 0);
    const max = Math.max.apply(null, vals.concat([0]));
    if (max <= 0) continue;
    const pts = vals
      .map((v, i) => x(i).toFixed(1) + "," + (padT + (1 - norm(v, max)) * (h - padT - padB)).toFixed(1))
      .join(" ");
    svgHtml +=
      '<polyline points="' + pts + '" fill="none" stroke="' + m.color + '" stroke-width="1.4" ' +
      'stroke-linejoin="round" stroke-linecap="round" opacity="0.92" vector-effect="non-scaling-stroke">' +
      '<title>' + esc(m.label) + ' - peak ' + esc(m.fmtVal(max)) + ' per day</title></polyline>';
  }
  svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  svg.innerHTML = svgHtml;

  // The date range is the only caption now - the old note line was folded into
  // the single read-more link at the foot of the tile. The per-series totals it
  // used to spell out live on as each line's hover title, and the scale is on
  // the log/linear chip, so nothing was lost but the paragraph.
  const range = document.getElementById("aiedsRange");
  if (range) {
    range.textContent =
      aiedsSeries[0].day + "  to  " + aiedsSeries[n - 1].day +
      (aiedsLogScale ? "  (log scale)" : "  (linear scale)");
  }
  row.hidden = false;
}

loadAiedsSeries();
setInterval(loadAiedsSeries, 60000);

function fmt(n) {
  n = +n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e4) return Math.round(n).toLocaleString("en-US");
  return Math.round(n).toLocaleString("en-US");
}
// Decimal numbers with thousands-comma separators, e.g. 12,345.6
function fmtDec(n, digits) {
  return (+n || 0).toLocaleString("en-US", { minimumFractionDigits: digits ?? 1, maximumFractionDigits: digits ?? 1 });
}

// PC resource monitor: CPU / RAM bars, process count, uptime. Polls /api/sys.
async function renderSysMonitor() {
  const cpuBar = document.getElementById("cpuBar");
  const memBar = document.getElementById("memBar");
  const cpuPct = document.getElementById("cpuPct");
  const memPct = document.getElementById("memPct");
  const memDetail = document.getElementById("memDetail");
  const procCount = document.getElementById("procCount");
  const upTime = document.getElementById("upTime");
  if (!cpuBar || !memBar) return; // monitor element not present (old page cached)
  let s;
  try {
    s = await (await fetch("/api/sys")).json();
  } catch (_) { cpuPct.textContent = "n/a"; return; }
  const fill = (bar, el, pct) => {
    bar.style.width = Math.min(100, Math.max(0, pct)) + "%";
    bar.style.background = pct > 80 ? "#ff4124" : pct > 50 ? "#e8bf03" : "#00c853";
    if (el) el.textContent = Math.round(pct) + "%";
  };
  fill(cpuBar, cpuPct, s.cpuPct);
  fill(memBar, memPct, s.memPct);
  if (memDetail) memDetail.textContent = `${s.memUsedMb.toLocaleString("en-US")} MB / ${s.memTotalMb.toLocaleString("en-US")} MB`;
  if (procCount) procCount.textContent = `${s.processes.toLocaleString("en-US")} processes on ${s.hostname}`;
  if (upTime) upTime.textContent = `up ${Math.floor(s.uptimeSec / 3600)}h ${Math.floor((s.uptimeSec % 3600) / 60)}m`;
  // top processes by memory (top 5, scrollable container)
  try {
    const pr = await (await fetch("/api/sys/procs")).json();
    const tbody = document.querySelector("#procTable tbody");
    if (tbody) {
      tbody.innerHTML = (pr.procs || []).map((p) =>
        `<tr><td>${p.pid}</td><td class="cwd-cell">${p.name}</td><td>${fmtDec(p.memKb / 1024, 0)} MB</td>` +
        `<td><button class="kill-btn" data-pid="${p.pid}" data-name="${p.name}" title="End task">end</button></td></tr>`
      ).join("");
      tbody.querySelectorAll(".kill-btn").forEach((btn) => {
        btn.onclick = async () => {
          const pid = btn.dataset.pid;
          const name = btn.dataset.name;
          if (!confirm(`End task ${name} (PID ${pid})?`)) return;
          const r = await fetch("/api/sys/kill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: Number(pid) }) });
          const j = await r.json();
          btn.textContent = j.ok ? "killed" : "err";
          setTimeout(() => { btn.textContent = "end"; }, 1500);
        };
      });
    }
  } catch (_) { /* ignore */ }
}
renderSysMonitor();
setInterval(renderSysMonitor, 3000);

// Notes section: copy the textarea to the clipboard, or clear it.
function wireNotes() {
  const copyBtn = document.getElementById("copyNotes");
  const clearBtn = document.getElementById("clearNotes");
  const msg = document.getElementById("notesMsg");
  if (copyBtn) copyBtn.onclick = async () => {
    const ta = document.getElementById("notes");
    const text = ta.value;
    if (!text.trim()) { msg.textContent = "nothing to copy"; setTimeout(() => { msg.textContent = ""; }, 1500); return; }
    try {
      await navigator.clipboard.writeText(text);
      msg.textContent = "copied";
    } catch (_) {
      ta.select();
      document.execCommand("copy");
      msg.textContent = "copied";
    }
    setTimeout(() => { msg.textContent = ""; }, 1500);
  };
  if (clearBtn) clearBtn.onclick = () => {
    const ta = document.getElementById("notes");
    ta.value = "";
    msg.textContent = "cleared";
    setTimeout(() => { msg.textContent = ""; }, 1500);
  };
  // Copy every provider install command (they live one per provider row now).
  const copyInstall = document.getElementById("copyInstall");
  if (copyInstall) copyInstall.onclick = async () => {
    const text = [...document.querySelectorAll("#slotsPanel .install-list .p-cmd")]
      .map((el) => el.dataset.cmd).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      copyInstall.textContent = "copied";
    } catch (_) {
      copyInstall.textContent = "err";
    }
    setTimeout(() => { copyInstall.textContent = "copy installs"; }, 1500);
  };
  // Click any single command to copy just that one.
  document.querySelectorAll(".install-list .p-cmd").forEach((el) => {
    el.onclick = async () => {
      try {
        await navigator.clipboard.writeText(el.dataset.cmd);
        el.classList.add("copied");
      } catch (_) { /* clipboard blocked */ }
      setTimeout(() => { el.classList.remove("copied"); }, 1200);
    };
  });
}
wireNotes();

async function poll() {
  try {
    const data = await getJSON("/api/state");
    state.deviceUp = data.deviceUp;
    state.assigned = data.assigned;
    state.config = data.config;
    state.hostname = data.hostname;
    state.pairing = !!data.pairing;
    if (window.setPairButtonState) window.setPairButtonState(state.pairing);
    renderBands();
    const line = document.getElementById("statusLine");
    line.className = "device-status " + (data.deviceUp ? "up" : "down");
    line.textContent = data.deviceUp ? "device connected" : `device OFFLINE${data.deviceError ? " - " + data.deviceError : ""}`;
    const hostEl = document.getElementById("hostname");
    if (hostEl) hostEl.textContent = data.hostname ? `host: ${data.hostname}` : "";
    renderPad(); renderSlots(); renderActions(); renderLightTest();
    // Only rebuild the editors when the config actually changed. Rebuilding
    // them on every poll destroys an open <select> mid-interaction, which is
    // why the outer-light dropdown could never be used.
    const cfgJson = JSON.stringify(state.config);
    if (cfgJson !== lastConfigJson) {
      lastConfigJson = cfgJson;
      renderSlotEdit(); renderUnderglow();
    }
  } catch (e) {
    document.getElementById("statusLine").textContent = "server unreachable: " + e.message;
  }
}

poll();
setInterval(poll, 2500);
setInterval(renderDebug, 5000);
renderDebug();

// Subscribe to device key events over SSE so the app reacts to physical key
// presses (talk toggle, action runs) without polling. When the device talk key
// is pressed, the talk button state and the gold pulse follow.
function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === "agkey" && msg.pressed) {
      flashKnob(msg.index);
      return;
    }
    if (msg.type === "actkey" && (msg.index === 10 || msg.index === 11) && msg.pressed) {
      // Device talk key toggled: flip the app talk state to match.
      const btn = document.getElementById("talkBtn");
      if (talkListening) stopTalk(btn); else toggleTalk(btn);
    }
  };
  es.onerror = () => { es.close(); setTimeout(connectEvents, 3000); };
}
connectEvents();
