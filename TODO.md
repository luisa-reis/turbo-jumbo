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
"Where step 2 has got to". Done so far: the interface, `LocalStorage` (with
its header memo and shared walks), `storage-instance.ts`, disk usage, delete,
the sidecars, support files, the Lemonade link and place passes, the models
scan, the audit helpers with duplicate fixing, the Lemonade sync, and the job
API with the download and copy jobs behind `hf-download-stream.ts`. Next: the
presence checks in `incomplete-models.ts`/`repo-files.ts`, then the
byte-streaming routes onto the copy job — or straight to step 3, the agent.

## Keep the standalone build from tracing the repo root

`next build` warns that `lib/hf/hf-download-stream.ts` joins a path it can't
scope statically, and in response traces the whole repo root into
`.next/standalone` — `config.yaml` and `hf_token.txt` included. `bin/deploy.sh`
ships an allow-list so nothing secret leaves the machine, but the output
itself still holds copies, and anyone running `bun run build` for another
purpose gets them too. Scope the join (`path.join(process.cwd(), 'data', …)`
style) or mark it `/*turbopackIgnore: true*/` as the warning suggests, then
check the standalone output no longer contains either file.

## Lemonade browser: show the selected model with radio buttons

Selecting a model in the download UI (Add model → From Lemonade) isn't very
clear: rows are plain list items that pick up a highlight when clicked, with
no control that says "one of these is chosen" the way the checkboxes in the
models table do. Put a radio button on each row — catalog, collection and FLM
rows alike — so the current selection is obvious and the single-choice
semantics read from the widget itself. Rows live in
`components/lemonade/catalog-rows.tsx` and the FLM section of
`components/lemonade/lemonade-browser.tsx`; selection state is already a
single `Selection` value there. Astryx's single-choice widget is `RadioList`
(`bunx astryx component RadioList`); start from that, or its per-option input
if the rows must stay `List`/`ListItem`.

## An affordance to update `hf` by running `hf update`

Hugging Face downloads shell out to the `hf` CLI, and its version is neither
shown nor updatable from the app — today it means a shell on each machine.
Add a control that runs `hf update` (the CLI picks the right method for how
it was installed — the curl installer in the `Dockerfile`, pip, uv, …) and
show the current version next to it (`hf version`, plain `version=1.28.0`
output), so the header or a settings spot says what every peer is running
and whether it moved. It has to run on the peer that does the downloading,
so it wants a route under `app/api/v1/` proxied per peer like the rest of
`peers/[name]/*`, streaming the command's output the way
`lib/hf/hf-download-stream.ts` spawns `hf`. In Docker the update lands in the
running container only — a rebuild restores the image's version — which the
control should say rather than leave to be discovered.

## Lemonade catalog spec-hash warning

The catalog parser assumes the shape of `server_models.json`, which upstream
changes without notice. Hash the canonicalized spec at parse time and warn in
the UI when the file no longer matches what this build of TJ understands, so
a silently-misparsed catalog stops looking like a complete one.

## Sync modal: explain a blocked materialization

The Lemonade sync preview shows nothing when there is nothing it _can_ do —
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
