# `tj` — Turbo Jumbo from the command line

`tj` answers the questions you'd otherwise open a browser for: what do I have,
where does it live, and what's left on the disks. It's built for two situations
the web UI is the wrong shape for — being on a machine over ssh, and being a
line in a shell script.

It's a client for a running Turbo Jumbo server, not a second implementation.
Everything it reports comes from the same code the web UI uses, so the two can't
disagree with each other.

## Running it

On a machine without a checkout — a laptop, say — download the standalone
binary for its platform from the Turbo Jumbo server you'll point it at. It
carries its own runtime, so nothing else needs installing, and it is built from
exactly the commit that server runs. The web app's **Command-line tool** page
(the terminal icon in the top bar, or `/cli`) gives these steps with that
server's address already filled in:

```console
$ curl -fLo ~/bin/tj http://192.0.2.10:3000/api/v1/cli/tj-darwin-arm64
$ chmod +x ~/bin/tj
$ export TJ_URL=http://192.0.2.10:3000
```

For now there is one build, `tj-darwin-arm64` (macOS on Apple silicon), plus a
`SHA256SUMS` to check it against; `/api/v1/cli` lists what a server has. Every
deploy builds it in (`bin/deploy.sh` and the container image both run
`bin/build-cli.sh`), and each release also carries it on its Forgejo release
page, under `releases/download/v<version>/`. `bin/build-cli.sh` can also build
`darwin-x64`, `linux-x64`, `linux-arm64` and `windows-x64` on request; adding
one to its `DEFAULT_TARGETS` ships it everywhere.

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

## Getting help

Three depths, so you get the one you asked for:

|                         |                                            |
| ----------------------- | ------------------------------------------ |
| `tj -h`, or a bare `tj` | The summary — every command on one screen  |
| `tj --help`, `tj help`  | The same ground with the reasons filled in |
| `tj <command> --help`   | One command alone, with only its own flags |
| `tj help <command>`     | The same thing, asked the other way        |
| `tj --help-all`         | Every command's help at once, for grepping |

Typing the bare name is how you find out what the tool is, so it answers with
the screenful rather than the manual.

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

**Files already at the destination are left alone; ones that differ are
overwritten, not queried.** Before sending anything, `tj copy` asks the server
what the destination already holds and skips every file that is byte-identical
to the source — the same comparison, and the same default, as the web UI's
conflict dialog. The UI can then stop and ask which of the differing files to
replace; a CLI with no prompts can't, so it replaces them.

The comparison is answered entirely from the SHA256s recorded when each file
was downloaded, so it reads no file bytes at all — `tj copy` reads a file only
in order to copy it. A pair neither side can vouch for is therefore left
undecided and copied, rather than read twice to find out it needn't be. (The
web UI does fall back to comparing checksums there, because someone asked it
to and is watching it happen.)

Re-running an interrupted copy is therefore how you resume it: the files that
completed are skipped outright, and a file cut off partway is copied again —
from the start when the destination is a peer, from the matching prefix when
it is cold storage or this machine.

`--delete-after` turns skipping off. It removes a source only once this run has
put that file into cold storage, so a skipped file would keep its source
forever; the copy resumes and rewrites nothing when the archive already
matches, so little is lost.

### `-n`, `--dry-run`

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

This is the safety mechanism. **Nothing blocks on a terminal that isn't there**
— a tool for cron can't, and a prompt that is skipped when non-interactive makes
the safe path the one that only happens when someone is watching. So destructive
intent is typed (`--delete-after`) and `--dry-run` shows the plan first. The two
commands whose whole job is deletion do ask when a person is present, and still
insist on `--yes` when one isn't (see [the safety flags](#how-the-safety-flags-fit-together)).

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

`--output-format json` prints one result object at the end instead, and
`--output-format lines` prints nothing on success.

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

When something is wrong, it says what and exits `3`:

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

Note the exit code there is **0**, not 3: everything found was repaired, so
`tj audit --fix || alert` doesn't page anyone about a problem that no longer
exists. Findings that remain — because a repair failed, or because none exists —
still exit 3.

Resolving **duplicates** deletes copies, keeping one verified survivor. Since
the audit asks nothing even at a terminal, that needs its own explicit
permission:

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

### `tj lemonade ls` / `tj lemonade get` / `tj lemonade sync`

Lemonade keeps its own on-disk cache of models it has pulled, separate from the
storage Turbo Jumbo manages.

`tj lemonade ls` shows the catalog, marked with what this machine already holds:

