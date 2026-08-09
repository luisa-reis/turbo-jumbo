# `tj` — Turbo Jumbo from the command line

`tj` answers the questions you'd otherwise open a browser for: what do I have,
where does it live, and what's left on the disks. It's built for two situations
the web UI is the wrong shape for — being on a machine over ssh, and being a
line in a shell script.

It's a client for a running Turbo Jumbo server, not a second implementation.
Everything it reports comes from the same code the web UI uses, so the two can't
disagree with each other.

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

`--exact` says the files you named are the whole model, rather than part of a
bigger repo. Some repos hold a model alongside things that aren't part of it —
a FastFlowLM registry entry pins a handful of files in a repo that also carries
NPU kernels for other targets — and without this, everything else in the repo
counts against the model as missing:

```console
$ tj get https://huggingface.co/FastFlowLM/Qwen3-4B/tree/v1.2 \
    --file config.json --file model.q4nx --exact
```

The set is recorded with the model, so later audits and completeness checks
judge it against those files alone. It needs `--file`: a quantization is
already a complete unit, and a bare repo is the whole repo, so neither leaves
a scope anything to say.

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

### `tj audit <model>` / `tj audit --all`

Verifies files against Hugging Face — sizes, checksums, whether anything is
misplaced, duplicated or incomplete — and reports what doesn't match.

```console
$ tj audit gemma-3-270m
████████████████████████ 100%  171.8 MiB / 171.8 MiB  43.0 MiB/s  4s
1 file(s) checked · 0 finding(s)
```

**A fresh audit reads every byte of every file it checks.** That is the point —
it is how bit-rot gets caught — but on an archive it is hours of disk, so a bare
`tj audit` with neither a model name nor `--all` is refused rather than
quietly starting one.

`--cached` answers instantly instead, from what the last real audit recorded in
the sidecars. No hashing, no network. It reports history rather than truth: a
file corrupted since the last fresh run still reads `pass`.

```console
$ tj audit --all --cached
34 file(s) checked · 0 finding(s)
```

`--cold` audits cold storage and `--peer <slug>` audits a peer, instead of this
machine's fast storage. `--dry-run` lists what would be hashed, and how much.

When something is wrong, it says what and exits `2`:

```console
$ tj audit --all
FILE                             STATUS     ACTION  DETAIL
gemma-3-270m-it-UD-IQ2_XXS.gguf  misplaced          expected path unsloth/gemma-3-270m-it-GGUF/gemma-3-270m-it-UD-IQ2_XXS.gguf

1 file(s) checked · 1 finding(s)
```

#### Repairing

`--fix` relocates misplaced files into the layout the rest of Turbo Jumbo
expects. That repair loses nothing, so it needs no further permission:

```console
$ tj audit --all --fix
FILE                             STATUS     ACTION                          DETAIL
gemma-3-270m-it-UD-IQ2_XXS.gguf  misplaced  moved to unsloth/gemma-3-…gguf  expected path …

1 file(s) checked · 1 finding(s) · 1 fixed · 0 remaining
```

Note the exit code there is **0**, not 2: everything found was repaired, so
`tj audit --fix || alert` doesn't page anyone about a problem that no longer
exists. Findings that remain — because a repair failed, or because none exists —
still exit 2.

Resolving **duplicates** deletes copies, keeping one verified survivor. Since
nothing here prompts, that needs its own explicit permission:

```console
$ tj audit big-model --fix --allow-delete
```

Without `--allow-delete`, duplicates are reported and left alone, with a note
saying so. Findings with no automatic repair — a checksum mismatch, a file whose
source can't be determined — are named and left for the web UI, which can ask
you the questions a CLI can't.

### `tj rm <model> --from <where> --yes`

Deletes a model's files from one storage tier. This is the only irreversible
command here, so **both halves of the intent have to be typed**:

```console
$ tj rm gemma-3-270m
tj rm needs --from local|cold|<peer>: which copy should go?
Try --dry-run first to see what would be deleted.

$ tj rm gemma-3-270m --from local
tj rm needs --yes to confirm, since it deletes files.
Try --dry-run first to see what would go.
```

`--from` has no default on purpose. A defaulted tier is exactly how someone
removes the archived copy while meaning the local one — the mistake you cannot
undo. `--yes` matches the convention the `hf` CLI uses for its destructive
commands.

`--dry-run` lists what would go and touches nothing:

