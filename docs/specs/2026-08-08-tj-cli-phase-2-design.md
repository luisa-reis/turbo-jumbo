# `tj` CLI — phase 2: transfers

Phase 2 adds the commands that move bytes: fetching from Hugging Face, and
copying between local storage, cold storage and peers. It inherits every
convention from
[phase 1](2026-08-08-tj-cli-phase-1-design.md) — server discovery, `--format`,
exit codes, the HTTP-client architecture — and adds only what transfers need.

## Commands

### `tj get <repo|url>`

Downloads from Hugging Face through `/api/v1/hf-download`.

```
tj get <repo|url> [--quant <label>] [--file <path>]... [--to cold] [--delete-after] [--dry-run]
```

The argument takes anything `parseHfUrl` accepts: a bare `org/repo`, a repo URL,
a folder URL (`…/tree/main/UD-IQ3_S`), or a file URL. Selection then mirrors the
download picker exactly, because it reuses the same functions:
`/api/v1/hf-files` for the listing, `repoDownloadKind` to decide whether the repo
is a pick-one, and `quantGroups` to collapse it into quantizations.

- `--quant <label>` picks a quantization by the label the picker shows
  (`UD-IQ3_S`, `Q4_K_M`). Repeatable.
- `--file <path>` picks individual repo-relative files, for the cases phase 1's
  "Individual files" switch exists for.
- A folder URL selects that folder, already curated, as the picker does.
- **With no selection and no way to infer one, `tj get` lists the available
  quantizations and exits 0.** It does not download the largest, or all of them.
  Printing the menu is the useful answer to an under-specified request, and it
  is the same list `tj get --quant` then takes.
- `--to cold` sets `sendToCold`; `--delete-after` sets `deleteAfterTransfer`.
  `--delete-after` without `--to cold` is a usage error, matching the UI, where
  the checkbox is only available under the other.

### `tj copy <model>`

Copies existing files through `/api/v1/copy`.

```
tj copy <model> [--quant <label>] --to cold|<peer> [--from local|cold|<peer>] [--delete-after] [--dry-run]
```

`cold push` and `cold pull` do not exist as separate commands: `/api/v1/copy`
already handles cold storage and peers through one request, so `--from` and
`--to` express both. This follows phase 1 folding `cold ls` into `ls --cold` —
one command with filters beats several near-identical ones.

- `<model>` is a substring, as in `tj ls` and `tj where`. It must resolve to
  exactly one model; if it matches several, they are listed and the command
  exits 1 rather than picking one.
- `--quant` narrows to one quantization; without it, every quantization of the
  model that the source holds is copied.
- `--from` defaults to the first source that actually holds the files: local,
  then cold, then any peer. Being explicit overrides that.
- `--to` accepts `cold` or a peer slug. Slugs are resolved to the addresses
  `/api/v1/copy` expects via `/api/v1/peers`.
- `/api/v1/copy/check` runs first, and files already complete at the destination
  are passed as `skip`, exactly as the UI does — so a re-run after an
  interruption transfers only what is missing.

### `--dry-run`

On both commands: resolve everything, print the plan — the files, their sizes,
the total, the source and destination — and exit 0 without transferring. This is
the safety mechanism for a tool that has no prompts.

## No prompts, ever

Nothing in phase 2 asks a question on stdin. A tool meant for cron cannot block
waiting for a terminal that isn't there, and a prompt that is skipped when
non-interactive is worse than no prompt at all, because the safe path becomes
the one that only happens when someone is watching.

Destructive intent is instead explicit and inert by default: `--delete-after`
has to be typed, and `--dry-run` shows exactly what would happen first.

## Progress

Two endpoints, two stream formats, one renderer.

| Endpoint | Format | Parsed by |
| --- | --- | --- |
| `/api/v1/hf-download` | terminal text, `\r`-redrawing | `parseProgress` / `parseNotices` (`lib/hf/download-output.ts`, already used by the web UI) |
| `/api/v1/copy` | newline-delimited JSON frames | new, small: `{filesDone, filesTotal, bytesDone, bytesTotal, phase, errors, …}` |

Both normalise to one `TransferProgress` shape, and the renderer chosen depends
on whether stdout is a terminal — the same TTY rule phase 1 established for
colour.

**On a terminal:** a redrawing bar with percentage, transferred and total bytes,
rate and elapsed time.

**Redirected (cron, a log file):** a line each time the completed-file count
advances, plus a final summary. No bar, no repetition, so a log stays readable
and greppable weeks later.

A deliberate limitation: those milestone lines report **counts, not filenames**.
Neither stream says which file is currently in flight — `hf-download` emits
`(2/5 files)` and `copy` emits `filesDone`/`filesTotal`. Naming the file would
mean inferring it from the order the CLI sent, which `/api/v1/copy` does not
preserve (it groups files by source and destination). Reporting a count that is
true beats a filename that is sometimes wrong. Failures are exempt: copy frames
carry an `errors` array, so failures are named.

Sample redirected output:

```
2/4 files  50.6 GiB / 108.1 GiB
3/4 files  96.8 GiB / 108.1 GiB
4/4 files  108.1 GiB / 108.1 GiB
copied 4 files · 108.1 GiB · 42m18s
```

`--format json` prints a single result object when the transfer ends rather than
streaming frames, so it stays parseable by `jq` without a streaming reader.
`--format quiet` prints nothing on success and the error on failure.

## Exit codes

Phase 1's codes, unchanged:

| | |
| --- | --- |
| `0` | Everything transferred (or `--dry-run` printed a plan, or a menu was listed) |
| `1` | Any shortfall: nothing ran, some files failed, bad usage, unreachable server |
| `2` | Still reserved for audit findings |

A partly-successful copy exits `1`. `/api/v1/copy` collects per-file errors
instead of aborting, so a run can end with most files moved and some not; that
is a failed copy. Making it exit `0` would let `tj copy … || alert` stay silent
about lost files, and splitting it into its own code would give `2` a second
meaning before `tj audit` has claimed its first.

Failed files are always named on stderr, whatever the format.

## Testing

Pure and tested under `lib/cli/`:

- frame parsing for the copy stream, including partial lines split across chunk
  boundaries, which a naive `split('\n')` gets wrong;
- normalisation of both formats into `TransferProgress`;
- bar rendering and milestone-line emission (that a line appears only when the
  count advances);
- selection for `get`: quant labels, `--file`, folder URLs, and the
  no-selection-lists-the-menu path;
- source and destination resolution for `copy`, including slug → address and the
  local/cold/peer fallback order;
- exit-code selection from a finished transfer.

Live verification runs against the isolated `:3998` server: a real but small
download (`Qwen/Qwen3-0.6B-GGUF` `Q8_0`, ~640 MiB, or a single small shard),
`--dry-run` on a large one, both TTY and redirected rendering, and a copy to cold
storage of something small. Nothing in the tens of gigabytes.

## Out of scope

`audit` and `rm` (phases 3 and 4). Resuming a transfer the CLI itself
interrupted — `hf` and the copy check already skip what is present, so a re-run
is the resume. Parallel transfers: one at a time, as the UI does.