```console
$ tj lemonade ls qwen3.6-27b
NAME                          REPO                      VARIANT                      RECIPE        SIZE  WHERE
Qwen3.6-27B-GGUF              unsloth/Qwen3.6-27B-GGUF  Qwen3.6-27B-UD-Q4_K_XL.gguf  llamacpp  16.0 GiB  lemonade, local
Qwen3.6-27B-FP16-vLLM         Qwen/Qwen3.6-27B          (whole repo)                 vllm      54.0 GiB
Qwen3.6-27B-FP8-vLLM-lowconc  Qwen/Qwen3.6-27B-FP8      (whole repo)                 vllm      28.0 GiB
Qwen3.6-27B-FLM               FastFlowLM/Qwen3.6-27B    qwen3.6:27b                  flm       19.8 GiB  lemonade
```

An optional second word filters by name or repo. `WHERE` reads `lemonade` for
Lemonade's own side and `local` for Turbo Jumbo's fast storage — `local
(partial)` when only some of the model's files are there, because half a model
is not having it. Omni collections aren't listed: they are bundles of these
entries rather than a download of their own, and their members appear here
individually.

`RECIPE` separates three kinds of entry that come from different places.
`llamacpp` rows are the catalog's GGUF models. `vllm`, `oga-*`, `sd-cpp` and
the rest are its other standalone models, which pin whole repos rather than a
quantization — a `VARIANT` of `(whole repo)` — and can name more than one, in
which case `REPO` lists them all. `flm` rows are FastFlowLM's NPU models, which
never appear in the catalog at all: a Lemonade server discovers them from its
local `flm` binary, so they are read live from one server (`--peer <slug>`, or
this machine). A server that isn't configured for FLM, or isn't answering,
simply contributes no `flm` rows.

`tj lemonade get <model>` downloads any of them into Turbo Jumbo storage,
taking the name as `ls` prints it (a substring is enough; an ambiguous one is
listed rather than guessed at):

```console
$ tj lemonade get Qwen3.6-35B-A3B-FLM
████████████████████████ 100%  19.8 GiB / 19.8 GiB  47 MiB/s  7m9s
downloaded 3/3 files · 19.8 GiB · 7m9s
```

For an `flm` row this fetches from the Hugging Face repo FastFlowLM's registry
pins for that tag, at the pinned revision, and records the registry's file list
as the model's complete set — the repo also carries NPU kernels for other
targets, which aren't part of it. It is the `--exact` of `tj get`, applied for
you. A tag the registry doesn't name has no Hugging Face source, and the
command says so rather than guessing: the web UI's fallback there is to have
the Lemonade server pull into its own FLM store, which is a different place
than Turbo Jumbo storage.

A model whose checkpoints span several repos — an image pipeline's UNet and
VAE — is fetched one repo at a time, in the order the catalog names them, and
a repo already held in full is skipped rather than re-requested:

```console
$ tj lemonade get Flux-pipeline --dry-run
Would download 2 file(s) for Flux-pipeline to local storage:

org/flux-unet
FILE                  SIZE
unet.safetensors  18.6 GiB

org/flux-vae
FILE                SIZE
vae.safetensors  3.7 GiB

total 22.4 GiB
```

A failed repo **stops** the run rather than continuing to the next: half a
multi-repo model can't be loaded, so fetching the rest of it would be worse
than fetching none. The same goes for a checkpoint that resolves to no file at
all, which means the catalog and the repo have drifted apart — that fails
before anything is transferred.

`--to cold`, `--delete-after` and `--dry-run` work as they do on `tj get`.

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

Lemonade's storage is split by what reads each part:

|                      |                          |                                                                                |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `<lemonade>/builtin` | its Hugging Face cache   | models Lemonade lists itself — its catalog, plus the FastFlowLM tags it serves |
| `<lemonade>/extra`   | its `--extra-models-dir` | everything else Turbo Jumbo holds locally                                      |
| `<lemonade>/flm`     | FastFlowLM's own store   | what its `flm` binary pulls for the FLM (NPU) models — see below               |

Sync sorts cache entries onto the right side on each run, so a model the
catalog picks up later moves across by itself, and the dry-run shows those
moves before any happen.

