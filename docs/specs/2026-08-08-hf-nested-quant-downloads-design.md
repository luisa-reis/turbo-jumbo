# Nested-folder and per-quantization Hugging Face downloads

## Problem

Some GGUF repos keep each quantization in its own subdirectory rather than as a
file at the repo root. `unsloth/DeepSeek-V4-Flash-0731-GGUF` is the motivating
case: 54 files in the tree, 51 of them GGUF, spread across 13 `UD-*/` quant
directories plus a `dspark/` directory and one root-level weight.

The download picker cannot reach any of it. Two independent failures:

1. **A folder URL doesn't parse.** `parseHfUrl` accepts a pathful URL only under
   `blob`/`resolve`, and `tree` only bare. Pasting
   `https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF/tree/main/UD-IQ3_S`
   returns `null`, and the picker reports "Not a valid Hugging Face file URL."

2. **The repo root listing hides the quants.** `/api/v1/hf-files` fetches the
   root non-recursively, so `repoDownloadFiles` sees three paths and returns one
   (`dspark-DeepSeek-V4-Flash-0731-Q8_0.gguf`). All 13 quant directories are
   invisible; there is no path from the repo id to `UD-IQ3_S`.

Everything downstream of the picker already handles nested paths — `filePaths`
may contain `/`, files land at `<base>/<org>/<repo>/UD-IQ3_S/…`, the scanner
walks recursively, `extractQuant` already knows the `UD-` prefix, cross-peer
matching joins on basename, and GGUF repos are exempt from whole-repo
completeness checks. A blob URL naming shard 1 downloads the whole shard set
today. The gap is entirely in the picker's front door.

A second, related gap surfaced while scoping: even for repos the picker *can*
list, it presents a flat wall of files. This repo would show 51 rows where the
user is really choosing among 15 quantizations.

## Decisions

| Decision | Choice |
| --- | --- |
| Listing depth | Always recursive, for every repo |
| Curation of nested files | Existing `repoDownloadFiles` rules, applied uniformly |
| Repo-root presentation (pick-one repos) | One row per quantization |
| Repo-root presentation (whole-repo repos) | Flat file list, full relative paths |
| Folder URL default selection | Scope to the folder and preselect it, curated |

Always recursing is cheaper than it sounds: a repo with no subdirectories
returns the identical listing either way. It is also already proven — the three
Lemonade call sites in `use-lemonade-download.ts` pass `recursive=true` with no
folder today, so recursive-listing-through-`repoDownloadFiles` is a path that
runs in production for every catalog download. The picker is the only caller
that never opted in.

Grouping by **quantization** rather than by **directory** is deliberate. Two of
this repo's 15 units do not live in a quant folder (`Q8_0` at the root, `BF16`
under `dspark/`), so directory grouping would not cover them. Quant grouping
also collapses ordinary flat GGUF repos, where quants are distinguished by
filename — one rule for both layouts.

## Design

### 1. `lib/models/quant.ts` (new) — fs-free quant extraction

`extractQuant` and `extractModelName` live in `lib/models/models.ts`, which
imports `fs` on its first line. Nothing outside that file imports them today, so
the coupling has never mattered; grouping in the picker makes it matter, since a
client component importing them would drag `fs` into the browser bundle.

Move `QUANT_TOKEN`, `QUANT_RE`, `SPLIT_RE`, `stripExtension`, `lastQuantMatch`,
`extractModelName` and `extractQuant` into a module with no `fs` import.
`models.ts` re-exports them so its callers and `models.test.ts` are untouched —
which is also the proof the move was behaviour-preserving.

### 2. `lib/hf/hf-url.ts` — tree paths, full-depth folders

`ParsedUrl.folder` is redefined from "first path segment" to "the directory
containing the reference", at full depth. The old definition silently truncated:
a blob URL at `split_files/vae/x.safetensors` yielded `split_files`.

| input | folder | filename |
| --- | --- | --- |
| `tree/main/UD-IQ3_S` | `UD-IQ3_S` | `null` |
| `blob/main/UD-IQ3_S/…-00001-of-00004.gguf` | `UD-IQ3_S` | `…-00001-of-00004.gguf` |
| `blob/main/split_files/vae/x.safetensors` | `split_files/vae` | `x.safetensors` |
| `org/repo`, repo URL, `tree/main` | `null` | `null` |

Trailing slashes already work (`parseHfUrl` strips them before matching), so
`https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF/` needs no change.

### 3. `app/api/v1/hf-files/route.ts` — always recurse, curate uniformly

