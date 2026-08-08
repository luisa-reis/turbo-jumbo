# `tj` CLI — phase 3: audit

Phase 3 adds `tj audit`: verify files against Hugging Face, report what doesn't
match, and repair what can be repaired. It inherits every convention from
[phase 1](2026-08-08-tj-cli-phase-1-design.md) and
[phase 2](2026-08-08-tj-cli-phase-2-design.md), and finally spends the exit code
phase 1 reserved.

## Command

```
tj audit <model>|--all [--cached] [--fix [--allow-delete]]
                       [--cold|--peer <slug>] [--dry-run]
```

### Fresh by default

A fresh audit reads every byte of every file it checks — that is how bit-rot is
caught, and there is no cheaper way to catch it. `--cached` reads the last-known
verdicts out of the sidecars instead: instant, no hashing, no network, and
honest about being history rather than truth.

Fresh is the default because `audit` should mean what it says. The cost is
guarded structurally instead: **a bare `tj audit` with neither a model nor
`--all` is refused**, so nobody starts an hours-long read of an archive by
typing two words.

### Repairing is three endpoints, not one

`--fix` looks like a single idea and isn't. The app repairs findings through
three separate endpoints, and they differ in what they risk:

| Finding         | Endpoint                      | Risk                                   |
| --------------- | ----------------------------- | -------------------------------------- |
| `misplaced`     | `/api/v1/audit/fix`           | Relocates. Loses nothing.              |
| `duplicate`     | `/api/v1/audit/fix-duplicate` | **Deletes** all but one verified copy. |
| everything else | `/api/v1/audit/set-source`    | Needs a human to choose a source.      |

So `--fix` covers only the relocation, and resolving duplicates needs
`--allow-delete` typed as well. This follows phase 2's posture, where
`--delete-after` had to be typed: on a tool that never prompts, a
general-purpose flag must not quietly remove files.

Findings with no automatic repair are named and left alone, with a line saying
what they need. The CLI does not attempt `set-source`, because choosing a source
is exactly the question it has nobody to ask.

## Exit codes

|     |                                                                     |
| --- | ------------------------------------------------------------------- |
| `0` | Everything passed — or every finding was repaired                   |
| `1` | The command failed: bad usage, unreachable server, nothing to audit |
| `2` | The audit ran and something is **still** wrong                      |

The `1`/`2` split is the point of the whole exercise for a monitoring job: `2`
means "I checked, and it is bad", `1` means "I could not check at all".
Collapsing them would let an unreachable server look exactly like a clean
archive.

Exit `2` is computed from what remains **after** repairs, not from what was
found. A run that fixed everything it found leaves a correct machine, and
`tj audit --fix || alert` should not page anyone about a problem that no longer
exists. A repair that failed or was skipped leaves its finding standing.

Findings are not an error, so they take a different path out of the code: the
command throws `AuditFindings` carrying its normal output, and the entry point
prints that report on stdout as usual before exiting 2. The report is the
product; the exit code is just how a script reads it.

## Progress

The audit streams NDJSON interleaving three kinds of line — a start event, hash
progress per file, and a final result per file — with several files in flight at
once, since the server hashes at a concurrency.

Overall progress is therefore the bytes of finished files plus how far each
in-flight file has got, which is why the **total comes from the CLI's own file
list** rather than from the stream. A finished file counts whole; where a verdict
carries no `computedSize` (`unverifiable` and `duplicate` need no hashing) its
known size is the fallback, since counting those as zero leaves the bar stuck
short of 100% — a real defect found by running it.

Rendering reuses phase 2's: a redrawing bar on a terminal, milestone lines when
redirected.

## Testing

Pure and tested in `lib/cli/audit-plan.ts`: target selection from a location's
models (including shards), the progress aggregator (concurrent in-flight files,
the missing-`computedSize` fallback, never exceeding the total), which statuses
count as findings, which are repairable by which route, and the exit code —
including that a repaired finding stops counting.

Live verification runs against a **throwaway instance** with its own
`CONFIG_PATH` and scratch storage directories, not against real model storage.
That is what makes it possible to manufacture a genuine `misplaced` finding — a
real GGUF placed at the storage root — and watch the whole loop: exit 2, `--fix`
relocating it, exit 0, and a re-audit coming back clean. Faults worth testing
should not have to be created in a real archive.

## Out of scope

`set-source`, which needs an interactive choice. `/api/v1/audit/updates`, which
reports newer revisions upstream rather than problems with what is on disk —
a different question, and arguably a different command.
