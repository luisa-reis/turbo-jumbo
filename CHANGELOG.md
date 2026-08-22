# Changelog

All notable changes to Turbo Jumbo, written for humans. New entries go under
**Unreleased** in the same change that introduces them; a release stamps that
section with a version and date (`bin/release.sh`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **The Lemonade catalog now explains a partially-downloaded model file by
  file.** Multi-checkpoint entries — an image model needing its weights, a
  text encoder and a VAE from three different repos — used to show one
  "partial" badge with no way to see which file was the gap. Hovering the
  badge now lists every checkpoint with its own state: downloaded, in
  Lemonade's cache, sitting in cold storage, on another peer, or not
  downloaded anywhere. A checkpoint that exists only in cold storage gets a
  "Copy from cold storage" button right there, so completing the model no
  longer means re-downloading a file you already have. The yellow cache badge
  also dims when Lemonade's cache holds only part of the entry — Lemonade
  won't list the model until every checkpoint is cached.

- **The models table flags files other Lemonade models depend on.** A file
  that a multi-checkpoint catalog entry lists as one of its checkpoints — a
  text encoder living in a different repo than the image model that needs
  it — now carries a "dependency" badge on its row, in the local and
  cold-storage views alike. The hovercard names the models that break if the
  file is deleted or archived.

- **`tj`, a companion command-line tool.** It answers the questions you would
  otherwise open a browser for, and it fits in a shell script: `tj ls` shows
  every model and quantization and where each one is held, `tj where` locates
  one, `tj disk --all` reports free space here and on every peer, and
  `tj peers` says which machines are answering. `tj get` downloads from Hugging
  Face — naming a repo alone lists its quantizations rather than guessing —
  and `tj copy` moves models between fast storage, cold storage and peers,
  leaving alone any file the destination already has an identical copy of —
  so re-running an interrupted copy sends what is missing rather than the
  whole model again. It decides that from the checksums recorded at download
  time and never reads a file it isn't going to send: one it can't settle for
  free is simply copied.

  `tj audit` verifies files against Hugging Face and reports what doesn't
  match, exiting `3` when it finds something and `1` when it couldn't check at
  all — so a monitoring job can tell a corrupted archive from an unreachable
  one. (`2` is reserved for a mistyped command, the way every other tool
  spells it.) `--fix` puts misplaced files back where they belong; resolving
  duplicates deletes copies, so that needs `--allow-delete` spelled out. A run
  that repairs everything it found exits `0`, because nothing is wrong any
  more.

  `tj rm` deletes a model from one tier, and asks you to mean it: `--from` has
  no default, because a defaulted tier is how you delete the archived copy
  while meaning the local one, and `--yes` has to be typed on top. The Lemonade
  catalog can be browsed with what you already hold marked on it, downloaded
  from with `tj lemonade get`, and its cache reconciled with Turbo Jumbo's
  storage.

  That listing covers the whole catalog, not just its GGUF models: the vLLM,
  ONNX, image, speech and TTS entries are there too, with a `RECIPE` column
  telling them apart and `WHERE` saying `local (partial)` when only some of a
  model's files are present. One that spans several repos — an image pipeline's
  UNet and VAE — downloads a repo at a time, skipping any already held in full,
  and stops rather than continuing past a failure, because half such a model
  can't be loaded.

  It also reaches past the static catalog to FastFlowLM's NPU models, which
  only exist inside a running Lemonade server — it discovers them from its
  local `flm` binary, so they appear in no catalog file. `tj lemonade get`
  downloads one from the Hugging Face repo FastFlowLM's registry pins for its
  tag, at the pinned revision, recording that file list as the model's complete
  set: the repo also carries NPU kernels for other targets, which would
  otherwise be counted against it as missing forever.

  The two commands whose job is deletion — `tj rm` and `tj lemonade sync` —
  ask before they act, naming what is about to go ("This deletes 15 file(s) of
  Qwen/Qwen3.6-27B from cold storage · 51.7 GiB") and waiting for the word
  `yes`. Nothing shorter counts: `y` and a bare Enter are both refusals. The
  question is only ever put to a terminal, so an unattended run is never
  waiting on an answer nobody is there to give — with input redirected the
  command refuses and asks for `--yes` instead, which is what a script should
  pass. Whether to ask is judged by the input, not the output, so
  `tj rm … --output-format json | jq` can still ask; the question goes to
  stderr and leaves the result on stdout untouched.

  Everything else runs unattended without a word: `--dry-run` prints the plan
  without acting, anything that removes files has to be spelled out, and exit
  codes are meaningful, so `tj copy … || alert` does what you would expect.
  Output is a table for people, and `--output-format` gives it to a machine
  instead: `json` for `jq`, `csv` for a spreadsheet, `toon` for dropping into
  a model's context without paying for JSON's braces, and `lines` for `xargs`.
  Piping never silently changes the format. Colour follows `--color` and
  `NO_COLOR`, is dropped when output isn't a terminal, and never appears in a
  machine format at all — forcing it on can't corrupt something being parsed.
  It talks to a running Turbo Jumbo server, so what it reports and what the
  web UI shows cannot drift apart.

  Help comes in the depth you asked for. `tj -h`, or a bare `tj`, is every
  command on one screen; `tj --help` is the same ground with the reasons
  filled in; and `tj rm --help` — or `tj help rm` — is that one command alone,
  without the transfer flags scrolling past first. `tj --help-all` prints the
  lot, for when grep is the reader.

  `tj --version` answers which CLI you are running without needing a server to
  answer it, and `--version -v` adds the commit and build detail; `tj version`
  lists the server's and the CLI's side by side, since a client and server
  that have drifted apart is exactly when you want to see both.

  How much it says is one dial rather than a pair of flags: `--silent`, the
  default, then `-v`, `-vv`, `-vvv`, saying what is being done, then each
  request and its timing, then the bodies. Every line is tagged with the level
  that produced it and goes to stderr, so turning the noise up to debug a
  script never changes what that script reads.

  Documented with worked examples in [docs/cli.md](docs/cli.md).

- The Hugging Face download modal now offers a GGUF repo as a list of
  **quantizations** rather than a list of files. Each row is one thing you can
  download — a single weight, or the whole shard set of a split one — with its
  total size, so picking `UD-IQ3_S` is one click instead of ticking four
  shards. Repos that aren't a pick-one-quant choice, like a safetensors model
  and its config and tokenizer, still list their files. When you do need a
  single file — refetching one shard of a set whose siblings you moved off to
  free space — an "Individual files" switch lets you open a quantization and
  pick from inside it. A part-selected quantization says so on its row.

  Files that pair with a quantization rather than being one are named as such —
  `mmproj (F16)`, `mtp (F32)` — instead of borrowing whatever precision their
  filename happens to end in. An MTP head called
  `DeepSeek-V4-Flash-MTP-Q4K-Q8_0-F32.gguf` used to list as an `F32`
  quantization: 3.5 GiB, entirely plausible, sitting among the real
  quantizations of the 153 GiB weight it actually belongs to, with nothing
  saying the two went together.

- **The download modal now shows the repo's model card**, collapsed above the
  file list. A file list says what a repo contains; only the card says what any
  of it is for — which quantization suits how much RAM, and which files pair
  with which. `antirez/deepseek-v4-gguf` states that its MTP head is "optional,
  not standalone" and needs a specific loader, and nothing in thirteen
  filenames could have told you that. Repos without a card simply don't show
  the panel. Cards that open with a banner of HTML — most of unsloth's do —
  are reduced to the words that banner was wrapping, so the panel opens on
  the prose rather than on a screenful of tags.

- The download modal now marks what the target machine already has in cold
  storage, so you can see before starting that a quantization you were about to
  pull down is sitting on an archive disk you already own. A partly-archived
  set says how much of it is there. Nothing is selected or deselected on your
  behalf — a cold copy isn't at the download target, and fetching it back is a
  copy rather than a download. Downloads aimed at another peer are checked
  against that peer's cold storage, not this machine's.

- Repos that keep each quantization in its own directory can now be downloaded
  at all. `unsloth/DeepSeek-V4-Flash-0731-GGUF` and its kin previously showed a
  single file, because the modal only ever looked at the repo's top level — all
  thirteen of its quantizations were invisible. The file list now reaches the
  whole repo, and pasting a folder's own URL
  (`…/tree/main/UD-IQ3_S`) — which used to be rejected as "not a valid Hugging
  Face file URL" — jumps straight to that quantization with its files selected.

- Peers can now set a `slug` in `config.yaml` — the short, URL-safe name that
  identifies a machine in its tab's address (`/zurich`) and in the endpoints
  that address it. It was previously derived from the peer's name, which broke
  down for names that aren't plain ASCII: `Zürich` became `z-rich`, and a name
  with no ASCII letters or digits at all left the peer with no reachable tab.
  Leave it out and nothing changes — the derived name is still the default.
  The app now refuses to start if two peers end up with the same slug, or if a
  peer's name yields none, instead of quietly making a tab unreachable.

### Changed

- The Command section of the download dialog now shows the `tj` command for
  what you are about to do — say `tj get <repo> --quant UD-IQ3_S` — instead of
  a shell script that reproduced the download by hand. It is the same request
  the Download button makes rather than an imitation of it, since `tj get`
  posts to the same endpoint: the files land where the scanner expects them and
  the provenance sidecar is written for you, with no here-doc to paste and
  nothing to run afterwards to make a hand-started download indistinguishable
  from a clicked one.

  A whole quantization is named by the label the dialog shows; a narrower pick
  is named file by file; the cold-storage checkboxes become `--to cold` and
  `--delete-after`; a model pinned to a revision keeps its pin; and a download
  aimed at another peer carries the `--url` that runs it on that machine
  instead of this one.

  A model whose file set is narrower than the repo holding it keeps that too.
  A FastFlowLM registry entry pins a handful of files in a repo that also
  carries NPU kernels for other targets, and Turbo Jumbo records that set so
  the rest isn't counted against the model as missing — `tj get` can now say
  the same thing with a new `--exact`, so the copied command produces the same
  model rather than one that reads as permanently incomplete.

- The check that runs before a copy — the one that finds files already present
  at the destination — no longer re-reads both copies of every file to compare
  them. Turbo Jumbo already records each file's SHA256 when it downloads it, so
  when both copies still match what their sidecars recorded, the comparison is
  answered from those records and nothing is read at all. A model whose
  destination copy was already identical used to mean reading it twice end to
  end, at the speed of the slowest disk involved; a 155 GiB model that took
  several minutes now answers in under a second. Files without a usable record
  — support files, anything a sidecar never covered — are still compared by
  reading them, and the Copy button now reports which file it's on ("Verifying
  12/48…") with a Cancel check button beside it, instead of sitting on
  "Checking…" for minutes with no way out.

  That reading is now a SHA256, the same digest recorded when a file is
  downloaded, in place of the MD5 it used to fall back to. Because both are
  now the same digest of the same bytes, a file whose record one machine has
  and the other lacks needs only the one side hashed rather than both — and
  the reported digests can be read against each other and against an audit.
  A peer still running an older version answers in MD5, which reads as no
  answer at all: those files are copied rather than compared, so a fleet
  part-way through an upgrade loses the shortcut but never mistakes two
  different files for the same one.

- Updated the UI toolkit (Astryx 0.3.0) and framework (Next.js 16.3, React
  19.2.8), so some controls may look subtly different.
- Every checkbox is now the compact size — the row and select-all boxes in the
  models table, the file and quantization pickers, and the cold-storage options
  in the download, copy, delete and conflict dialogs. They were a mix of two
  sizes before; the smaller one suits lists this dense and keeps table rows
  from being taller than the text in them.
- **Lemonade's storage is now two directories rather than one**: `builtin/`,
  the Hugging Face cache holding the models Lemonade itself knows — its catalog
  plus the FastFlowLM tags it serves — and `extra/`, which is what Lemonade's
  `--extra-models-dir` reads. One directory could only ever hold what Lemonade
  already believed in; two make room for the models it doesn't list.

  The two are not the same kind of thing, because Lemonade doesn't read them
  the same way. `builtin/` is a real Hugging Face cache, with `refs/main` and
  `snapshots/`. `extra/` is a plain tree it scans for `.gguf` files, naming
  each model after the directory holding it — so Turbo Jumbo gives every model
  a directory named for its repo and fills it with symlinks, and Lemonade lists
  `extra.DeepSeek-V4-Flash-0731-GGUF` rather than something derived from a
  quantization folder. Only GGUF models are offered there: it is all Lemonade
  loads from that directory, so linking anything else would be a dead entry.

  `tj lemonade sync` sorts every cache entry onto the side it belongs on,
  including the ones left at the old single-directory root, and it does so on
  every run rather than once — a model sitting in `extra` becomes a `builtin`
  one the day the catalog picks it up. `--dry-run` shows the whole plan first.
  A repo somehow present on both sides is reported and neither copy is touched:
  one of them is stale, but which one holds real downloaded bytes is not a
  thing to guess at with a delete. And if the catalog can't be reached, nothing
  is sorted at all, since an unanswered request looks exactly like "Lemonade
  lists nothing" and acting on it would sweep the whole library into `extra`.

  Consolidating also clears out cache entries that have nothing left in them.
  Archiving a model deletes its local files, the links in Lemonade`s cache then
  dangle, and an earlier run drops those links — leaving a directory holding a
  revision marker and an empty snapshot. Lemonade reads that as a downloaded
  model, and lists one it cannot load. The whole entry now goes, and a model
  that is still held gets a working entry back in the same run.

  Sync also keeps `extra/` in step with local storage: a model that stops being
  held, or that the catalog picks up later, has its links cleared away. A
  directory there containing a real file is left alone entirely — Lemonade
  calls that directory user-managed, and a file in it is somebody's own.

  **Two settings on the Lemonade side.** Its cache root has to be
  `<lemonade>/builtin`, or it will find nothing: its models have moved down a
  level. And `--extra-models-dir <lemonade>/extra` is what makes the second
  half visible at all.

- A copy interrupted partway to another machine now picks up where it stopped
  instead of starting the file again. Copies within one machine already did
  this; sending to a peer did not, because the sender can't see the receiver's
  disk — so a 4 GiB shard cut off near the end cost the whole 4 GiB a second
  time. The receiver now says how many bytes it holds and the SHA256 of exactly
  those bytes, and when the sender's own first bytes hash the same, the partial
  is kept and only the rest travels. Anything else — different bytes, a longer
  file than the one being sent, a machine that can't answer — is sent in full,
  so a half-written file is never completed with the tail of a different one.
  A file already there in its entirety now costs the reading of it rather than
  the sending of it.

  Pulling a model out of cold storage was the last copy that always started
  over; it resumes too.

- `tj`'s progress bar now reports the rate a transfer has averaged since it
  began — `111.9 MiB/s avg` — and repeats it on the closing line, so a copy
  says what it managed overall rather than leaving you to divide. Copies had no
  rate at all before, only downloads did, and the one downloads showed was a
  spot reading of the moment. The average counts the stretches that moved no
  bytes, like verifying a partial destination before resuming it, because those
  are part of what the transfer cost. It appears on the milestone lines that
  replace the bar when output is redirected, too, where a log of an overnight
  transfer is read for exactly that figure.

  The bar now also shrinks to fit a narrow terminal rather than wrapping, since
  a wrapped bar redraws its last row and strands the rest.

### Fixed

- **FLM (NPU) models work again on Lemonade servers that require an API
  key.** A Lemonade server started with `LEMONADE_API_KEY` set answers 401 to
  every request, so the FLM section of the Lemonade browser only reported
  "HTTP 401". A peer can now carry a `lemonade_api_key` next to its
  `lemonade_url`; the app sends it as a Bearer token when listing that
  server's FLM models and when asking it to pull one. The key stays on the
  server — it is stripped from the peer list browsers receive. A server that
  still answers 401 is now reported as needing the key, by name.

- An interrupted download of a split model can now be finished from the audit
  hovercard. A quantization missing some of its shards reported which ones were
  absent and stopped there, offering nothing to press — the same hovercard
  offers "Download missing files" for every other kind of missing file. It now
  lists each absent shard with its size and one button that fetches them all,
  resuming from whatever the interrupted run had already transferred.
- A sharded model no longer gets a different quantization label on each
  machine. The label is read from one shard's header, and which shard that
  was depended on the order the filesystem happened to list the directory in
  — so a mixed-precision checkpoint could read BF16 on one peer and F32 on
  another. The lowest-numbered shard now always decides.
- Deleting a sharded model no longer warns that it isn't backed up in cold
  storage when every shard is in fact there, and copying one no longer counts
  a destination as already having it when only a single shard is present.
- The "Copy to…" modal is wider and scrolls long selections inside the
  dialog: the file list gets its own viewport while the destination
  checkboxes and the Cancel/Copy buttons stay visible.
- The modal listing files that already exist at a copy destination is wider
  too, and each file's path now gets a line of its own instead of being
  squeezed alongside its destination, status and overwrite/skip label — a
  long path used to wrap mid-name and run into the status badge. Long lists
  scroll inside the dialog instead of stretching it, so Cancel and Continue
  stay put however many files clash.
- Copying a sharded model (a multi-file safetensors repo, a split GGUF) no
  longer lists every shard in the copy modal — it shows one line with the
  file count and total size. Shard sizes now also back the "already present"
  checks, so a destination holding truncated shards no longer counts as
  having the model.
- The audit hovercard stays usable when a model is missing many files: each
  missing file is now a single compact line (the shared repo and revision
  links appear once instead of repeating per file), long file lists scroll
  inside the card, and the "Download missing files" button no longer gets
  pushed out of reach. The invalid-files hovercard's list scrolls the same
  way. Audit hovercards containing buttons or links also linger longer after
  the pointer leaves the badge, so the card no longer vanishes on the way to
  its button.
- The footer's free-space meters now update immediately after a delete, copy,
  or download instead of waiting out their next periodic poll.
- The audit hovercard's "Download missing files" now downloads all of them in
  one go — including small companion files (a tokenizer_config.json) that
  previously had no download path at all — instead of quietly fetching a
  single file. Re-downloads honor the model's pinned revision, and a partial
  re-fetch or single-file delete no longer erases the model's recorded
  revision pin or file scope.
- The audit is now revision-aware: a model downloaded from a pinned branch or
  tag (e.g. a FastFlowLM registry pin) records that revision in its sidecar,
  and every repo comparison — the whole-repo file list, the incomplete and
  invalid checks, audit source resolution — judges it against that revision
  instead of main. Previously a pinned repo whose main had moved on reported
  spurious invalid and missing files.
- Deliberately file-scoped downloads record which files make a complete copy:
  an FLM model downloads exactly the files FastFlowLM's registry names, so
  the repo's extra NPU kernel files no longer count as "missing" — the file
  list and the incomplete check judge only the recorded scope.
- Deleting a model's last weight file now removes its support files too:
  a directory left without any weights takes its config.json, tokenizer
  files, and other companions with it instead of lingering as an unreachable
  husk. Directories that still hold a weight — another quantization, a
  projector — are left untouched.
- Copying a model now carries its support files along — config.json, tokenizer
  files, the safetensors index, and anything else living in the model's
  directory besides the weights. Previously only the weight files selected in
  the table were copied, so a safetensors model arrived at its destination
  unloadable. The pre-copy conflict check reports on the full list, so an
  existing support file at the destination shows up before any bytes move.

  They are looked for everywhere a copy of the model is held, not only where
  its weights are being read from. A model kept both locally and in cold
  storage is read from cold storage, that being the cheaper disk, and an
  archive of one is often the weights and nothing else — so the files have to
  be fetched from whichever machine or disk still has them. Every way of
  starting a copy does this: the button, `tj copy`, and completing a partial
  archive.

### Added

- The Lemonade browser can now list and download FLM (FastFlowLM, AMD NPU)
  models. These exist only inside a running Lemonade server — discovered from
  its flm binary, never in the static catalog — so each peer can name its
  Lemonade server with a new `lemonade_url` config field. The browser then
  shows an "FLM (NPU)" section with that server's models (download state
  included). Models FastFlowLM's public registry maps to a Hugging Face repo
  download directly into Turbo Jumbo storage — at the registry's pinned
  revision, through the regular download runner, with sidecars and peer
  copies like any other model (the `.q4nx` NPU weight format is now
  recognized, labeled Q4NX). Models without a known source fall back to
  asking the Lemonade server to pull into its own store, with live progress;
  after such a pull the server is asked whether it now counts the model as
  downloaded — a server whose flm backend quietly fetched nothing (an
  unhealthy NPU setup) gets a warning instead of a false "downloaded".
- Safetensors models now show their weight precision (BF16, F16, …) as a badge
  on the model row. Previously the dtype read from the safetensors headers was
  never displayed anywhere — only GGUF models showed their quantization, on
  their per-quant rows.
- The Lemonade browser now handles catalog models built from a role map of
  checkpoints — the Gemma-4 MTP (multi-token prediction) models with their
  draft and mmproj companion files. They were previously missing from the
  catalog entirely; now they browse and download like any other model.
- The app knows what version it is: shown next to the name in the header
  (with a `dev` marker when the running code doesn't match an official tagged
  release), and served at `/api/v1/version` — also per peer at
  `/api/v1/peers/<name>/version`, so a fleet running mismatched versions can
  be spotted.
- Peer tabs (and the Cold Storage tab) now show the location's disk usage in
  the footer, above the action buttons: a slim used/total meter per volume —
  turning to a warning color when the disk is over 90% full — with the used,
  free, and total figures beside it, for the models volume and, where
  configured, cold storage. Remote peers report their own disks; volumes
  sharing one filesystem show a single combined meter. The figures refresh
  every minute while the tab is open.

### Changed

- A model holding more than one quantization now shows a single total in the
  Size column instead of a min–max range across its quants (which said little
  once each quant is its own separate download). The total counts what's
  actually present at the location you're viewing: files on local storage on
  the All tab, the cold copy on the Cold Storage tab, the peer's copy on a
  peer tab — so a quant that lives only in cold storage or only on a peer no
  longer inflates the local total.
- The Lemonade browser's other-backend models (vLLM, Ryzen AI ONNX, image,
  speech) now honor the "Suggested only" filter, wear their suggested badges
  and capability icons, and file under the section their catalog labels say
  they belong to — the MTP models list under Vision models beside their
  single-file siblings.
- Searching the Lemonade catalog is now exhaustive: the filter looks past the
  "Extra models" toggle and matches capability labels, so a model the catalog
  knows is always findable by name.
- The download progress dialog is wider, and long output now scrolls inside
  the dialog with the Cancel/Close button always in reach — previously the
  content could overflow off-screen with no scrollbar. The progress bars and
  any warnings stay pinned in view above that scrolling output, so you can
  read the raw log without losing sight of how far along the download is.
- The Lemonade catalog opens with every section collapsed, showing just the
  section headers and their model counts. Expand what you need — or type in
  the filter, which looks inside collapsed sections and shows every match.
- Models that back a Lemonade catalog entry now carry a 🍋 marker next to
  their name in the models table; hovering it names the exact catalog
  entries the repo backs (e.g. `Qwen/Qwen3.6-35B-A3B` behind the catalog's
  `Qwen3.6-35B-A3B-FP16-vLLM`). A missing lemon reliably means the model
  isn't in the catalog.

### Fixed

- The model name hovercard no longer shows one copy's size as if it were the
  whole model's. When the local and cold-storage copies differ — most often a
  different quantization in each — the file total is now broken out by
  location (`Files · Local  3 · 18.7 GiB`, `Files · Cold  2 · 33.7 GiB`), so
  the number always matches the files it describes.
- Every byte size in the app now reads in binary units (GiB/MiB/KiB) — models,
  files, disk usage and download progress alike — instead of some places
  dividing by 1024 while printing "GB" and others using decimal GB. (The
  Lemonade catalog still shows the figure its own spec lists, in GB.)
- A multi-repo download plan (a Lemonade collection or component) now stops
  when one of its downloads fails, instead of burying the error and carrying
  on with the remaining repos as if nothing happened.
- When the `hf` downloader dies by a signal, the error now says so in plain
  words — "exited with code 137" becomes "killed by signal 9 (SIGKILL),
  usually the out-of-memory killer".

### Security

- The pre-copy conflict check now refuses machines that aren't configured
  peers, and file paths that point outside the model and cold-storage
  directories. It took both from the request and acted on them unchecked: a
  request naming any host would make the server call out to it, and a path
  climbing out of its directory would make it read and hash a file elsewhere
  on disk and report the result back. The copy itself has always rejected
  both; the check that runs first did not.

The first release: mission control for your hoard of AI models.

### Added

- **The models table** — every model and quantization across all your
  machines and cold storage in one view, including split (sharded) files,
  with live per-peer presence as machines come and go.
- **HuggingFace downloads** — pick a repo and files, download to whichever
  peer needs them, progress bar included. Every file gets a sidecar recording
  where it came from, the exact source revision, and its expected size and
  hash.
- **Peer-to-peer transfers** — copy models between machines over your own
  network, with cold storage as the archive; download from the internet once,
  then move bytes on your own wires.
- **Audits** — re-check what's on disk against HuggingFace on demand: sizes,
  hashes, revisions. Incomplete downloads, upstream updates, and duplicates
  under different names all get flagged.
- **Lemonade integration** — browse and download from the Lemonade SDK's
  model catalog (GGUF models and omni collections), and consolidate with
  Lemonade's cache in both directions using symlinks, so one copy on disk
  serves both the inference server and the archive.
- **Deployment** — a single Next.js app per machine, one shared peer config,
  Docker/podman images with a tarball deploy flow.

[Unreleased]: https://github.com/eendeego/turbo-jumbo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/eendeego/turbo-jumbo/releases/tag/v0.1.0
