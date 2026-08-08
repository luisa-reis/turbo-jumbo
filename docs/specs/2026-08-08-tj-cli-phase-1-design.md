# `tj` CLI — phase 1: foundation and read commands

## Why

Turbo Jumbo is a web app, which is the wrong shape for two things it is
routinely needed for: answering a question over ssh without a browser
(_do I have this model, where does it live, what is eating the disk_), and
unattended work driven by cron or a shell script.

A companion CLI covers both. This document specifies the first of four phases.

## Architecture: an HTTP client

The CLI talks to a running Turbo Jumbo server rather than importing `lib/` and
doing the work itself.

The library layer would in fact support either. `lib/` carries no Next or React
imports at all, `lib/config` loads standalone outside Next, and a headless scan
of real storage returns 8 local and 40 cold models in 283 ms with no server
running. So the choice is not about feasibility.

It is about two things the HTTP shape gets for free:

- **Writes serialise through one process.** Later phases copy files and write
  sidecars. A CLI doing that in-process while the server runs an audit is a real
  corruption risk; going through the API makes the server the only writer.
- **Peer operations already work.** `app/api/v1/peers/[slug]/*` proxies to
  remote peers, so `tj ls --peer rio` is one request, not a second networking
  story.

It also needs no refactoring. Roughly 1,600 of the 3,493 lines in route handlers
are orchestration (`copy` 680, `copy/check` 374, `audit` 213, cold-storage
`from-local` 194 and `to-local` 182) that a direct-import CLI would have to
extract into `lib/` first.

The cost is that the CLI cannot help when the server is down. If debugging a
broken peer becomes a goal, the fix is to extract those handlers the way
`app/api/v1/hf-download/route.ts` already does — 20 lines delegating to
`lib/hf/hf-download-stream.ts` — and that extraction is worth doing on its own
merits regardless.

## Scope

Four phases, each independently shippable:

| Phase | Contains |
| --- | --- |
| **1 (this doc)** | conventions + `ls` `where` `disk` `peers` `version` |
| 2 | `get` `copy` `cold push/pull` — the streaming mutations |
| 3 | `audit`, `audit --fix` |
| 4 | `lemonade ls/sync`, `rm` |

Phase 1 is read-only on purpose. It fixes the conventions every later command
inherits — output format, exit codes, server discovery — while nothing it does
can corrupt anything if a convention turns out wrong.

## Design

### Home and layout

A new top-level `cli/`, with a `bin` entry in `package.json`:

```
cli/index.ts             entry and dispatch
cli/commands/*.ts        one file per command, thin
lib/cli/*.ts             the testable parts (+ co-located tests)
```

Not `bin/`, which holds dev and release scripts; a shipped CLI is a product
surface. `cli/` stays a thin shell so that argument parsing, table rendering,
the inventory merge and exit-code selection are pure functions under `lib/cli/`
with normal bun tests.

The binary is named `tj` (free on PATH, and it matches the `turbo-jumbo`
storage subdirectory).

### Server discovery

First match wins:

1. `--url <url>`
2. `TJ_URL`
3. the local peer's address from `config.yaml`, read through `lib/config`
4. `http://localhost:3000`

Step 3 degrades cleanly on a machine that is not a peer: `localPeer` is
`undefined` there, not an error. A *malformed* config is the one hard failure
and must report the validation message, not a stack trace.

### Output

`--format auto|table|json|quiet`, mirroring `hf` — the app already shells out to
it, so the vocabulary is already in the user's hands.

- `auto` (default) renders a table, dropping colour and spinners when stdout is
  not a TTY.
- It deliberately does **not** switch to JSON when piped. That silently breaks
  `tj ls | grep`. Machine-readable output is explicit: `--format json`.
- `quiet` prints one identifier per line, for `xargs`.

### Exit codes

| | |
| --- | --- |
| `0` | success |
| `1` | error (bad usage, unreachable server, malformed config) |
| `2` | reserved for "findings" |

`2` is reserved now, unused in phase 1, so phase 3's `audit` does not have to
renumber what scripts already depend on.

An unreachable **peer** is not an error: its row is marked unreachable and the
command still exits `0`. A peer being down is a fact to report, not a failure of
the command. An unreachable **server** is exit `1`, since nothing can be
answered at all.

### Commands

| Command | Does |
| --- | --- |
| `tj ls [pattern] [--local\|--cold\|--peer <slug>\|--all]` | one row per model/quant, with a WHERE column |
| `tj where <model>` | per-quant locations and sizes |
| `tj disk [--all]` | free/total per location |
| `tj peers` | configured peers, each probed for reachability |
| `tj version` | CLI and server versions |

There is no separate `cold ls`: `--cold` is a filter on `ls`. One listing
command with filters is a smaller surface than several near-identical ones.

`pattern` is a case-insensitive substring match on the model name, matching how
the UI's filter behaves.

### Data sources

`/api/v1/models-table` already returns local and cold assembled into `ModelRow[]`
(via `buildModelRows`), so `ls` and `where` need only fan out to
`/api/v1/peers/<slug>/models` per peer, in parallel — the same shape the UI uses.

The merge joins peer files to quants by `fileJoinKey` from
`lib/peers/peer-paths.ts`, which is already client-safe and tested, and is the
same join the models table and the copy workflow use. Reusing it means the CLI
cannot disagree with the UI about which peer holds what.

Per-quant location comes from `QuantInfo`: `localSize > 0` for local,
`inColdStorage` / `coldComplete` for cold, and the peer join for the rest.

| Command | Requests |
| --- | --- |
| `ls`, `where` | `/api/v1/models-table` + `/api/v1/peers/<slug>/models` per peer |
| `disk` | `/api/v1/disk-usage` + `/api/v1/peers/<slug>/disk-usage` per peer |
| `peers` | `/api/v1/peers`, then `/api/v1/peers/<slug>/version` to probe liveness |
| `version` | `/api/v1/version` |

`/api/v1/peers` returns configuration, not liveness — hence the probe.

## Testing

Pure functions under `lib/cli/` get normal bun tests: argument parsing, format
resolution (including the TTY rule), table rendering with ragged columns, the
inventory merge against fixture `ModelRow[]` and peer `Model[]`, and exit-code
selection. Fixtures use RFC 5737 documentation addresses, never real ones.

`cli/` itself is a thin shell and is covered by a live smoke run against the
isolated `:3998` server rather than unit tests.

## Documentation

`docs/cli.md`, written as a user would read it: install, discovery, each command
with real invocations and their actual output, the `--format` and exit-code
conventions, and scripting recipes that show what the whole thing is for
(piping to `jq`, driving `xargs`). Linked from `README.md`.

## Out of scope

Anything that writes. `--watch`. Shell completions.

## Open questions

- **Distribution.** A `bin` entry works for a checkout, but the peers run from
  Docker images. Whether to ship a compiled binary (`bun build --compile`) or
  install the CLI into the image is deferred until phase 1 is usable.
- **`ls` default breadth.** Whether a bare `tj ls` should show local only or
  everything it can reach. This spec assumes everything, on the grounds that the
  question being asked is usually "where is this", but it costs a fan-out on
  every invocation.
