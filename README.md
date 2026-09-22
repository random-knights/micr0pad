<a name="readme-top"></a>

<!-- HEADER -->
<div align="center">
  <img alt="Random Knights 0P MicroPad" src="assets/readme-header.png?v=20260906">

<h3 align="center" style="color:#ff4124">0P_Micr0Pad</h3>

  <p align="center">
    Live AI-agent status lights on a Work Louder macropad.
    <br />
    <a href="docs/DEVELOPMENT.md"><strong>Explore the docs »</strong></a>
    <br />
    <br />
    <a href="https://worklouder.cc/codex-micro">Codex Micro</a>
    ·
    <a href="https://worklouder.cc/creator-micro-2">Creator Micro 2</a>
    ·
    <a href="https://herdr.dev">Herdr</a>
    ·
    <a href="https://github.com/random-knights/micr0pad/issues">Report Bug</a>
    ·
    <a href="https://github.com/random-knights/micr0pad/issues">Request Feature</a>
    <br />
    <br />
    &#127979; 2025-2030 &#128760; roswell, ga &#127825;
    <a href="https://randomknights.xyz">&#7450;k.xyz</a> +
    <a href="https://randomknights.llc">&#7450;k.llc</a> +
    <a href="https://randomknights.org">&#7450;k.org</a> &#127984;
    <a href="https://rand0m.ai">rand0m.ai</a>
  </p>
</div>

<!-- SUMMARY -->

## <span style="color:#555555"><u> **SUMMARY** </u></span>

Your agents are already running. This puts them on your desk, where you can see
them without switching windows.

