# `tj` — Turbo Jumbo from the command line

`tj` answers the questions you'd otherwise open a browser for: what do I have,
where does it live, and what's left on the disks. It's built for two situations
the web UI is the wrong shape for — being on a machine over ssh, and being a
line in a shell script.

It's a client for a running Turbo Jumbo server, not a second implementation.
Everything it reports comes from the same code the web UI uses, so the two can't
disagree with each other.

> **Auditing and deleting aren't here yet.** `tj` reads, downloads and copies
> today; `audit` and `rm` are planned for later phases.

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

### `tj get <repo|url>`

Downloads from Hugging Face. The argument is anything the download modal
accepts: a bare `org/repo`, a repo URL, a folder URL, or a file URL.

Asked for a repo with nothing else, it prints the menu rather than guessing:

```console
$ tj get unsloth/gemma-3-270m-it-GGUF
unsloth/gemma-3-270m-it-GGUF offers these quantizations. Choose one with --quant:

QUANT       FILES       SIZE  FOLDER
UD-IQ2_XXS      1  171.8 MiB
UD-IQ2_M        1  174.3 MiB
UD-IQ3_XXS      1  176.0 MiB
Q3_K_S          1  225.7 MiB
Q2_K            1  226.1 MiB
```

Then pick one:

```console
$ tj get unsloth/gemma-3-270m-it-GGUF --quant UD-IQ2_XXS
████████████████████████ 100%  171.8 MiB / 171.8 MiB  9.7 MiB/s  4s
downloaded 1/1 files · 171.8 MiB · 4s
```

`--quant` is repeatable, and takes the same labels the web UI shows — including
sharded ones, which are fetched as a set. `--file <path>` picks individual repo
files instead. A folder URL needs neither, since it already names a
quantization:

```console
$ tj get https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF/tree/main/UD-IQ3_S
```

`--to cold` archives to cold storage after downloading, and `--delete-after`
then removes the local copy — the two checkboxes in the download modal.
`--delete-after` without `--to cold` is a usage error rather than a silent
no-op.

Downloads run **on the server this CLI points at**. To fetch onto another
machine, point at it: `tj --url http://192.0.2.11:3000 get …`.

### `tj copy <model>`

Copies files you already have between local storage, cold storage and peers.
There is no `cold push` or `cold pull` — `--from` and `--to` cover both.

```console
$ tj copy gemma-3-270m --to cold
  0%  512 KiB / 171.8 MiB
 50%  86.0 MiB / 171.8 MiB
100%  171.8 MiB / 171.8 MiB
copied 1/1 files · 171.8 MiB · 5s
```

The model argument is a substring, as everywhere else. If it matches more than
one model, `tj` lists them and stops rather than copying the wrong hundred
gigabytes:

```console
$ tj copy qwen3 --to cold
'qwen3' matches 4 models. Narrow it:
  Qwen/Qwen3-0.6B-GGUF
  unsloth/Qwen3-8B-GGUF
  …
```

`--quant` narrows to one quantization; without it every quantization the source
holds is copied. `--from local|cold|<slug>` chooses where to read from —
by default `tj` uses whichever copy is most complete, so a truncated one is
never used as the source for repairing another.

`--to` takes `cold` or a peer slug. `--delete-after` removes the source once
the copy is verified.

**Existing files at the destination are overwritten, not queried.** The web UI
can stop and ask which conflicting files to replace; a CLI with no prompts
can't. Files already there transfer almost nothing, because the copy resumes
from whatever prefix already matches — so re-running an interrupted copy is how
you resume it.

### `--dry-run`

On both commands: resolve everything, print the plan, transfer nothing.

```console
$ tj get unsloth/DeepSeek-V4-Flash-0731-GGUF --quant UD-IQ3_S --dry-run
Would download 4 file(s) from unsloth/DeepSeek-V4-Flash-0731-GGUF to local storage:

FILE                                                              SIZE
UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00001-of-00004.gguf   5.0 MiB
UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00002-of-00004.gguf  45.6 GiB
UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00003-of-00004.gguf  46.2 GiB
UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00004-of-00004.gguf  16.2 GiB

total 108.1 GiB
```

This is the safety mechanism. **Nothing in `tj` ever prompts** — a tool for cron
can't block on a terminal that isn't there, and a prompt that is skipped when
non-interactive makes the safe path the one that only happens when someone is
watching. So destructive intent is typed (`--delete-after`) and `--dry-run`
shows the plan first.

### Progress while transferring

On a terminal you get a redrawing bar. Redirected — a log file, a cron job —
you get a line when the file count advances or the percentage crosses a new
tenth, plus the summary:

```
2/4 files   47%  50.6 GiB / 108.1 GiB
3/4 files   89%  96.8 GiB / 108.1 GiB
4/4 files  100%  108.1 GiB / 108.1 GiB
copied 4/4 files · 108.1 GiB · 42m18s
```

Those lines report **counts, not filenames**. Neither the download nor the copy
stream says which file is currently in flight, and inferring it from the order
`tj` sent would sometimes be wrong. Failures are named, though — the copy stream
reports those explicitly.

`--format json` prints one result object at the end instead, and `--format
quiet` prints nothing on success.

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

**Archive anything held only on fast storage**, one model at a time:

```console
$ tj ls --local --format json \
  | jq -r '.[] | select(.locations == ["local"]) | .model' \
  | sort -u \
  | while read -r m; do tj copy "$m" --to cold || echo "failed: $m"; done
```

**Fetch a list of models** from a file, skipping ones already present:

```console
$ while read -r repo quant; do
    tj get "$repo" --quant "$quant" || echo "failed: $repo $quant"
  done < models.txt
```

**See what a whole download would cost before starting it:**

```console
$ tj get unsloth/DeepSeek-V4-Flash-0731-GGUF --quant UD-Q4_K_XL --dry-run \
    --format json | jq '.totalBytes'
```

## What isn't here yet

- **Phase 3** — `audit`, `audit --fix`, where exit code `2` starts being used.
- **Phase 4** — `lemonade ls/sync`, `rm`.

The designs are written up in
[phase 1](specs/2026-08-08-tj-cli-phase-1-design.md) (conventions and the read
commands) and [phase 2](specs/2026-08-08-tj-cli-phase-2-design.md) (transfers).