```console
$ tj rm gemma-3-270m --from local --dry-run
Would delete 1 file(s) of unsloth/gemma-3-270m-it-GGUF from local:

FILE                                                            SIZE
unsloth/gemma-3-270m-it-GGUF/gemma-3-270m-it-UD-IQ2_XXS.gguf  171.8 MiB

total 171.8 MiB

$ tj rm gemma-3-270m --from local --yes
deleted 1 file(s) of unsloth/gemma-3-270m-it-GGUF from local · 171.8 MiB
```

An ambiguous pattern is refused rather than resolved:

```console
$ tj rm qwen --from cold --yes
'qwen' matches 10 models. Narrow it:
  Qwen/Qwen3.5-0.8B
  unsloth/Qwen3-8B-GGUF
  …
```

`--quant` narrows to particular quantizations; without it, every file of the
model on that tier goes.

### `tj lemonade ls` / `tj lemonade sync`

Lemonade keeps its own on-disk cache of models it has pulled, separate from the
storage Turbo Jumbo manages.

`tj lemonade ls` shows the catalog, marked with what this machine already holds:

```console
$ tj lemonade ls qwen3.6
NAME                      REPO                              VARIANT                           SIZE  WHERE
Qwen3.6-35B-A3B-GGUF      unsloth/Qwen3.6-35B-A3B-GGUF      Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf  21.3 GiB
Qwen3.6-35B-A3B-MTP-GGUF  unsloth/Qwen3.6-35B-A3B-MTP-GGUF  Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf  21.3 GiB  lemonade, local
```

An optional second word filters by name or repo. `WHERE` reads `lemonade` for
Lemonade's own cache and `local` for Turbo Jumbo's fast storage. It lists the
catalog's models; omni collections and their components aren't shown.

`tj lemonade sync` reconciles the two: it moves Lemonade-only files into Turbo
Jumbo, deletes Lemonade copies of files Turbo Jumbo already has, mirrors the
rest back as symlinks, and clears dangling ones. Two of those four **delete**,
so it needs `--yes` — and `--dry-run` shows the whole plan first:

```console
$ tj lemonade sync --dry-run
REPO                        MOVE  DEDUP  LINK  STALE  NOTE
unsloth/Qwen3.6-35B-A3B…       0      2     1      0

would move 0, deduplicate 2, link 1, remove 0 stale link(s)
deduplicating and removing stale links deletes files from Lemonade's cache
```

`--peer <slug>` syncs on that peer instead of this machine.

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
| `2` | The audit ran and found something still wrong                     |

The distinction between `1` and `2` is the useful one for a monitoring job:
`2` means "I checked, and it is bad", while `1` means "I could not check at
all". Treating them the same would let an unreachable server look exactly like
a clean archive.

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

**Nightly integrity check, for cron** — mails you only when something is wrong,
and tells apart "found a problem" from "couldn't check":

```console
0 3 * * *  tj audit --all --cold; case $? in \
             2) mail -s "tj: audit findings" me@example.com ;; \
             1) mail -s "tj: audit could not run" me@example.com ;; \
           esac
```

**Repair what can be repaired, report the rest:**

```console
$ tj audit --all --fix || echo "findings remain — see above"
```

**Which models have never been audited** (no recorded verdict at all):

```console
$ comm -13 \
    <(tj audit --all --cached --format json | jq -r '.findings[].file' | sort) \
    <(tj ls --local --format quiet | sort)
```

**See what a whole download would cost before starting it:**

```console
$ tj get unsloth/DeepSeek-V4-Flash-0731-GGUF --quant UD-Q4_K_XL --dry-run \
    --format json | jq '.totalBytes'
```

## How the safety flags fit together

Three different flags gate three different risks, and the distinction is
deliberate:

|                  |                                                                    |
| ---------------- | ------------------------------------------------------------------ |
| `--dry-run`      | On every command that changes anything: show the plan, do nothing  |
| `--delete-after` | An _option_ on a transfer: also remove the source afterwards       |
| `--allow-delete` | Widens `audit --fix` to a repair that deletes (duplicates)         |
| `--yes`          | Confirms a command whose **job** is removal: `rm`, `lemonade sync` |

Nothing prompts, anywhere. A tool meant for cron can't block on a terminal that
isn't there, and a prompt that gets skipped when non-interactive makes the safe
path the one that only happens when somebody is watching.

## The design docs

- [Phase 1](specs/2026-08-08-tj-cli-phase-1-design.md) — conventions and the
  read commands.
- [Phase 2](specs/2026-08-08-tj-cli-phase-2-design.md) — transfers.
- [Phase 3](specs/2026-08-08-tj-cli-phase-3-design.md) — audit.
- [Phase 4](specs/2026-08-08-tj-cli-phase-4-design.md) — removal and Lemonade.
