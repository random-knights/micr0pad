"use strict";
// bridge.js - the core engine: polls Herdr, maps agents to the 6 pad slots,
// paints per-key RGB + underglow. Also exposes live key-press events and the
// current mapping so the web UI can mirror it.
const { open } = require("./wldevice");
const pad = require("./pad");
const mapper = require("./mapper");
const herdr = require("./herdr");

// Dial (encoder) and joystick (toggle) map to AG ids 13..18 when bound.
// Dial: 13 = CW, 14 = CCW. Joystick: 15 = north, 16 = west, 17 = south, 18 = east.
const DIAL_CW = 13, DIAL_CCW = 14;
const JOY_N = 15, JOY_W = 16, JOY_S = 17, JOY_E = 18;

// Model cycle list per agent kind (sent as /model <name> to the focused agent).
const MODEL_CYCLE = {
  claude: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-5"],
  codex: ["gpt-5.5", "gpt-5.2", "gpt-5.1"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  grok: ["grok-4", "grok-4-fast"],
  default: ["default"],
};

class MicropadBridge {
  constructor(cfg) {
    this.cfg = cfg;
    this.dev = null;
    this.timer = null;
    this.listeners = [];
    this.lastAgents = [];
    this.lastAssigned = [];
    this.deviceError = null;
    this.running = false;
    this.modelIndex = {}; // agent kind -> current index in MODEL_CYCLE
    this.lastJoy = null;  // last joystick radial position {a, d}
    this.talkActive = false; // while true, the underglow shows a gold pulse
    // Pairing mode: stop driving the LEDs entirely so the firmware's own
    // lighting - including the blue underglow it shows in BLE mode - is
    // visible. Our 2.5s repaint would otherwise overwrite it within a blink.
    this.pairing = false;
  }

  connect() {
    try {
      this.dev = open();
      this.dev.onNotify = (method, params) => {
        if (method === "v.oai.hid" || method === "hid") {
          this.handleHid(params || {});
        } else if (method === "v.oai.rad" || method === "rad") {
          this.handleRad(params || {});
        }
      };
      this.deviceError = null;
      return true;
    } catch (e) {
      this.deviceError = e.message;
      this.dev = null;
      return false;
    }
  }

  on(evt, fn) { this.listeners.push([evt, fn]); }
  emit(evt, data) { for (const [e, fn] of this.listeners) if (e === evt) fn(data); }
  deviceUp() { return !!this.dev; }

  // Decode a v.oai.hid notification: { k: "AG13", act: 1 } or { k: "ACT6", act: 1 }.
  handleHid(params) {
    const pressed = params.act === 1;
    const ag = /^AG(\d+)$/.exec(params.k || "");
    const act = /^ACT(\d+)$/.exec(params.k || "");
    if (ag) {
      const index = Number(ag[1]);
      this.emit("keyevent", { index, pressed, raw: params });
      if (!pressed) return; // act on press only
      if (index === DIAL_CW) this.cycleModel(1);
      else if (index === DIAL_CCW) this.cycleModel(-1);
      else if (index >= JOY_N && index <= JOY_E) this.joyDirection(index);
      else if (index <= 5) this.focusAgentForSlot(index); // status keys 0-5
      return;
    }
    if (act) {
      const index = Number(act[1]);
      this.emit("actkeyevent", { index, pressed, raw: params });
      if (!pressed) return; // act on press only
      this.handleActionKey(index);
    }
  }

  // A physical action key was pressed. Map the firmware ACT index to the
  // configured action and run it, so the device works without the web app.
  // ACT 10/11 is the wide talk key: it toggles the talk gold pulse.
  handleActionKey(index) {
    // actionKeyIDs maps logical names -> firmware id. Invert it.
    const byId = {};
    for (const [name, id] of Object.entries(pad.actionKeyIDs)) {
      if (Array.isArray(id)) for (const i of id) byId[i] = name;
      else byId[id] = name;
    }
    const name = byId[index];
    if (!name) { this.emit("notice", { text: `unmapped action key ${index}` }); return; }
    if (name === "talk") {
      const next = !this.talkActive;
      this.setTalk(next);
      this.emit("notice", { text: `talk ${next ? "on" : "off"}` });
      return;
    }
    const action = this.cfg.actions && this.cfg.actions[name];
    if (!action || action.type !== "cmd" || !action.cmd) {
      this.emit("notice", { text: `action ${name} has no cmd` });
      return;
    }
    this.emit("notice", { text: `running ${name}: ${action.cmd}` });
    // Resolve the launcher under _macropad and spawn it detached.
    const path = require("path");
    const { execFile } = require("child_process");
    const base = path.join(__dirname, "..", "..", "..", "_macropad");
    const cmdPath = path.join(base, action.cmd);
    if (!require("fs").existsSync(cmdPath)) { this.emit("notice", { text: `cmd not found: ${action.cmd}` }); return; }
    const child = execFile("cmd.exe", ["/c", "start", "", cmdPath], { windowsHide: true, detached: true }, () => {});
    child.unref();
  }

  // Decode a v.oai.rad notification: { a: angle 0..1, d: distance 0..1 }.
  // A press-in is a large distance spike; a release is a return to ~0.
  handleRad(params) {
    const a = Number(params.a) || 0;
    const d = Number(params.d) || 0;
    const prev = this.lastJoy;
    this.lastJoy = { a, d };
    this.emit("joystick", { a, d });
    // Press-in: distance crosses a high threshold. Release: returns low.
    const PRESS = 0.7, RELEASE = 0.3;
    if (prev && prev.d < PRESS && d >= PRESS) {
      this.emit("joypress", { a, d });
    }
  }

  // Dial: cycle the focused agent's model. Sends /model <name> to the focused pane.
  async cycleModel(dir) {
    try {
      const focused = await herdr.focusedAgent();
      if (!focused) { this.emit("notice", { text: "no focused agent to retune" }); return; }
      const kind = focused.agent || "default";
      const list = MODEL_CYCLE[kind] || MODEL_CYCLE.default;
      const idx = (this.modelIndex[kind] || 0) + dir;
      const next = ((idx % list.length) + list.length) % list.length;
      this.modelIndex[kind] = next;
      const model = list[next];
      await herdr.prompt(focused.pane_id, `/model ${model}`);
      this.emit("notice", { text: `${kind}: model -> ${model}` });
    } catch (e) {
      this.emit("notice", { text: "model cycle failed: " + e.message });
    }
  }

  // Joystick/toggle: navigate the Herdr UI. North/South move between tabs,
  // East/West move between panes, press-in = click (focus/select).
  async joyDirection(index) {
    try {
      const focused = await herdr.focusedAgent();
      if (!focused) { this.emit("notice", { text: "no focused agent to navigate" }); return; }
      const pane = focused.pane_id;
      if (index === JOY_N) await herdr.navigate(pane, "tab-prev");
      else if (index === JOY_S) await herdr.navigate(pane, "tab-next");
      else if (index === JOY_W) await herdr.navigate(pane, "pane-prev");
      else if (index === JOY_E) await herdr.navigate(pane, "pane-next");
    } catch (e) {
      this.emit("notice", { text: "navigate failed: " + e.message });
    }
  }

  // Judge/Janitor: send a command to the currently focused Herdr tab's agent.
  async sendToFocused(command) {
    try {
      const focused = await herdr.focusedAgent();
      if (!focused) { return { ok: false, error: "no focused agent" }; }
      await herdr.prompt(focused.pane_id, command);
      return { ok: true, target: focused.agent, pane: focused.pane_id };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // A status key (AG 0-5) was pressed: focus the assigned agent's Herdr tab so
  // the user lands on it. The slot->agent mapping is the same one that drives
  // the lights, so the key that is lit for an agent focuses that agent.
  async focusAgentForSlot(slot) {
    const assigned = this.lastAssigned.find((x) => x.slotCfg.slot === slot);
    if (!assigned || !assigned.agent) {
      this.emit("notice", { text: `slot ${slot} has no agent to focus` });
      return;
    }
    try {
      await herdr.focus(assigned.agent.paneID);
      this.emit("notice", { text: `focused ${assigned.slotCfg.name}` });
    } catch (e) {
      this.emit("notice", { text: `focus failed: ${e.message}` });
    }
  }

  async start() {
    this.connect();
    await this.refresh();
    this.timer = setInterval(() => this.refresh(), this.cfg.pollIntervalMs);
    this.running = true;
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.dev) { try { this.lightsOff(); } catch {} try { this.dev.close(); } catch {} this.dev = null; }
  }

  // Fetch agents, assign slots, paint.
  async refresh() {
    // Hot-plug support: while there is no device, try to open one on every
    // poll. Opening is a cheap HID enumeration when nothing is attached.
    if (!this.dev && !this.pairing) {
      const wasError = this.deviceError;
      if (this.connect()) {
        this.emit("notice", { text: "device connected" });
      } else if (this.deviceError !== wasError) {
        // Only log a NEW error, so a missing pad does not spam the notice line.
      }
    }
    let agents = [];
    try { agents = await herdr.listAgents(); } catch (e) { agents = []; }
    this.lastAgents = agents;
    const assigned = mapper.assign(agents, this.cfg.slots);
    this.lastAssigned = assigned;
    if (this.dev) {
      try {
        await this.paintSlots(assigned);
        await this.paintUnderglow(assigned);
      } catch (e) {
        // A write to a pad that has been unplugged throws or times out. Drop
        // the handle so the next poll re-opens it instead of painting into a
        // dead device forever.
        try { this.dev.close(); } catch (_) {}
        this.dev = null;
        this.deviceError = e.message;
        this.emit("notice", { text: "device lost: " + e.message });
      }
    }
    this.emit("state", {
      agents,
      assigned: assigned.map((x) => ({
        slot: x.slotCfg.slot,
        name: x.slotCfg.name,
        keyID: pad.agentKeyIDs[x.slotCfg.slot],
        agent: x.agent ? { agent: x.agent.agent, status: herdr.statusOf(x.agent), focused: x.agent.focused, cwd: x.agent.cwd, paneID: x.agent.paneID } : null,
      })),
      deviceUp: !!this.dev,
      deviceError: this.deviceError,
    });
  }

  async paintSlots(assigned) {
    if (this.pairing) return;
    const threads = assigned.map((x) => mapper.threadFor(x.agent, x.slotCfg));
    await this.dev.call("v.oai.thstatus", threads);
  }

  async paintUnderglow(assigned) {
    if (this.pairing) return;
    // While talk is active, the outer light shows a gold pulse so the user can
    // see from across the room that voice input is live. This overrides the
    // auto/solid underglow for the duration of the talk session.
    if (this.talkActive) {
      const gold = { e: 4, b: 1, s: 0.5, m: 1, c: 0xe8bf03 }; // effect 4 = breathing/pulse
      const dark = { e: 0, b: 0, s: 0.5, m: 1, c: 0 };
      await this.dev.call("v.oai.rgbcfg", { keys: dark, ambient: gold });
      return;
    }
    const zone = mapper.zoneFor(assigned, this.cfg.underglow);
    const dark = { e: 0, b: 0, s: 0.5, m: 1, c: 0 };
    // Don't touch the keys zone (per-key threads own it); only drive ambient.
    const resp = await this.dev.call("v.oai.rgbcfg", { keys: dark, ambient: zone || dark });
  }

  // Pairing mode. On: clear our per-key threads and stop the refresh loop, so
  // the device shows its own zone lighting and can flash its BLE indicator.
  // The ambient zone is deliberately NOT written here - writing it is what
  // would stomp the blue. Off: resume the loop and repaint immediately.
  async setPairing(active) {
    this.pairing = !!active;
    if (this.pairing) {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this.dev) {
        // Clear our per-key threads first - threads paint over zones, so while
        // they are set the firmware's own lighting cannot show at all.
        const dark = Array.from({ length: pad.maxThreadID + 1 }, (_, id) => ({ id, b: 0, e: 0 }));
        try { await this.dev.call("v.oai.thstatus", dark); } catch (_) { /* device may be gone */ }
        // Then CLOSE the vendor interface. Holding it open is the difference
        // between "we stopped writing" and "the device is ours alone"; the
        // touch sensor and BLE indicator want the device to itself.
        try { this.dev.close(); } catch (_) {}
        this.dev = null;
      }
      this.emit("notice", { text: "pairing mode: device released - hold the touch sensor 3s for BLE" });
    } else {
      // refresh() re-opens the device on its next tick (hot-plug path).
      if (!this.timer) this.timer = setInterval(() => this.refresh(), this.cfg.pollIntervalMs);
      try { await this.refresh(); } catch (_) {}
      this.emit("notice", { text: "pairing mode off: lights back under app control" });
    }
    return this.pairing;
  }

  // Toggle the talk-active underglow override. Returns the new state.
  setTalk(active) {
    this.talkActive = !!active;
    // Repaint immediately so the gold pulse starts/stops without waiting for
    // the next poll.
    if (this.dev) {
      this.refresh().catch(() => {});
    }
    return this.talkActive;
  }

  async setKey(keyID, color, effect = 1) {
    if (!this.dev) return;
    await this.dev.call("v.oai.thstatus", [{ id: keyID, c: color, b: 1, e: effect, s: 0.5 }]);
  }

  async lightsOff() {
    if (!this.dev) return;
    const dark = Array.from({ length: pad.maxThreadID + 1 }, (_, id) => ({ id, b: 0, e: 0, sk: 0, sa: 0 }));
    await this.dev.call("v.oai.thstatus", dark);
    const z = { e: 0, b: 0, s: 0.5, m: 1, c: 0 };
    await this.dev.call("v.oai.rgbcfg", { keys: z, ambient: z });
  }
}

module.exports = { MicropadBridge };
