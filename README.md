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

<div align="center">
  <img alt="Micr0Pad browser dashboard" src="assets/app-screenshot.png?v=20260907">
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

Two commands, and the second one is the whole install:

```powershell
git clone https://github.com/random-knights/micr0pad
cd micr0pad
npm start
```

`npm start` installs the dependencies if they are missing, writes your
`config.json` from the checked-in example on the first run, and then starts the
server. Open **http://localhost:4120**.

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

- **A key per agent.** Six of them. Each one takes the colour of its agent's
  state, and each slot keeps its own identity colour, so two Claudes are still
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
- **Lights you can edit.** Slot names, colours and the outer light, saved to
  `config.json`. Eight choices in the effect list: follow the agent state, or
  pick one of the seven the firmware has (solid, pulse, soft pulse, spin,
  rainbow, gradient, off).
- **A system panel.** CPU, memory, the top processes with an end task button,
  a resource watch that flags what has been wrong for long enough to matter
  (see below), and an optional energy panel.
- **Pairing and revert.** Hand the lights back to the firmware so you can pair
  the pad over Bluetooth, or put the original keymap back.

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

Plug a pad in at any point and it takes over on the next poll, with the colours
it was already showing painted straight onto the keys. Unplug one and the app
says the pad is gone rather than slipping back to a virtual one behind your
back; set `virtualPad.onUnplug` to `true` in `config.json` if you would rather
it did fall back, and `virtualPad.enabled` to `false` to turn the whole thing
off.

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
for you on the first run and is never committed. Slot matching, colours, action
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

**What happens.** The pad's outer light flashes the blocked colour twice and
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

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ENERGY -->

## <span style="color:#555555"><u> **ENERGY REPORTING (OPTIONAL)** </u></span>

The system panel can show modelled energy, carbon and cost for your own agent
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

Cost is a **modelled list price, not a bill.** Rates live in
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

Energy in watt hours is not modelled here. AiEDs v2 models energy from AI token
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
no pad plugged into it. Anything that needs real hardware is checked by hand
against a real pad, and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) says which
parts those are.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CREDITS -->

## <span style="color:#555555"><u> **CREDITS** </u></span>

- [schacon/micro-manager](https://schacon.github.io/micro-manager/) worked out
  this device's JSON-RPC surface, its effect table and its key binding rules.
  This project would not exist without that work.
- [Herdr](https://herdr.dev), the agent runtime this reads from.
- [Work Louder](https://worklouder.cc), the hardware.

Questions, bugs and ideas: [open an issue](https://github.com/random-knights/micr0pad/issues).

## <span style="color:#555555"><u> **LICENSE** </u></span>

MIT. See [LICENSE](LICENSE).

<p align="right">(<a href="#readme-top">back to top</a>)</p>
