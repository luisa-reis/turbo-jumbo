# `tj` CLI — phase 4: removal and Lemonade

The last phase: `tj rm`, and the two Lemonade commands. It inherits every
convention from phases [1](2026-08-08-tj-cli-phase-1-design.md),
[2](2026-08-08-tj-cli-phase-2-design.md) and
[3](2026-08-08-tj-cli-phase-3-design.md).

## `tj rm`

```
tj rm <model> --from local|cold|<peer> --yes [--quant <label>] [--dry-run]
```

The only irreversible command in the tool, so **both halves of the intent must
be typed**.

`--from` has no default. A defaulted tier is precisely how someone deletes the
archived copy while meaning the local one, and that is the mistake with no way
back. `--yes` is the second half, matching the convention the `hf` CLI uses for
its destructive commands — a vocabulary this project's users already have, since
the app shells out to it.

An ambiguous pattern is refused with the list of matches rather than resolved.
`--dry-run` maps onto the delete endpoints' existing `dryRun` flag, so the
preview is computed by the same code that would do the deleting rather than by a
second implementation of the same rules.

## `tj lemonade`

```
tj lemonade ls [pattern]
tj lemonade sync [--dry-run] [--yes] [--peer <slug>]
```

### `ls`

The catalog, marked with what this machine already holds — in Lemonade's own
cache, in Turbo Jumbo's storage, or both.

Presence is resolved **within each entry's own repo**, using
`matchVariantFiles` — the resolver the Lemonade downloader already uses. This
matters more than it sounds: a catalog `variant` is often a bare quant token
(`UD-Q4_K_XL`, `Q8_0`) rather than a filename, 38 of 84 entries at the time of
writing. Matching such a token against every file on the machine reports any
model's `Q8_0` as this entry's, which the first implementation did — it claimed
7 entries were present when only 1 was. Scoping to the repo is what makes the
column honest.

Only the catalog's `models` are listed; omni collections and their components
are not.

### `sync`

`/api/v1/lemonade/sync` is already split the way the CLI wants: `GET` previews
and `POST` executes. So `--dry-run` is a genuine preview computed by the same
code that would run, not a re-derivation.

A sync does four things, and two of them delete: it moves Lemonade-only files
into Turbo Jumbo, **deletes** Lemonade copies of files Turbo Jumbo already
holds, materialises the rest as symlinks, and **deletes** dangling ones. So it
needs `--yes`. The preview names the deletion explicitly rather than leaving it
implied by two neutral-looking `DEDUP` and `STALE` columns.

## The safety vocabulary, complete

With this phase the tool has four distinct gates, and they are not
interchangeable:

| Flag             | Gates                                                           |
| ---------------- | --------------------------------------------------------------- |
| `--dry-run`      | Everything that changes anything: show the plan, act on nothing |
| `--delete-after` | An _optional extra_ on a transfer: also remove the source       |
| `--allow-delete` | _Widens_ `audit --fix` to a repair that deletes duplicates      |
| `--yes`          | Confirms a command whose **purpose** is removal                 |

The split between `--allow-delete` and `--yes` is the subtle one: the first
opts into an extra kind of repair on a command that is not otherwise
destructive; the second confirms a command that exists to remove things.
Collapsing them would either make `audit --fix` feel dangerous or make `rm`
feel casual.

Nothing prompts, anywhere — the rule set in phase 2 and unbroken since.

## Refactor

`audit` and `rm` both address a single storage tier and need the same four
spellings of it: the endpoint to list it, the endpoint to delete from it, the
`location` string the audit API expects, and a name to print. That moved out of
`audit` into `cli/location.ts` rather than being written twice.

## Testing

The pure parts are already covered: `rm` reuses `auditTargets` from phase 3 for
file selection, and the location resolution is a thin mapping over
`/api/v1/peers`.

Live verification of `rm` runs against a **throwaway instance** with its own
`CONFIG_PATH` and scratch storage — the same approach phase 3 used, and for a
stronger reason here: verifying a delete means actually deleting something.
Both guards, the ambiguity refusal, the inertness of `--dry-run`, the real
deletion, and the "no model matches" of a second run were all exercised there.

One path is **not** verified live: the sync _execution_. The machine's Lemonade
cache is already reconciled, so `GET` returns nothing to do, and manufacturing a
fake hub-cache to force work is more fabrication than the coverage is worth. The
preview path, both guards and the error paths are verified; `POST` is not.

## Out of scope

`/api/v1/lemonade/flm` and `flm/pull` (the FLM/NPU registry), and
`/api/v1/audit/set-source`, which needs an interactive choice.
