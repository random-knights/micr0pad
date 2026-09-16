# Development notes

Why the code is shaped the way it is. Everything here was verified against a
real Codex Micro (firmware v0.4.1) rather than taken from documentation.

## Layout

```
server.js            HTTP + JSON API + SSE, serves public/
lib/device.js        the device interface, and the method-not-found contract
lib/wldevice.js      raw-HID JSON-RPC transport (vendor interface FF00/01)
lib/virtualdevice.js the same interface in memory, for when no pad is attached
lib/bridge.js        poll loop: read agents -> assign slots -> paint the pad
lib/mapper.js        agent -> slot assignment, and the colour/effect for each
lib/pad.js           device geometry, status colours, underglow + effect table
lib/herdr.js         thin wrapper over the herdr CLI
lib/aieds.js         reads the local AiEDs log into totals and a 30-day series
lib/aieds-cost.js    the one cost function (list price, never a bill)
lib/aieds-rates.json owner-editable per-token prices
hooks/aieds-local.js Claude Code SessionEnd hook that writes the AiEDs log
public/              the UI: index.html, app.js, app.css, marks
```

Scripts: `probe.js` (read-only device inspection), `backup-keymap.js`,
`restore-keymap.js`, `add-layers.js`, `bind-dial-joy.js`, `lights-off.js`.

## The device

One USB interface exposing five HID collections: keyboard `01/06`, consumer
`0C/01`, mouse `01/02`, gamepad `01/05` (the joystick), and vendor `FF00/01` -
the JSON-RPC channel this app speaks. The device filesystem (`fs.list`) holds
exactly one file, `keymap.json`.

### The method set, and the virtual pad

Everything this app asks the device for, with where each name is used. There is
no discovery method on this firmware, so this list is the whole known surface:

| method | what it does | virtual pad |
|---|---|---|
| `v.oai.thstatus` | per-key thread colours | yes, held in memory |
| `v.oai.rgbcfg` | the keys and ambient zones | yes, held in memory |
| `sys.version` | firmware version | yes, answers `virtual` |
| `fs.read` / `fs.write` | the device flash, one file: `keymap.json` | no, refused |
| `fs.list` | the device filesystem listing | no, refused |
| `device.status` | tried by `probe.js`; no recorded response | no, refused |
| `lights.preview` | full field names and STRING effects; unused | no, refused |

Device to host, as notifications: `v.oai.hid` `{k, act}` for a key (the `k` is
`AG00` to `AG05` for the status keys, `ACT06` to `ACT12` for the action keys,
and `AG13` to `AG18` for the dial and the joystick sectors), and `v.oai.rad`
`{a, d}` for the joystick radial. `lib/bridge.js` accepts the short `hid` and
`rad` spellings too.

`lib/virtualdevice.js` implements that surface with no hardware. What it will
not do is answer a method it does not have: an unknown method REJECTS with
"Method not found" and code -32601, exactly as the firmware does, because a
stand-in that resolved `{ok:1}` would report success for a call the hardware
refuses. The two `fs.*` methods are refused on purpose rather than faked: the
keymap is the only route back to stock, and an invented one written over
`keymap-backup.json` would destroy it. `server.js` therefore keeps both keymap
buttons on the physical pad.

One deliberate difference: the firmware accepts any payload and returns
`{"ok":1}`. The virtual pad refuses a malformed frame with an invalid-params
error, because a test seam that swallows a bad frame teaches you nothing.

The bridge always prefers hardware. It tries HID on start and on every poll
while it has no pad; a virtual pad is what it runs in the meantime, and it
hands over the moment a real pad opens, replaying the colour matrix it was
holding so the keys light immediately rather than at the next poll. The reverse
(falling back to a virtual pad when a connected pad is unplugged) is off unless
`virtualPad.onUnplug` says otherwise.

### Effects

`v.oai.rgbcfg` and `v.oai.thstatus` take abbreviated fields - `c` colour (packed
int), `b` brightness, `e` effect (a NUMBER), `s` speed, `sk`/`sa` mirror flags.
The firmware's effect set is:

| value | effect | value | effect |
|---|---|---|---|
| 0 | off | 4 | breathing |
| 1 | solid | 5 | gradient |
| 2 | snake | 6 | shallow breath |
| 3 | rainbow | | |

There is no "spin" or "wave" primitive; snake is the travelling one, rainbow the
colour-cycling one. `lights.preview` uses full field names and STRING effects -
mixing the two conventions is a silent no-op.

### Traps that cost real time

- **`{"ok":1}` means nothing.** The firmware accepts any payload and reports
  success. Every write in this codebase that matters is followed by a read-back
  comparison (`restore-keymap`, `add-layers`, `/api/keymap/restore`).
- **Thread colour paints over zone colour.** Per-key threads hide the zones
  underneath, which is why pairing mode clears threads before releasing the
  device, and why turning everything off takes two calls.
- **Only AG-bound keys on the ACTIVE layer can be lit.** A key that is not bound
  still returns ok for its thread and stays dark.
- **Open the HID device non-exclusively**, or macOS refuses with an error that
  looks exactly like a permission problem.
- **Call ids must be under 1000.**

### Layers, the touch sensor, and Bluetooth

Tapping the touch sensor cycles layers; holding it 3s enters BLE mode where taps
cycle channels 1/2/3. Two findings:

1. A fresh unit here defined exactly ONE layer while the firmware reported
   `layer_index: 1` - so tapping had nowhere to go. `add-layers.js` copies the
   active layer so the sensor has real destinations. Copies are byte-identical
   layouts, so the pad behaves the same whichever layer is active and the AG
   bindings (and therefore the lighting) survive a layer change.
