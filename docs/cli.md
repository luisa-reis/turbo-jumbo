# `tj` — Turbo Jumbo from the command line

`tj` answers the questions you'd otherwise open a browser for: what do I have,
where does it live, and what's left on the disks. It's built for two situations
the web UI is the wrong shape for — being on a machine over ssh, and being a
line in a shell script.

It's a client for a running Turbo Jumbo server, not a second implementation.
Everything it reports comes from the same code the web UI uses, so the two can't
disagree with each other.

> **Read-only, for now.** This is phase one. Downloading, copying, auditing and
> deleting are planned for later phases; today `tj` only reads.

## Running it

From a checkout:

```console
$ bun run cli/index.ts ls
```

Or link it once and use the short name everywhere:

```console
$ bun link
$ tj ls
```

The examples below use `tj`.

## Finding the server

`tj` looks for the server in this order, taking the first that's set:

|                         |                                              |
| ----------------------- | -------------------------------------------- |
| `--url <url>`           | An explicit override, for one command        |
| `TJ_URL`                | Environment, for a shell session or a script |
| `config.yaml`           | The address of the peer that is this machine |
| `http://localhost:3000` | The fallback                                 |

So on a peer, `tj` needs no configuration at all. From a laptop that isn't a
peer, point it at one:

```console
$ export TJ_URL=http://192.0.2.11:3000
$ tj ls
```

A bare `host:port` works too — that's the form `config.yaml` uses — and gets an
`http://` scheme added.

## Commands

### `tj ls [pattern]`

Every model and quantization, and everywhere each one is held.

```console
$ tj ls
MODEL                                QUANT                       SIZE  WHERE
ggml-org/gemma-3-4b-it-GGUF          Q4_K_M                   2.3 GiB  cold, rio
ggml-org/gemma-3-4b-it-GGUF          mmproj-model-f16.gguf  811.0 MiB  cold
Qwen/Qwen3-0.6B-GGUF                 Q8_0                   645.1 MiB  local
unsloth/DeepSeek-V4-Flash-0731-GGUF  UD-Q4_K_XL             144.4 GiB  cold, rio
unsloth/DeepSeek-V4-Flash-0731-GGUF  UD-IQ3_S               108.1 GiB  local, cold(partial)
```

`WHERE` reads `local` for this machine's fast storage, `cold` for cold storage,
and a peer's slug for a peer. `cold(partial)` means a cold copy exists but is
smaller than the source — an interrupted transfer, not something you can restore
from.

The optional pattern is a case-insensitive substring of the model name, the same
matching the web UI's filter does:

```console
$ tj ls qwen
```

Filters narrow it further, and can be combined with a pattern:

```console
$ tj ls --local             # only what this machine holds on fast storage
$ tj ls --cold              # only what's archived
$ tj ls --peer rio          # only what that peer holds
```

### `tj where <model>`

One model's quantizations and where each lives — for when you know you have
something and want to know which disk it's on.

```console
$ tj where deepseek
QUANT            SIZE  WHERE
UD-Q4_K_XL  144.4 GiB  cold, rio
UD-IQ3_S    108.1 GiB  local, cold(partial)
```

The argument is a substring, so it doesn't need to be exact. If it matches more
than one model, a `MODEL` column appears so you can tell them apart. If it
matches nothing, `tj` says so and exits `1`.

### `tj disk [--all]`

Free and total space on the filesystems holding models. `--all` includes every
peer.

```console
$ tj disk --all
LOCATION  TIER           FREE      TOTAL  USED%
local     models    107.1 GiB  392.7 GiB    73%
local     cold       11.1 TiB   14.0 TiB    20%
rio       models    146.1 GiB  392.7 GiB    63%
lima      —       unreachable
```

Models and cold storage are listed separately, except when they share a
filesystem — then a single `models+cold` row, because their free space is one
pool and listing it twice would imply twice the headroom you have.

### `tj peers`

The configured peers, each probed to see whether it answers.

```console
$ tj peers
SLUG  NAME  ADDRESS          STATUS             VERSION
oslo  Oslo  192.0.2.10:3000  up (this machine)  0.1.0
rio   Rio   192.0.2.11:3000  up                 0.1.0
lima  Lima  192.0.2.12:3000  unreachable
```

A peer being down is reported, not raised: the command still exits `0`, because
"that machine is off" is an answer.

Note the consequence for `tj ls`: an unreachable peer is _skipped_, never listed
as not having something. "I couldn't ask" and "it isn't there" are different
answers, and only `tj peers` is in a position to tell them apart.

### `tj version`

```console
$ tj version
COMPONENT  VERSION
server     0.1.0 (dev)
commit     38c4fea5f
url        http://192.0.2.10:3000
```

The URL is part of the answer on purpose — the commonest confusion with a client
tool is being pointed at a different machine than you assumed.

## Output formats

`--format` takes `auto` (the default), `table`, `json` or `quiet`.

**Piping does not change the format.** `auto` and `table` are the same thing;
what the terminal decides is only decoration, so colour is dropped when output
isn't a terminal and redirected output holds no escape codes. This keeps
`tj ls | grep` working. When a script needs to read the output, say so:

```console
$ tj ls --format json
[
  {
    "model": "unsloth/DeepSeek-V4-Flash-0731-GGUF",
    "quant": "UD-IQ3_S",
    "size": 116069339712,
    "locations": ["local", "cold"],
    "coldIncomplete": true
  }
]
```

`quiet` prints one identifier per line, for `xargs`:

```console
$ tj ls --cold --format quiet
ggml-org/gemma-3-4b-it-GGUF
unsloth/DeepSeek-V4-Flash-0731-GGUF
```

## Exit codes

|     |                                                                   |
| --- | ----------------------------------------------------------------- |
| `0` | Success                                                           |
| `1` | Error — bad usage, unreachable server, malformed config, no match |
| `2` | Reserved for findings (used by `tj audit`, a later phase)         |

`2` is reserved now so that scripts written against `tj audit` later don't have
to be revised when it arrives.

## Recipes

**Models held in only one place** — the ones with no second copy:

```console
$ tj ls --format json \
  | jq -r '.[] | select(.locations | length == 1) | "\(.model)\t\(.quant)\t\(.locations[0])"'
```

**Cold copies that are incomplete**, which won't restore:

```console
$ tj ls --format json | jq -r '.[] | select(.coldIncomplete) | .model'
```

**What a peer has that this machine doesn't** — by quantization, since a model
can be half-mirrored:

```console
$ tj ls --peer rio --format json \
  | jq -r '.[] | select(.locations | index("local") | not) | "\(.model)\t\(.quant)"'
```

**Total bytes archived:**

```console
$ tj ls --cold --format json | jq '[.[].size] | add'
```

**Alert when a disk passes 90% used:**

```console
$ tj disk --all --format json \
  | jq -e 'all(.[]; .total == 0 or (.total - .free) / .total < 0.9)' \
  || echo "a Turbo Jumbo filesystem is over 90% full"
```

**Check every peer is up, for a monitoring job:**

```console
$ tj peers --format json | jq -e 'all(.[]; .reachable)'
```

## What isn't here yet

Phase one is deliberately read-only, so that the conventions above — output,
exit codes, server discovery — settle before any command can change anything.
Planned next:

- **Phase 2** — `get`, `copy`, `cold push/pull`: the streaming transfers.
- **Phase 3** — `audit`, `audit --fix`, where exit code `2` starts being used.
- **Phase 4** — `lemonade ls/sync`, `rm`.

The design is written up in
[`docs/specs/2026-08-08-tj-cli-phase-1-design.md`](specs/2026-08-08-tj-cli-phase-1-design.md).