MicroPad turns a **Work Louder Codex Micro** or **Creator Micro 2** into a status
board for AI coding agents. It reads agent state from [Herdr](https://herdr.dev),
the terminal multiplexer that hosts them, and paints that state onto the pad's
per-key lights. One key per agent. Red means blocked, purple means working, blue
means done, yellow means idle. The strip underneath carries the worst state of
the six, so the pad is readable from across the room.

It does not care which AI you use. Claude Code, Codex, Gemini, Grok, Hugging
Face, Ollama, anything Herdr can run.

No vendor app sits in the middle. The bridge speaks the device's own JSON-RPC
over raw HID, and what it learns about your machine stays on your machine.

<div align="center">
  <img alt="Micr0Pad running with the Random Knights agent workspace" src="assets/readme-demo.gif?v=20260906">
</div>

- Built with
  - Node, no build step. One dependency, `node-hid`, which brings two more in
    with it (a clean install reports three packages).
  - raw HID, the vendor JSON-RPC interface, not a keyboard shim
  - [Herdr](https://herdr.dev) for agent state
  - the browser's own speech recognition for voice to text
  - [AiEDs v2.0.0](https://randomknights.xyz/aieds) for energy and carbon
    estimates, off until you ask for them
  - a browser page in plain HTML, CSS and JS. View source and you have read the
    whole client.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- INSTALL -->

## <span style="color:#555555"><u> **INSTALL** </u></span>

One command:

```powershell
npx @randomknights/micr0pad
```

npm downloads the package, writes your `config.json` from the example on the
first run, and starts the server. Open **http://localhost:4120**. No compiler
is needed: the one native dependency, `node-hid`, ships prebuilt binaries for
Windows (x64, x86, arm64), macOS (Intel and Apple silicon) and Linux (x64,
arm64, armv7, and x64 musl). On any other platform npm skips it, and the app
runs the virtual pad described below instead of a physical one.

If npm answers `E404`, the package has not reached the registry yet; use the
checkout below, which is the same app.

Where your settings live: with `npx`, `config.json` (your slot names, action
commands and the pairing token) is written inside npm's cache, next to the
package. A new version, or a cleared cache, starts from a fresh config and a
fresh pairing. To keep one config across versions, point
`RK_MICROPAD_CONFIG` at a file of your own before starting. A keymap backup
taken from the page lands in the same place, so take the one you mean to keep
from a checkout (`npm run backup-keymap`, below).

On Linux, reading the pad needs `libudev` (present on nearly every desktop
distribution) and permission to open the device's `hidraw` node.

If `node-hid` ever refuses to load, the app prints the reason on its console
and serves the virtual pad; in a checkout, `npm rebuild node-hid` rebuilds it.

### From a checkout (contributors, and the flash scripts)

```powershell
git clone https://github.com/random-knights/micr0pad
cd micr0pad
npm start
```

`npm start` installs the dependencies if they are missing, writes your
`config.json` from the checked-in example on the first run, and then starts the
server. The keymap and flash scripts below (`npm run backup-keymap` and the
rest) run from a checkout.

You need Node 18 or newer. If yours is older the app says so, with your version
number, instead of failing later somewhere confusing.

Agent lights need [Herdr](https://herdr.dev) installed and on your `PATH`.
Without it the pad still runs and the six slots simply sit idle:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"
```

### Before you flash anything

Two of the setup scripts write to the device's flash memory. Back up the keymap
first. It is the only way back to a pad that behaves like the one you bought,
and the backup refuses to overwrite itself once it exists, so run it before
anything else touches the device:

```powershell
npm run backup-keymap
```

Then, optionally, bind the dial and the joystick, and give the touch sensor some
layers to cycle through. Both of these write to flash:

```powershell
npm run bind-dial-joy
npm run add-layers -- --write     # leave off --write to see what it would do
```

If port 4120 is taken, set `RK_MICROPAD_PORT` to something else before starting.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- WHAT IT DOES -->

## <span style="color:#555555"><u> **WHAT IT DOES** </u></span>

- **A key per agent.** Six of them. Each one takes the color of its agent's
  state, and each slot keeps its own identity color, so two Claudes are still
  two different keys.
- **A mirror in the browser** at `http://localhost:4120`. Every key, the dial
  and the joystick, following the real device as you touch it.
- **Action keys that run your commands.** Four of them, plus a terminal key.
  They ship pointing at nothing: shipping one team's scripts would give
  everyone else buttons that can only fail. Click the gear in the Action Keys
  tile, give a key a label and a command, and it works from the pad and from
  the page.
- **A talk key.** It types what you say into the notes box and the clipboard,
  and the strip pulses gold while it is listening. Speech recognition is the
  browser's, so the tab has to be in front; press talk while you are working
  elsewhere and the app tells you that rather than going quiet.
- **Lights you can edit.** Slot names, colors and the outer light, saved to
  `config.json`. Eight choices in the effect list: follow the agent state, or
  pick one of the seven the firmware has (solid, pulse, soft pulse, spin,
  rainbow, gradient, off).
- **A system panel.** CPU, memory, the top processes with an end task button,
  a resource watch that flags what has been wrong for long enough to matter
  (see below), and an optional energy panel.
- **Pairing and revert.** Hand the lights back to the firmware so you can pair
  the pad over Bluetooth, or put the original keymap back.

<div align="center">
  <img alt="Micr0Pad browser dashboard" src="assets/app-screenshot.png?v=20260907">
</div>

### Without a pad

You do not need the hardware to run this. When no Work Louder pad is on the USB
bus, the app serves a **virtual pad**: the same six status keys, lit by the same
agent states, with the browser mirror as the pad itself. The header says
`virtual pad` so you always know which one you are looking at, and the keys in
the mirror become clickable, so a press does what pressing the real key does.

It is the same code path either way. The virtual pad answers the same commands
the firmware answers, and refuses the ones the firmware refuses rather than
pretending they worked. The two things it cannot do are the two that live in the
device flash: it has no keymap to back up and none to restore, so those buttons
wait for real hardware.

Plug a pad in at any point and it takes over on the next poll, with the colors
it was already showing painted straight onto the keys. Unplug one and the app
says the pad is gone rather than slipping back to a virtual one behind your
back; set `virtualPad.onUnplug` to `true` in `config.json` if you would rather
it did fall back, and `virtualPad.enabled` to `false` to turn the whole thing
off.

To start the server without touching the USB bus at all (no pad, no virtual
pad), set `RK_MICROPAD_NO_DEVICE=1`. That is for tests, and for a second copy
of the app while another one already holds the pad: only one process can.

### The pad

```
 ( dial )  [ agent 1 ] [ agent 2 ]  ( toggle )    encoder, two keys, joystick
 [agent 3] [ agent 4 ] [ agent 5 ] [ agent 6 ]    the six status keys
 [action 1] [action 2] [action 3] [ action 4 ]    your commands
 [        talk (wide)        ] [   terminal   ]
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- HARDWARE -->

## <span style="color:#555555"><u> **HARDWARE** </u></span>

| | |
|---|---|
| Device | Work Louder [Codex Micro](https://worklouder.cc/codex-micro) or [Creator Micro 2](https://worklouder.cc/creator-micro-2) |
| Verified on | Codex Micro, VID `0x303a` PID `0x8360`, firmware v0.4.1 |
| Host | Windows. The process list and the command launchers use Windows tools. |
| Needs | Node 18 or newer, and [Herdr](https://herdr.dev) for the agent lights |

Only one program at a time can hold the device. If the pad looks dead, another
copy of this server is usually still running.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONFIGURE -->

## <span style="color:#555555"><u> **CONFIGURE** </u></span>

Everything you change in the browser is saved to `config.json`, which is created
for you on the first run and is never committed. Slot matching, colors, action
commands, the outer light and the pairing token all live there.
`config.example.json` is the same shape, checked in, to read or copy from.

The action keys look for your `.cmd` files in this order, and the editor shows
you which directory it settled on:

1. `MICROPAD_CMD_DIR`
2. `cmdDir` in `config.json`
3. `<app>/cmd`
4. a `_macropad` folder beside the app

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- RESOURCE WATCH -->

## <span style="color:#555555"><u> **RESOURCE WATCH** </u></span>

The System panel watches the machine the pad is plugged into and says so when
something has been wrong for long enough to matter. It never ends a process on
its own: it alerts, and you decide.

**What it watches.** One sampler reads every process every 3 seconds and keeps
ten minutes of history per process. A rule fires only when its condition has
held for the whole of its window; one sample short does not count, and a gap in
sampling starts the window over.

| rule | fires when | why these numbers |
|---|---|---|
| `cpuSustained` | total CPU at or above 85% for 90 s | a Flutter web build pins every core for 30 to 60 s; 90 s clears a build and still catches a runaway |
| `memSustained` | RAM at or above 90% for 60 s | Windows starts trimming and paging near 90%; a minute rules out a transient spike |
| `processHog` | one process at or above 2 GB working set for 120 s, or at or above 50% CPU for 120 s | above any single healthy renderer, analysis server or node process; half the machine from one process for two minutes is a spin, not work |
| `hungChrome` | a `chrome.exe` with no CPU at all for 180 s while holding 800 MB or more | a parked renderer keeps its memory and does nothing; an idle background tab sits well under 800 MB |
| `orphanDev` | a `dart.exe`, `dartvm.exe` or `java.exe` whose parent is gone, or is not an editor, toolchain or shell, for 300 s | analysis servers and Gradle daemons are what editors leave behind. A Gradle daemon detaches from its launcher by design, so it will show here after five minutes; that is the point, snooze it or end it |

**What happens.** The pad's outer light flashes the blocked color twice and
goes back to showing agent state (it stays out of the way while talk is on).
A banner in the System panel names the rule and the process, with an `end`
button and a `snooze 30 min` button per rule. Every alert and every `end` is
appended to `watch.log` next to `config.json`: process name, pid, rule, time
and who asked. No window titles, no user names, no paths.

**What it will not do.** `end` works only on the allowlist `watch.killable`,
which ships as `chrome.exe`, `dart.exe`, `dartvm.exe`, `java.exe` and
`msedgewebview2.exe` (on Dart 3.x `dart.exe` is a launcher and the work runs
in a `dartvm.exe` child, so both are listed).
The button is disabled for anything else, in the banner and in the process
table, and the server refuses it again. `node.exe` is deliberately not on the
list: this server and Herdr are node processes, and ending the wrong one
leaves the pad's HID handle wedged until you replug it. `watch.autoKill`
exists in the config and is always off in this version; nothing reads it, and
the UI says "coming later" with no toggle. An alert-only first version means a
wrong threshold costs you a banner, not a build.

**Changing thresholds.** Everything is under `"watch"` in `config.json`; the
shape and the defaults are in `config.example.json`. Set `enabled: false` on
a rule to silence it for good, change a number to move it, or edit
`killable` to allow another process. Restart the server after editing.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- WHAT LEAVES -->

## <span style="color:#555555"><u> **WHAT LEAVES YOUR MACHINE** </u></span>

Nothing, by design. There is no account, no sign in, and no server of ours to
talk to.

What the app does guard is itself. Any page in any browser tab can send a
request to `localhost`, and this app can end processes and run commands, so
every request has to come from the app's own page, and every request that
changes something also has to carry the pairing token that was minted into
your `config.json` on first run. Without both, the answer is a refusal, not an
action. The token is a secret. It is never printed, never logged and never
returned to a page from another origin.

Pressing a key on the virtual pad is one of those changing requests. Clicking a
key in the browser mirror is not a shortcut around any of this: it proves its
origin and carries the token exactly as ending a process does, and the server
refuses it outright while a physical pad is connected, because a click is not a
press of hardware nobody touched.

That applies to reading as well as to changing. A page on another site asking
this server for your machine's name or your process list is refused, and no
response carries a header that would let another origin's code read the body
even if it got one. There is one gap left, and it is worth knowing about: a
program running on your machine is not a browser, so it is not bound by any of
this. The pairing token is what stands in its way on anything that changes
something, and a local program that can read your `config.json` has already
read the token.

### Pairing a hosted page

There is one deliberate way through that wall, and you open it by hand.

A page on `https://rand0m.ai` is a different origin, so by default it is
refused exactly like any other site. To let it in, press **show pairing code**
in the Hosted Pages box on this dashboard. The app puts an eight-character code
on screen. Type that code into the hosted page. The page sends it back, the app
checks it, and hands that page a token for its own origin.

What each piece is doing:

- **The code is carried by you.** That is the whole security boundary. A page
  can only pair if somebody sitting at this machine read a code off this screen
  and typed it over there. The code lives five minutes, is worth one use, and a
  wrong guess burns it.
- **The token is shown once and stored as a hash.** Your `config.json` ends up
  with the origin, a label, a date and a SHA-256 digest. Someone who reads that
  file cannot pair with it, which is not true of the local pairing token
  sitting beside it.
- **The origin is part of the pairing.** The browser attaches the page's origin
  to every request and a page cannot forge it, so a token lifted from one site
  does not work from another.
- **The list of sites that may even ask is fixed.** `hostedOrigins` in
  `config.json`, shipping as `https://rand0m.ai`, `https://stg.rand0m.ai` and
  `https://abc-rand0m-ai.web.app`. It is never a wildcard: an entry that is not
  a plain `https://` origin is dropped rather than honored. A `config.json`
  written before `https://stg.rand0m.ai` was added keeps its own shorter list,
  because a user's explicit list is never widened behind their back: add the
  line by hand if you want to pair from the staging page.

**What a paired page can do:** everything the local dashboard can, with three
exceptions. It reads pad and agent state, system metrics and the process table,
and it can save config, drive the lights and run an action key. Pairing a page
is handing it your pad, not lending it a window.

**What a paired page cannot do, ever:**

| route | why it stays on this machine |
|---|---|
| `/api/pairing-token` | it hands out the LOCAL page's token; giving it away would let a hosted page act as the local page, which is what pairing replaces |
| `/api/pair/start` | minting codes is how pairings are created, and only the person at the machine creates one |
| `/api/sys/kill` | ending a process is a thing you do at the machine it happens on |

**Revoking.** Press **revoke** next to a pairing here, or **disconnect** on the
hosted page. Either end cuts it, and the token stops working immediately; a
paired page can only revoke its own pairing, never somebody else's.

**Mixed content.** The hosted page is `https` and this bridge is plain `http`
on localhost. Browsers carve localhost out of the mixed-content rules, so the
call is allowed: verified in headless Chrome 153 with a self-signed `https`
page against a local bridge, where the paired read returned 200 and the console
reported no mixed-content block at all. The only refusal in that run was this
app's own, for the unpaired attempt.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ENERGY -->

## <span style="color:#555555"><u> **ENERGY REPORTING (OPTIONAL)** </u></span>

The system panel can show modeled energy, carbon and cost for your own agent
sessions, using the
[AI Energy Disclosure Standard](https://randomknights.xyz/aieds) v2.0.0. A fresh
install shows an empty panel and records nothing. It starts only when you add
the hook.

For Claude Code, add a SessionEnd hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "node",
        "args": ["<path-to-repo>/hooks/aieds-local.js"] } ] }
    ]
  }
}
```

The hook reads that session's own transcript, adds up the token counts the API
reported, and appends one line per model to `aieds-local.jsonl` beside the app.
Set `AIEDS_LOG_PATH` to put it somewhere else, and give the server the same
value so both ends read the same file.

Cost is a **modeled list price, not a bill.** Rates live in
`lib/aieds-rates.json`, and a model that is not in that file gets no cost figure
rather than a guessed one. In AiEDs v2 energy, carbon and tree time are fixed
multiples of each other, which is why those three lines sit on top of one
another on the chart.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ANALYTICS -->

## <span style="color:#555555"><u> **ANALYTICS (OFF UNTIL YOU SAY OTHERWISE)** </u></span>

There is a small local log of what the pad costs to run. It is off. Nothing is
written, and no file is created, until you turn it on:

```json
{ "analytics": { "enabled": true } }
```

in `config.json`, or `MICR0PAD_ANALYTICS=1` in the environment. Read it back
with `npm run analytics`, and turn it off again by deleting the file and the
setting.

It writes one line when the server stops: how long it ran, how long the pad was
attached, how many times the lights were repainted, and how much processor time
the server used. That is the whole list.

It does not record your machine name, your user name, your folders, your window
titles, your agent or slot names, your action key labels or commands, or which
keys you pressed. Those were considered and dropped, not shortened or hashed. A
count of repaints is the cost of running something. A record of presses is a
record of a person.

Nothing is sent anywhere. There is nowhere to send it: the app has no analytics
endpoint and opens no connection for one. The file is yours, it is ignored by
git, and deleting it undoes everything it ever recorded.

Energy in watt hours is not modeled here. AiEDs v2 models energy from AI token
counts, and there is no sourced figure for what this device draws, so the log
carries the measurements and says the energy number is unavailable rather than
printing a guess with a unit on it.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- DEVELOPMENT -->

## <span style="color:#555555"><u> **DEVELOPMENT** </u></span>

```powershell
npm test           # the test suite, node:test, no framework
npm run analytics  # totals from the local analytics log
npm run probe      # ask the device what it is
```

There is no build step. `public/` is served exactly as it is written.

CI runs the same `npm test` on every pull request. It installs without building
the native module, because nothing under test opens a device and the runner has
no pad plugged into it. It also checks the npm tarball's file list and
installs the packed tarball into an empty folder to start it with
`RK_MICROPAD_NO_DEVICE=1`. Anything that needs real hardware is checked by hand
against a real pad, and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) says which
parts those are.

**What is covered without hardware.** The transport and adapter modules run
under `node --test` with no pad and no Herdr installed, using a virtual pad
and recorded Herdr output in place of both:

- `wldevice.js` - the report framing, the JSON-RPC envelope (report id,
  channel, chunking), the notify/response split, and the absent-device error,
  all through pure functions the module exports for this reason. The one
  thing never done here is opening a real HID handle.
- `pad.js` - the key/action id maps, the status color and effect table, the
  worst-of-six underglow priority order, and the hex color packer.
- `mapper.js` - assigning live agents to the 6 slots by agent/cwd/title match,
  the per-slot color override, and the worst-of-six rule that drives the
  underglow.
- `herdr.js` - parsing `herdr agent list` output into the pad's agent shape
  for idle, working, blocked, done and an unrecognized status, and the
  optional-herdr path (a clear rejection, not a hang, when the binary is
  missing). `execFile` is injected so no process is spawned.
- `launcher.js` - the `.cmd` file search order (`MICROPAD_CMD_DIR`, then
  `config.json`'s `cmdDir`, then `<app>/cmd`, then the sibling `_macropad`
  folders) and that an absolute path in config wins outright.
- `bridge.js` - the full handover state machine (virtual pad in, physical pad
  takes over, unplug is not silently backfilled, a replay failure is
  reported but the new device stays connected, an empty snapshot replays
  nothing, the outgoing virtual pad is closed).

**What still needs the hardware.** Actually opening the Work Louder vendor HID
interface (`wldevice.js`'s `open()` against a real device), and the flash
scripts (`backup-keymap.js`, `restore-keymap.js`, `add-layers.js`,
`bind-dial-joy.js`) - every one of those is checked by hand against a real
pad, as [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) says.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- The AiEDs section below is GENERATED and reports the energy of developing
     THIS repository. Everything between AIEDS:BEGIN and AIEDS:END is written by
     the AiEDs README generator from the SessionEnd ledgers and placed here by
     scripts/sync-aieds.mjs in random-knights/.github. Do not hand edit it: a
     typed figure is a figure nobody can check, and the AiEDs block check fails
     a README whose block has drifted from the generated one. -->

<!-- AIEDS:BEGIN -->

<div align="center">

## <span style="color:#FF4124"> **Ai Energy Disclosure Standard** </span> ( <span style="color:#FAAFA5"><small> **AiEDs v2.2.0** </small></span> )

### 🌎 <span style="color:#EDC303"> Total **AiEDs** Usage | micr0pad </span> 🏰

<table>
<tr>
<td align="center" width="25%">

⚡<br>
<b>113.7</b><br>
<sub>kWh</sub>

</td>
<td align="center" width="25%">

🌫️<br>
<b>48.8</b><br>
<sub>kg CO₂e</sub>

</td>
<td align="center" width="25%">

🌳<br>
<sub>Tree-Time</sub><br>
<b>848</b><br>
<sub>days</sub>

</td>
<td align="center" width="25%">

🔢<br>
<b>650 M</b><br>
<sub>tokens, 11 sessions</sub>

</td>
</tr>
</table>

<sub>Tree-Time is the time one mature tree (two or more years of growth) needs to capture this carbon at its yearly rate, 21 kg CO₂e per year; shown in days.</sub>

**The figures above are the AiEDs impact of developing this repository,**
measured by a `SessionEnd` hook on the developers' machines and reported under AiEDs section 2.4.1,<br>
which counts plain input, cache-creation and cache-read tokens all as input at the input coefficient.<br>
<sub>96.4 percent of our input is cache reads, so that rule decides the answer by 7.2x.
Weighting a cache read at 0.1 instead gives <b>15.8 kWh, 6.8 kg CO₂e, 118 days of Tree-Time</b>.
That lower figure is <b>a local departure from the standard, not a reading of it</b>. It is
published because it is what this project offsets against.
</sub>

<details>
<summary><b>Equivalencies</b></summary>

<sub>The same educational comparisons the rand0m.ai app renders, from the same constants. Educational comparisons, not measurements.</sub>

| Equivalent | Amount | Basis |
| --- | ---: | --- |
| Phone charges | 9,475 | 12 Wh per charge |
| LED bulb hours | 11,371 | 10 W bulb |
| Laptop hours | 2,274 | 50 W laptop |
| Driving distance | 287 km | 170 g CO₂e per km |
| Tree-Time | 848 days | 21 kg CO₂e per mature tree per year |

</details>

<details>
<summary><b>Offset</b></summary>

<sub>What the figures above cost, and what it would take to absorb them. Modeled, like everything else here.</sub>

**Energy cost: USD 20.85.** 113.7 kWh at USD 0.1834 per kWh, the United States average residential price for June 2026 (18.34 cents per kilowatthour), from <a href="https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_3">U.S. Energy Information Administration, Electric Power Monthly, Table 5.3</a>. The rate is pinned, not looked up at render time, so this figure is reproducible.

**Modeled provider spend: USD 430.84.** The same sessions priced at published API list prices, rates version 2026-09-01, with cache writes at 1.25x and cache reads at 0.1x an input token. It is a MODEL, not a bill: this work runs on a subscription, so the marginal cost was nothing. It covers the 4 of 11 sessions counted above whose model that file prices; the other 7 carry a model nobody has priced and add nothing, rather than an assumed rate.

**Trees needed: 3.** 48.8 kg CO₂e divided by 21 kg CO₂e, the yearly capture of one mature tree, rounded up: 3 mature trees would absorb this carbon within one year. Put the other way round, that is the Tree-Time above: one mature tree working for 848 days, about 2.3 years.

**Offset cost: USD 0.29.** 0.0 tonnes of CO₂e at USD 6.03 per tonne, the REDD+ (Reduced Emissions from Deforestation and Degradation in Developing Countries) average, 2024, <a href="https://www.ecosystemmarketplace.com/publications/2025-state-of-the-voluntary-carbon-market-sovcm/">Ecosystem Marketplace, State of the Voluntary Carbon Market 2025, Table 4</a>. That is a nature-based avoidance and protection, not removals average: this project prices itself against keeping land, animals and trees standing, never against carbon removals or industrial and household offsets. Buying an offset is not the same as not spending the energy, and this line does not claim otherwise.

</details>

<sub>
<a href="https://standard.rand0m.ai/aieds/v2/methodology.md">AiEDs Methodology v2.2.0</a>
by <a href="https://standard.rand0m.ai">Random Knights, LLC</a> (ORCID 0009-0006-5066-1693),
<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
· `claude` coefficients are <code>class-estimated</code>, the second-weakest provenance tier
· grid 429 gCO₂e/kWh pinned
· measured by a `SessionEnd` hook, not modeled from a guess<br>
Energy and carbon are modeled estimates. Tree-Time and equivalents are educational comparisons.
</sub>

<sub>Measured by a <code>SessionEnd</code> hook on one developer machine; a second machine's ledger is not yet merged in, over 293 recorded sessions covering 2026-07-27 to 2026-09-13, which is every session the hook recorded and no session it did not. Two attribution bases are published: BY LANE LEDGER in the table above, and BY WORKING DIRECTORY, the stricter view, in <code>aieds-readme.json</code>. The organization totals are the same under both. Both bases are DATE AWARE: the application repository was named <code>xyz</code> until 2026-08-19 and is named <code>ruok</code> now, so a row written before that day is placed on the repository the name meant then. Any offset figure is a nature-based average, not removals. Generated, never hand-typed.</sub>

</div>

<!-- AIEDS:END -->

<!-- CREDITS -->

## <span style="color:#555555"><u> **CREDITS** </u></span>

- [schacon/micro-manager](https://schacon.github.io/micro-manager/) worked out
  this device's JSON-RPC surface, its effect table and its key binding rules.
  This project would not exist without that work.
- [Herdr](https://herdr.dev), the agent runtime this reads from.
- [Work Louder](https://worklouder.cc), the hardware.

Questions, bugs and ideas: [open an issue](https://github.com/random-knights/micr0pad/issues).

## <span style="color:#555555"><u> **LICENSE** </u></span>

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The Random
Knights name and brand assets are not covered by the license.

<p align="right">(<a href="#readme-top">back to top</a>)</p>