`flm` is not a cache either: it is where the Lemonade server's `flm` binary
keeps the NPU models it pulls itself, which by default would be
`~/.config/flm/models` on that server — off the shared disk and out of sight.
Point it here by setting `FLM_MODEL_PATH=<lemonade>/flm` in the Lemonade
server's environment (both `flm` and Lemonade append `/models` to it, so the
weights land in `<lemonade>/flm/models/<repo>/`). With that in place, sync
offers flm the FLM models Turbo Jumbo holds locally — the ones downloaded from
the Hugging Face repo FastFlowLM's registry pins for a tag — as one symlink
per model directory under the name flm resolves, which is all it takes for
Lemonade to count the model as downloaded. Lemonade only rebuilds its model
list on its own actions, so after linking, sync asks it for a no-op pull of one
linked model — flm finds the files in place and fetches nothing — which makes
it re-read the store; without a `lemonade_url` for this peer, the links show
up after Lemonade's next restart instead. A model missing a file the registry
names is listed as incomplete rather than linked; links for models no longer
held are cleared away; directories flm pulled itself are never touched.

`extra` is not a cache. Lemonade scans it recursively for `.gguf` files and
names each model after the directory holding them, so sync gives every model a
directory named for its repo and fills it with symlinks — Lemonade then lists
`extra.DeepSeek-V4-Flash-0731-GGUF`. Only GGUF models go there; it loads
nothing else from that directory. Links for a model that is no longer held
locally, or that the catalog has since picked up, are cleared away, and a
directory containing a real file is left alone — that one is yours.

**Both paths have to be set on the Lemonade side**: `<lemonade>/builtin` as its
cache root (its models live a level deeper than they used to), and
`--extra-models-dir <lemonade>/extra`.

### `tj version`

```console
$ tj version
COMPONENT  VERSION
server     0.1.0 (dev)
commit     38c4fea5f
cli        0.1.0 (dev)
url        http://192.0.2.10:3000
```

The URL is part of the answer on purpose — the commonest confusion with a client
tool is being pointed at a different machine than you assumed. Both versions
are listed for the same reason: a client and a server that have drifted apart
is exactly when you want to see the two side by side.

For this CLI alone, `--version` answers without reaching for a server at all —
which is when you most want to know which `tj` you are running:

```console
$ tj --version
tj 0.1.0 (dev)

$ tj --version -v
tj 0.1.0 (dev)
  commit   38c4fea5f
  bun      1.3.9
  platform linux-x64
```

Build detail rides the verbosity dial rather than a second flag. A standalone
binary reports the commit it was built from, wherever you run it; only one built
from a release drops the `(dev)`.

## Output formats

`--output-format` takes `table` (the default), `json`, `csv`, `toon` or
`lines`. There is no `auto`: nothing switches on its own, so a value that
always resolved to the default would be a value that did nothing.

**Piping does not change the format.** What the terminal decides is only
decoration, so colour is dropped when output isn't a terminal, never appears
in a machine format at all, and redirected output holds no escape codes. This
keeps `tj ls | grep` working. When a script needs to read the output, say so:

`--color` takes `auto` (the default), `always` or `never`, and `NO_COLOR` in
the environment turns colour off the way it does everywhere else. An explicit
`--color always` overrides `NO_COLOR` — a flag typed on the spot outranks the
environment it was typed in — but it cannot colour a machine format, so a
wrapper that forces colour on can't corrupt a payload someone is parsing.