- Always fetch `?recursive=true`; drop the `recursive` query param. The three
  `use-lemonade-download.ts` call sites that pass it lose the now-dead argument.
- `FOLDER_RE` admits `/` for nested folders and rejects `..` segments, matching
  the guard `hf-download-stream.ts` already applies to `repoId`/`filePaths`.
- Folder listings run through `repoDownloadFiles` instead of today's bypass, so
  a folder is judged on its own contents. HF returns repo-relative paths for a
  scoped tree fetch, so curation sees the same shape either way. `UD-IQ3_S/` is
  a GGUF set and keeps all four shards; `dspark/` keeps its weight and drops its
  README.

### 4. `lib/hf/hf-download.ts` — one shared rule for repo shape

The branch decision inside `repoDownloadFiles` becomes an exported
`repoDownloadKind(paths)` returning `'safetensors' | 'pick-one' | 'whole-repo'`.
`repoDownloadFiles` is rewritten in terms of it, and the picker uses it to decide
whether to group — so the two cannot drift apart.

`defaultDownloadSelection` gains the folder. A folder-scoped listing with no
named file selects everything listed (already curated); the shard-set and
exact-match branches, and the empty-set-for-a-bare-GGUF-repo case, are unchanged.

### 5. `lib/hf/quant-groups.ts` (new) — downloadable units

Pure, fs-free, testable. Groups a curated file list into the units a user
actually picks:

- **Key**: directory + shard base (via `SPLIT_RE`), so two files sharing a quant
  token in different directories stay distinct.
- **Label**: `extractQuant`, falling back to the filename when a GGUF carries no
  recognizable quant token (`extractQuant` returns `unknown`).
- **Shape**: `{label, folder, paths, size, fileCount}`.

### 6. `components/hf-download/hf-download-picker.tsx`

When `repoDownloadKind` is `pick-one`, render one row per quant group — label,
file count, total size, and folder — whose checkbox selects the whole set.
Otherwise keep the flat file list, but label and filter on the full relative
path rather than the basename, so two same-named files in different directories
are distinguishable and folder-based filtering works. For flat repos, path
equals basename and nothing changes.

The placeholder gains the folder-URL form. **No API change**: the request still
submits `filePaths`, assembled from the selected groups.

## Behaviour

| Input | Result |
| --- | --- |
| `unsloth/DeepSeek-V4-Flash-0731-GGUF` | 15 quant rows, none ticked |
| `…/tree/main/UD-IQ3_S` | 1 row, ticked, 4 files · 108.1 GiB |
| `…/blob/main/UD-IQ3_S/…-00001-of-00004.gguf` | 15 rows, `UD-IQ3_S` ticked |
| `Qwen/Qwen3-0.6B-GGUF` (flat GGUF) | now grouped by quant |
| A safetensors repo | flat list, full paths, preselected as today |

## Testing

- `lib/hf/quant-groups.test.ts` (new): this repo's real 51-path GGUF layout
  collapsing to 15 units, a flat GGUF repo, the same quant token in two
  directories staying separate, and a tokenless GGUF falling back to its
  filename.
- `lib/hf/hf-url.test.ts`: tree-with-path, nested blob dirname, trailing slash;
  the four existing cases unchanged.
- `lib/hf/hf-download.test.ts`: `repoDownloadKind` per repo shape, and
  folder-scoped `defaultDownloadSelection`.
- `lib/models/models.test.ts` must pass untouched — the proof that extracting
  `quant.ts` changed no behaviour.
- Live run on the isolated `:3998` server (`NEXT_DIST_DIR=.next-verify`,
  `NEXT_DEV_INDICATORS=0`) against the real URL: confirm the 15 rows, confirm the
  folder URL preselects one, confirm the built `hf` command. **Do not run the
  108 GiB download.**

A user-visible `CHANGELOG.md` bullet goes under `## [Unreleased]` in the same
commit.

## Out of scope / known limits

**HF tree pagination.** The tree API paginates past some page size via a `Link`
header, and no existing caller follows it — `repo-files.ts`, `hf-infer.ts` and
the Lemonade path all fetch unpaginated today. Two probed repos were under the
threshold, so it could not be determined empirically. This change does not
worsen the situation for Lemonade but newly exposes the picker to it: a repo
with more files than one page would list partially and silently. Noted rather
than fixed; widening into pagination work is a separate change.

**Per-shard selection.** A quant row is all-or-nothing. Re-running a download
resumes by skipping files already on disk, so selecting individual shards has no
established use.
