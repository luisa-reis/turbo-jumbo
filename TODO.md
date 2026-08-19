# TODO

Open work, one entry per item, ordered by priority — the top entry is the
next thing to pick up. Each states what it is, why it's worth doing, and
where the detail lives. Finished items are deleted, not checked off —
history belongs to `docs/plans/` and `docs/specs/`.

## Storage interface migration (in flight)

Route the rest of `lib/`'s filesystem calls through the `Storage` interface,
ahead of splitting TJ into one UI host plus thin per-machine agents. The spec
is the source of truth for the remaining call sites (ordered, easiest first),
the decisions already settled, and the open questions — agent authorization,
and Lemonade's bind mounts when the agent runs in LXC:
[docs/specs/2026-08-10-storage-interface-design.md](docs/specs/2026-08-10-storage-interface-design.md),
"Where step 2 has got to". Done so far: the interface, `LocalStorage`,
`storage-instance.ts`, and disk usage.

## Lemonade catalog spec-hash warning

The catalog parser assumes the shape of `server_models.json`, which upstream
changes without notice. Hash the canonicalized spec at parse time and warn in
the UI when the file no longer matches what this build of TJ understands, so
a silently-misparsed catalog stops looking like a complete one.

## Sync modal: explain a blocked materialization

The Lemonade sync preview shows nothing when there is nothing it *can* do —
which reads as "all in sync" even when a catalog model is unservable because
one checkpoint sits only in cold storage. Surface those as blocked rows
("2 of 3 checkpoints local; X only in cold storage") instead of an empty
preview. Scoped out of the 2026-08-19 checkpoint-breakdown work; the
per-checkpoint machinery it needs (`componentCheckpointBreakdown`) now exists.

## Catalog breakdown: fetch a checkpoint from a peer

The checkpoint breakdown hovercard offers "Copy from cold storage" for an
archived checkpoint, but a checkpoint that exists only on another peer is
shown as information with no action. Wire the peer→local transfer flow in as
a second remedy button. Also scoped out of the 2026-08-19 work — transfers
are heavier than cold copies (browser-held fetch, progress, no navigation
while running), so it wants its own pass. Deliberately last: the Storage
split turns transfers into agent-to-agent `send` jobs, so building this on
today's browser-held flow would mean building it twice.

## Review queue

Decisions taken unilaterally during past work, each flagged for a second
opinion:
[docs/specs/2026-08-08-hf-nested-quant-downloads-open-questions.md](docs/specs/2026-08-08-hf-nested-quant-downloads-open-questions.md).
