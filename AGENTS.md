# AGENTS - working on micr0pad

micr0pad is a local Node tool that drives the per-key lights of a Work Louder
Codex Micro or Creator Micro 2 over raw HID and serves a small browser page
that mirrors the pad. It runs on the machine it is installed on.

## Install

    npx @randomknights/micr0pad

Or from a checkout (needed for the keymap and flash scripts):

    git clone https://github.com/random-knights/micr0pad
    cd micr0pad
    npm start

Node 18 or newer. `node-hid` is the only runtime dependency and it is optional.

## Run, test, check

    npm start           # preflight, first-run config, then the server
    npm test            # node:test suite, includes the public-safety checks
    npm run check-pack  # what the npm tarball would contain

There is no separate linter and no build step; `npm test` is the gate.

## No-device mode

Set `RK_MICROPAD_NO_DEVICE=1` to run the server without opening the pad. Use
it for every automated or agent run.

## Rules

- Never commit `config.json`, a pairing token, a key or an env file. They are
  gitignored and the tests fail on them.
- Hardware safety: do not open a plugged-in pad's HID handle in automated
  runs. Only one process can hold it, and some scripts write to device flash.
  Run `npm run backup-keymap` before anything that writes.
- ASCII only in committed text, and no em or en dashes.

## Contributing

Open a pull request to `main`. It merges only when the `CI Gate` check is
green.

Random Knights agents: read the workspace rules first.
