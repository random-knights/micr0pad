# AGENTS - agent rules for micr0pad

Canonical rules live in the working-root standard (`AGENTS.md` at the root of
the agent workspace). This file restates what an agent MUST follow here and
adds the micr0pad specifics. If the two ever disagree, the working-root
standard wins.

micr0pad is a LOCAL tool that talks to hardware over raw HID and runs commands
on the machine it is installed on. It is also going public. Both facts set the
bar: a mistake here writes to someone's device flash, runs on someone's PC, or
publishes something that should not have left it.

## Owner ethos

The owner approves; agents execute end to end (implement, commit, push, PR,
green CI). The owner merges. There is no deploy: the product IS the repo, so
a merge to `main` is the release.

- Credentials, secrets, tokens, and console sign-ins are owner-only, always.
  Never create, read into chat, print, or commit a secret. The pairing token
  in `config.json` is a secret: it is minted on the machine, it is gitignored,
  and it never appears in a log line, a response body, or a screenshot.
- Never force-merge, never bypass branch protection, never add retries or
  skips to hide a real failure, never fake a green run.
- Reversible cleanup: park or quarantine, never hard-delete.
- ASCII, no em dashes and no en dashes, in committed text. The K13 gate in
  `test/public-safety.test.js` fails on a single one.

## This repo is public

Everything in it is readable by strangers, including the git history, so a
secret committed once is a secret rotated, not a secret removed.

`test/public-safety.test.js` is the mechanical half of this rule and it runs
in CI. It fails on an absolute path from someone's machine, on a tracked
per-machine file, on a token in `config.example.json`, on an action key that
ships pointing at somebody's private script, and on a dash.

The judgment half is not automatable, so it is written down here:

- No hostnames, usernames, machine names, network names or locations in
  committed text, in comments, or in a screenshot checked into `assets/`.
- No internal repo names, lane names, ticket numbers or team shorthand.
  Someone reading this repo has none of that context.
- Defaults ship unconfigured. Action keys point at nothing, analytics are off,
  and no default names a script only one team has.

## Concurrency

The constraint is a SHARED `.git` DIRECTORY, not the repo itself.

    SHARED WORKTREES  -> at most ONE write-lane per repo.
    SEPARATE CLONES   -> multiple write-lanes are allowed.

Each lane gets its own full clone, claims FILE PATHS (not just the repo name)
on the lane board before touching anything, and rebases onto `origin/main`
before pushing. Two lanes on the same file are never safe.

The shared checkout of this repo is frequently sitting on another agent's
branch. Check `git status` before assuming you are on `main`.

## Toolchain

Node 18 or newer (`engines` in `package.json` states the floor; the server
uses `fetch`). One runtime dependency, `node-hid`, which is native.

    npm start          # preflight (deps, first-run config) then the server
    npm test           # node:test, no test framework dependency
    npm run analytics  # totals from the opt-in local analytics log

There is no build step and no bundler. `public/` is served as written, so what
you read in the file is what the browser runs.

## Browser identity

- Tab title: `0P | Micr0Pad`.
- Favicon source: the owner-supplied `0P.png`, copied to `public/favicon.png`.
- README header and demo assets live under `assets/` and must resolve locally.

## Hardware rules

The pad is not a toy target: three of the scripts write to device flash.

- `npm run backup-keymap` FIRST, always, before anything writes. It is the
  only way back to stock and it refuses to overwrite an existing backup.
- `npm run add-layers -- --write` and `npm run bind-dial-joy` both flash. The
  dry run is the default for a reason; keep it that way for anything new.
- Only ONE process can hold the HID handle. A second server, or a leftover
  one, is why the device looks dead. Stop the other one, do not add a retry.
- `{"ok":1}` from the device means the frame was accepted, not that the light
  changed. Verify a lighting claim by looking at the pad, or say you did not.

## Auth

One policy, one code path. `originAllowed()` in `server.js` is the only place
an origin is judged, and every `/api/` request passes it before any handler
runs: a read proves its origin, anything else proves its origin and carries
the pairing token. No response sets `Access-Control-Allow-Origin`. Do not add
one, and do not add a route that answers ahead of the gate.
`test/origin-policy.test.js` fails on either.

The pairing token plus the origin allowlist in `server.js` is the ONLY auth
this tool has, and that is deliberate: it is a local tool, and accounts,
OAuth or a cloud identity would give it a login to protect and a service to
depend on. Do not add any of that. If a feature genuinely needs to know who
someone is, that feature belongs somewhere else, and the honest move is to
say so rather than to build a sign-in into a desk gadget.

## Analytics

Opt-in, off by default, local, and about the pad rather than the person. The
rule that decides any new field: a cost of running is allowed, a record of
what the user did is not. `lib/analytics.js` carries the kept and dropped
lists, and the tests hold the default off.

## CI

One workflow, `.github/workflows/00-ci-gate.yml`, one job named exactly
`CI Gate`. It always runs and always concludes, with no `paths:` filter, so a
required-check ruleset has a context that actually reports. Do not rename the
job.

## See also

`README.md` for what this is and how to install it. `docs/DEVELOPMENT.md` for
the protocol, the effect table and the traps that cost real time.