2. **The firmware exposes no BLE control over the vendor RPC.** `ble.status`,
   `ble.list`, `ble.channel`, `device.info`, `sys.info`, `device.config` and
   every discovery name tried (`rpc.discover`, `sys.methods`, `help`) answer
   "Method not found". Pairing state lives in firmware NVS. The app therefore
   cannot switch channels; the Band Connections section releases the device and
   shows the key sequence instead, which is the only honest option.

Pairing mode does not merely pause painting - it **closes** the vendor
interface. Verified by opening the device from a second process while pairing is
on. Holding the interface open is the difference between "we stopped writing"
and "the device is free".

### Hot-plug

The bridge used to open the device once at startup, so unplugging the pad left
the app offline until a restart - exactly what happens when the pad moves
between machines. `refresh()` now retries `connect()` on every poll while
disconnected, and a failed paint closes the handle so the next poll re-opens it.

## AiEDs

The hook reads the session's own transcript and sums the token counts the API
reported. Three decisions worth keeping:

- **What counts as an input token.** Claude Code caches aggressively: in a
  cached turn `input_tokens` is often 2 while tens of thousands arrive as
  `cache_creation_input_tokens` and `cache_read_input_tokens`. Those tokens are
  still prefilled and still cost energy, so `tokensIn` is the sum of all three.
  Counting only `input_tokens` would understate a session roughly a
  thousand-fold. The raw split is kept in `tokensInBreakdown`.
- **One response is several transcript lines** (one per content block), each
  repeating an identical usage object. Rows are deduplicated by `message.id`;
  summing every line multiplies the real number.
- **Subagent turns are not in the main transcript.** They live in
  `<transcript-dir>/<session-id>/subagents/agent-*.jsonl` and can run a
  different model. They burn real energy, so they are counted.

**Cost is a modelled list price, never a bill.** This client is subscription
billed. `lib/aieds-cost.js` prices plain input, cache writes (~1.25x) and cache
reads (~0.1x) separately - pricing the combined `tokensIn` at the plain rate
would overstate a cache-heavy client by roughly 8x. A model with no entry in
`lib/aieds-rates.json` gets no cost at all.

**Timing** is derived from row timestamps, since the transcript carries no
duration field: `sessionDurationMs` (wall clock, idle included),
`sessionActiveMs` (gaps over 5 min dropped) and per-model `avgResponseMs` with
its raw `responseMsTotal` / `responseSamples` so any average can be recomputed.

Energy, carbon and tree-time are fixed multiples of each other in AiEDs v2, so
those three lines on the chart coincide exactly. That is the model, not a bug -
which is why gCO2e and tree-min are off by default.

## UI layout model

The page is sized to the viewport (`min-width: 1301px and min-height: 800px`
locks `html/body` and the shell to `100vh`); below either threshold it falls
back to normal document scrolling rather than clipping. Panels are `flex: 0 1
auto`; `.grow` panels take a column's slack, `.no-shrink` panels never give up
height, and anything that can outgrow its box scrolls inside it. On a phone the
pad column is ordered first and the two wide columns follow, scaled down.

Four CSS traps hit during the build, all still relevant:

- **`[hidden]` is a UA rule and loses to any class that sets `display`.** A
  "hidden" grid still occupied 42px until a global
  `[hidden] { display: none !important }` was added.
- **`:last-of-type` matches by tag, not class.** Adding a footer `div` to a tile
  silently stopped `.panel-section:last-of-type` from matching, and the section
  it had been sizing shrank under its own content and painted over the footer.
  Use explicit classes for sizing.
- **`mix-blend-mode` plus `preserve-3d`/`backface-visibility` is unreliable.**
  A 3D flip rendered correctly headless and not at all on a GPU-composited
  browser; the credit cards are a plain opacity crossfade now, with the blend
  mode on the image alone.
- **`flex-basis: auto` on a long list lets it claim a whole column.** The
  25-row process list pushed the AiEDs block off the tile until both scrollers
  moved to `flex: 1 1 0`.

## Verifying UI changes

Screenshots and geometry come from headless Chrome driven over CDP
(`--remote-debugging-port`, `Emulation.setDeviceMetricsOverride`,
`Page.captureScreenshot`). Useful assertions, all cheap:
`document.scrollHeight <= clientHeight` (no page scroll), per-panel
`scrollWidth > clientWidth` (horizontal overflow), and element bounding boxes
against their panel's box (clipping and overlap). A green screenshot is not
evidence on its own - measure.

## Talk, and why the pad cannot dictate on its own

Pressing the pad talk key reaches the page over SSE and calls the same toggle
the on-screen button does, but Chrome will not run speech recognition for a
document that is not focused - and `navigator.clipboard.writeText` refuses for
the same reason. Since you press the pad precisely when you are working in
another window, device-triggered dictation cannot work unaided.

What the code does about it: transcripts go to the Notes box FIRST (focus-
independent and visible) and the clipboard second; every speech error is
reported in the notice line instead of being swallowed; and an unfocused talk
press says so explicitly. `focusBrowserOnTalk` (off by default) raises the
browser window from the server side, which is the only place that can - a page
cannot focus itself.

## Trade-offs on record

- Below 1200px viewport height the Light tile cannot show all six slot rows plus
  both light sections; the slot editor scrolls. Moving the two Save buttons back
  inline with their headings frees the ~80px if that changes.
- The on-screen dial and toggle are display-only. The endpoints (`/api/dial`,
  `/api/joy`) and their bridge methods are in place and mirror the physical
  controls; re-enabling is deleting the `disabled` block in `makeKnob`.
- `avg runtime` and `cost` chips stay dark until sessions end with timing and a
  priced model, and say so in their tooltips rather than showing zeros.