```console
$ tj ls --output-format json
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

`lines` prints one identifier per line, for `xargs`:

```console
$ tj ls --cold --output-format lines
ggml-org/gemma-3-4b-it-GGUF
unsloth/DeepSeek-V4-Flash-0731-GGUF
```

`csv` and `toon` carry the same fields as `json`, not the table's columns: a
table drops fields to stay readable in eighty columns, and neither a
spreadsheet nor a model context has that problem.

```console
$ tj ls --cold --output-format csv
model,quant,size,locations,coldIncomplete
unsloth/DeepSeek-V4-Flash-0731-GGUF,UD-IQ3_S,116069339712,local; cold,true
```

`toon` is [TOON](https://toonformat.dev), which says the same thing as JSON in
noticeably fewer tokens — worth having when the output is going into a prompt
rather than a parser.

An answer that is a single record rather than a list — `tj version`, or the
summary a transfer ends with — becomes a one-row CSV, header included. Should
a command ever answer with something that is neither, it says so and exits `2`
rather than inventing a shape for it.

## Saying more, or less

Verbosity is one dial, not two flags: `--silent`, then the default, then `-v`,
`-vv`, `-vvv`. `-v` says what is being done, `-vv` adds each request and how
long it took, `-vvv` adds the response bodies. Extra `v`s clamp at three
rather than complaining.

```console
$ tj ls -vv 2>&1 >/dev/null
debug1: command ls
debug1: server http://192.0.2.11:3000
debug2: GET http://192.0.2.11:3000/api/v1/models-table
debug2:   200 OK in 12ms
```

Every line is tagged with the level that produced it, so `2>&1 | grep debug1`
is a way to read them, and **all of it goes to stderr**. Turning the noise up
never changes what a script reads:

```console
$ diff <(tj ls --output-format json) <(tj ls -vvv --output-format json)
$
```

`--silent` is the other end of the same dial: errors only, and no progress
bar. `--quiet` is accepted too, since that is what every other tool calls it,
though `--silent` is the spelling documented here. Asking for `--silent` and
`-v` together is a usage error rather than a guess — you cannot stand at two
points on one dial, and in practice it means a wrapper and its caller are each
appending a flag without knowing about the other.

## Exit codes

|     |                                                        |
| --- | ------------------------------------------------------ |
| `0` | Success                                                |
| `1` | Error — unreachable server, malformed config, no match |
| `2` | Bad usage — an unknown flag, a missing argument        |
| `3` | The audit ran and found something still wrong          |

The distinction between `1` and `3` is the useful one for a monitoring job:
`3` means "I checked, and it is bad", while `1` means "I could not check at
all". Treating them the same would let an unreachable server look exactly like
a clean archive.

`2` is kept for bad usage alone, because that is what every other command-line
tool means by it — a script that reads `2` as "you typed it wrong" should not
be told a clean archive is a syntax error.

## Recipes

**Models held in only one place** — the ones with no second copy:

```console
$ tj ls --output-format json \
  | jq -r '.[] | select(.locations | length == 1) | "\(.model)\t\(.quant)\t\(.locations[0])"'
```

**Cold copies that are incomplete**, which won't restore:

```console
$ tj ls --output-format json | jq -r '.[] | select(.coldIncomplete) | .model'
```

**What a peer has that this machine doesn't** — by quantization, since a model
can be half-mirrored:

```console
$ tj ls --peer rio --output-format json \
  | jq -r '.[] | select(.locations | index("local") | not) | "\(.model)\t\(.quant)"'
```

**Total bytes archived:**

```console
$ tj ls --cold --output-format json | jq '[.[].size] | add'
```

**Alert when a disk passes 90% used:**

```console
$ tj disk --all --output-format json \
  | jq -e 'all(.[]; .total == 0 or (.total - .free) / .total < 0.9)' \
  || echo "a Turbo Jumbo filesystem is over 90% full"
```

**Check every peer is up, for a monitoring job:**

```console
$ tj peers --output-format json | jq -e 'all(.[]; .reachable)'
```

**Archive anything held only on fast storage**, one model at a time:

```console
$ tj ls --local --output-format json \
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
    <(tj audit --all --cached --output-format json | jq -r '.findings[].file' | sort) \
    <(tj ls --local --output-format lines | sort)
```

**See what a whole download would cost before starting it:**

```console
$ tj get unsloth/DeepSeek-V4-Flash-0731-GGUF --quant UD-Q4_K_XL --dry-run \
    --output-format json | jq '.totalBytes'
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

`rm` and `lemonade sync` ask before they delete, naming what is about to go:

```console
$ tj rm Qwen/Qwen3.6-27B --from cold
This deletes 15 file(s) of Qwen/Qwen3.6-27B from cold storage · 51.7 GiB.
Type "yes" to continue: no
Cancelled.
```

Only the whole word will do — `y`, a bare Enter, or a closed input are all
refusals, so leaning on the keyboard deletes nothing.

**The question is only ever asked of a terminal.** With no one at the keyboard
— under cron, or with input redirected — nothing is asked and `--yes` is
required exactly as before, because a prompt that answers itself when nobody is
watching makes the safe path the one that only happens when somebody is. `--yes`
skips the question, which is what a script should use.

Whether to ask is judged by **stdin**, not stdout, so `tj rm … --output-format json |
jq` can still ask; the question and what you type go to stderr, leaving stdout
carrying the result and nothing else.

## The design docs

- [Phase 1](specs/2026-08-08-tj-cli-phase-1-design.md) — conventions and the
  read commands.
- [Phase 2](specs/2026-08-08-tj-cli-phase-2-design.md) — transfers.
- [Phase 3](specs/2026-08-08-tj-cli-phase-3-design.md) — audit.
- [Phase 4](specs/2026-08-08-tj-cli-phase-4-design.md) — removal and Lemonade.
