# The `Storage` interface

## Why

Turbo Jumbo runs the whole app on every machine that holds models. Each peer
carries the UI, its build, a Bun runtime and `node_modules`, to do work that is
almost entirely `readdir` and `rename`. The intended shape is one UI host and a
thin agent per storage box, small enough for a scanty LXC container.

The measurement that makes this cheap: inside the modules that touch the
filesystem, the I/O is a rounding error.

| module                       | fs lines | total |
| ---------------------------- | -------: | ----: |
| `lemonade/lemonade-sync.ts`  |       24 |   732 |
| `audit/audit.ts`             |        7 |   709 |
| `models/models.ts`           |        6 |   473 |
| `models/model-sidecar.ts`    |        5 |   390 |
| `audit/incomplete-models.ts` |        2 |   308 |

Forty-four lines of I/O carrying 2,612 lines of policy, and 19 fs-touching
modules totalling 4,755 lines across `lib/`. What decides — which quant a file
belongs to, what makes a duplicate, which mmproj pairs with what, how a model
gets its name, what Lemonade's extra directory should contain — never needs to
know where the bytes are. Only the verbs below do.

So the split is not a port of `app/api`. It is this interface, a local
implementation that behaves exactly as today, and an HTTP implementation
backed by an agent.

## Design rules

These are what keep the interface small and the agent safe. Each one is a
constraint the verbs below are built to satisfy.

1. **No absolute paths.** Every path is relative to a named root. Confinement
   is structural rather than a validation step someone can forget.
2. **No generic `exec`.** The agent runs `hf` and `flm` through named verbs
   with validated arguments. An agent that can run arbitrary commands is a
   different security proposition from one that can list and move files.
3. **One call per intent.** `list` is the only traversal, and it returns
   everything labelling a file needs — including the dtype of a tokenless
   `.safetensors`, read while the walk is already standing on the file. A
   design that fetches that separately turns one call into N.
4. **Bulk by default.** Anything that can take several paths takes an array.
   Deleting a model is one call, not one per shard.
5. **Small reads and writes are capped.** Sidecars and config move through
   `read`/`write`; weights only ever move through jobs. The cap is what stops
   the interface being quietly used to stream a 116 GiB file over JSON.
6. **Bytes never traverse the UI host.** A copy is the control host telling
   agent A to send to agent B. This retires the backpressure hazard by
   construction rather than by remembering to forward instead of proxy.

## Roots

An agent is configured with named roots and knows nothing else about the
fleet — no peer list, no model knowledge.

| root       | what it is                               |
| ---------- | ---------------------------------------- |
| `models`   | `<base_path>/turbo-jumbo`, fast storage  |
| `cold`     | `<cold_storage_path>`, archival          |
| `lemonade` | `<base_path>/lemonade`, Lemonade's cache |

```ts
export type Root = 'models' | 'cold' | 'lemonade';

/** A path within a root. Relative, and never containing a `..` segment. */
export interface Ref {
  root: Root;
  path: string;
}
```

## The interface

```ts
export interface FileEntry {
  /** Relative to the root, using `/` on every platform. */
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  /**
   * For a symlink, the size and mtime of what it points to: Lemonade's extra
   * directory and the hub cache's `snapshots/` are links to weights, and what
   * anyone asks about a link is the weight behind it. A dangling link reports
   * size 0 and `dangling`.
   */
  size: number;
  mtimeMs: number;
  /** Where a symlink points, verbatim. Only for `kind: 'symlink'`. */
  linkTarget?: string;
  /** A symlink whose target is gone. Only for `kind: 'symlink'`. */
  dangling?: boolean;
  /**
   * The dominant tensor dtype of a `.safetensors` whose filename carries no
   * quant token — the only case `weightLabel` needs it. Read from the header
   * during the walk, because that is the one moment it is cheap.
   */
  dtype?: string;
}

export interface Usage {
  free: number;
  total: number;
}

export interface Storage {
  /**
   * Recursive inventory. The only traversal verb. `dtype` reads safetensors
   * headers during the walk; `strict` fails on an unreadable entry instead
   * of returning a truncated inventory — for callers whose next move is a
   * delete, where "couldn't look" must never read as "nothing there".
   */
  list(
    root: Root,
    opts?: {under?: string; dtype?: boolean; strict?: boolean},
  ): Promise<FileEntry[]>;

  /** A small file — sidecars, `server_models.json`. Fails past the cap. */
  read(ref: Ref): Promise<Uint8Array>;

  /** A small file, creating parent directories. Fails past the cap. */
  write(ref: Ref, bytes: Uint8Array): Promise<void>;

  mkdir(ref: Ref): Promise<void>;

  /** Bulk. `pruneEmptyDirs` walks up removing directories left empty. */
  remove(refs: Ref[], opts?: {pruneEmptyDirs?: boolean}): Promise<void>;

  /** Rename within an agent. Across roots is allowed; across agents is `send`. */
  move(from: Ref, to: Ref): Promise<void>;

  copy(from: Ref, to: Ref): Promise<void>;

  /**
   * Bulk symlink creation, for Lemonade's extra-models directory. Replaces a
   * link pointing elsewhere, keeps a correct one, never touches a real file,
   * and reports what it did (or, with `dryRun`, would do) per path — so a
   * sync preview is a dry run of the sync and the two can't disagree.
   */
  link(
    links: Array<{target: Ref; at: Ref}>,
    opts?: {dryRun?: boolean},
  ): Promise<Array<'created' | 'replaced' | 'kept' | 'skipped'>>;

  usage(root: Root): Promise<Usage>;

  /**
   * The SHA-256 of a file of any size, with cancellation and per-chunk
   * progress: the hash job in its in-process form. A remote implementation
   * runs it as a `start({kind: 'hash'})` job underneath.
   */
  hash(
    ref: Ref,
    opts?: {signal?: AbortSignal; onBytes?: (n: number) => void},
  ): Promise<string>;

  /** FastFlowLM's models exist only inside a running Lemonade; ask its binary. */
  flmModels(): Promise<FlmModel[]>;

  /** Anything that runs long enough to need progress or cancelling. */
  start(spec: JobSpec): Promise<JobHandle>;
}
```

### Jobs

Three operations take long enough that a request/response call is the wrong
shape: downloading, copying a large file, and sending one to another agent.
They share one job API rather than three bespoke endpoints, and their events
are NDJSON — the format `lib/util/ndjson.ts` already speaks. (Hashing was
going to be the fourth; it became the `hash` verb above, whose callbacks are
already a job's progress and cancellation.)

```ts
export type JobSpec =
  | {
      kind: 'download';
      repoId: string;
      revision?: string;
      /** In-repo paths. Empty means the whole repo. */
      files: string[];
      into: Ref;
    }
  | {
      kind: 'copy';
      from: Ref;
      to: Ref;
      /** Remove the source once the destination is whole — a rename when
       *  the roots share a filesystem. */
      move?: boolean;
    }
  | {
      kind: 'send';
      from: Ref;
      to: {agent: string; ref: Ref};
      /** Resume point. `file-transfer.ts` already appends from an offset. */
      offset?: number;
    };

export type JobEvent =
  | {kind: 'progress'; done: number; total: number | null}
  | {kind: 'log'; line: string}
  | {kind: 'done'; result: unknown}
  | {kind: 'error'; message: string};

export interface JobHandle {
  id: string;
  events(): AsyncIterable<JobEvent>;
  cancel(): Promise<void>;
}
```

`copy` is the same-agent transfer — every `streamCopyResumable` caller turned
out to be a local↔cold move on one machine, with a progress bar the user
watches — and resumes a partial destination. `send` is the whole
peer-transfer story: the control host asks agent A to send to agent B, agent
B exposes the receiving half, and the control host watches progress without
touching a byte. It is the one kind not yet in code, since it needs the agent.

A download job reports no progress of its own: `hf --json` prints none, and
the bytes on disk are what `list` already answers, so the control host polls
the inventory of the directory the download lands in and draws the bar
itself — one call a second, the same for a local storage and a remote one.

## Where the current call sites land

| today                                                                      | verb                       |
| -------------------------------------------------------------------------- | -------------------------- |
| `readdirSync` / `readdir`, `stat`, `lstat`, `readlink`, safetensors header | `list`                     |
| `readFile` (sidecars, config)                                              | `read`                     |
| `writeFile` (sidecars)                                                     | `write`                    |
| `mkdir`                                                                    | `mkdir`                    |
| `rm`, `rmdir`, `unlink`, `delete-file.ts` pruning                          | `remove`                   |
| `rename` (audit fix, `lemonade-place`)                                     | `move`                     |
| `copyFile` (audit)                                                         | `copy`                     |
| `symlink` (`lemonade-extra`)                                               | `link`                     |
| `statfs` (`disk-usage.ts`)                                                 | `usage`                    |
| `spawn('hf', …)`                                                           | `start({kind:'download'})` |
| `createHash` over a weight                                                 | `start({kind:'hash'})`     |
| `createReadStream`/`createWriteStream` (`file-transfer.ts`)                | `start({kind:'send'})`     |

## What stays on the UI host

Not everything in an fs-touching module belongs to the agent.

- **Hugging Face API calls.** `hf-infer`, `repo-files`, `repo-card` are network
  reads. They resolve fine from the control host and want no agent.
- **Config.** `lib/config/index.ts` reads `config.yaml` to learn the fleet. In
  the new shape only the UI host has a fleet; an agent reads its own roots from
  its own config. The startup rule that a peer must match its own address
  against the peer list stops existing.
- **`app-version.ts`'s git exec.** The control host reports its own version; an
  agent reports a version string it was built with.
- **All policy.** Every module in the table at the top keeps its 700-odd lines
  and loses its 7.

## Migration

The first step is worth doing whether or not an agent is ever written:

1. Define the interface and a `LocalStorage` that wraps `fs` and behaves
   exactly as today.
2. Route the call sites through it. Tests gain a fake in place of temp
   directories, which is a straight improvement.
3. Add `HttpStorage` and the agent behind it.
4. Cut peers over one at a time. A peer still running the full app and an
   agent behind `HttpStorage` are the same thing to every caller, so the fleet
   can be mixed while the migration runs.

At no point is there a non-working system, and the 13,328 lines of tests in
`lib/` survive, because the code they test does not move.

### Where step 2 has got to

Done:

- The interface and `LocalStorage`, with `storage-instance.ts` as the single
  place that decides which implementation is real.
- `disk-usage.ts` and both disk-usage routes. This is what added `device` to
  `Usage`: `downloadDiskUsage` needs to know whether two roots share a
  filesystem, and `statfs` alone does not say.
- `delete-file.ts` and its three routes. This taught the local prune the
  hf-CLI `.cache`-counts-as-empty rule, and added `strict` to `list` so the
  weightless-directory cleanup can tell "no weights" from "couldn't look".
- `models/tjmeta.ts` and `models/model-sidecar.ts`, via the transitional
  `Site` union (`lib/storage/site.ts`): every `basePath` parameter now also
  accepts `{storage, root}`, the string arm wrapping the path in a throwaway
  local storage. The fifty-odd existing call sites compile untouched, and
  each caller's own migration step is just swapping the argument — as
  `delete-file.ts` already has, dropping its transitional `basePath`.
  `site.ts` and the string arm are deleted when the last caller migrates.
  (`readMeta`/`writeMeta`/`updateMeta`/`metaPath` keep their full-path forms
  for the two remaining absolute-path callers, `audit.ts` and
  `copy-meta.ts`, which own them in their own steps.)

- `support-files.ts` and `recorded-digest.ts`, on the same `Site` union.
  `expandSupportFiles` filters one `list` instead of walking; `recordedSha256`
  takes the file's and the sidecar's mtimes from a single `list` of the model
  directory, since the interface deliberately has no `stat` verb.
- `lemonade-extra.ts` and `lemonade-place.ts`. This upgraded `link` to return
  per-path outcomes, take `dryRun`, and never touch a real file — the sync
  preview is now literally a dry run of the sync, which fixed an actual
  preview/executor disagreement about a user's file occupying a link's path.
  `ExtraLink.target` and `Placement.from`/`to` became root-relative.
- `models/models.ts` and `annotateColdStorage`, on the `Site` union. The scan
  is one `list` with `dtype`; the sidecars it consults are located from that
  inventory and read once each; and the whole thing became async, which is
  what turned its twenty callers and the two server components async with
  it. Two things the old walk did implicitly moved into `list`: a symlink
  reports its target's size and a `dangling` flag (the scan used to
  `statSync` through the links in Lemonade's extra directory and the hub
  cache's `snapshots/`), and the `readdirSync` spy the representative-shard
  test leaned on became a `Storage` whose `list` answers in another order.
  Verified by dumping both scanners over this machine's real roots: the JSON
  is byte-identical.
- The inventory cache, in `LocalStorage`, in the two forms that cannot go
  stale: a safetensors header's dtype is remembered against the file's size
  and mtime, and identical `list` calls in flight share one walk (a mutating
  verb forgets its root's in-flight walks first). A cached inventory with a
  lifetime was considered and not built — the `hf` CLI, a peer's transfer and
  a user's shell all write behind the interface's back, so any lifetime is a
  window in which a just-finished download or a just-moved file shows wrong.
  Measured warm on this machine (virtiofs local, NFS cold): local unchanged,
  cold three times faster, the page-load burst of three concurrent scans five
  times faster. The transitional string arm of `Site` keeps one
  `LocalStorage` per directory so its callers share the memo too.
- `audit/audit.ts`, `audit/fix-duplicates.ts` and `lemonade/lemonade-sync.ts`,
  as one step, since fix-duplicates' I/O was audit.ts's helpers all along.
  Every helper takes a `Site` and a root-relative path; `resolveSource` lost
  the full path it used to recover its base from. Two additions to the
  interface: `hash` (above), because a `{storage, root}` site has no
  absolute path to stream, and an `EXDEV` fallback in `LocalStorage.move`,
  since lemonade-sync moves files between the `lemonade` and `models`
  roots. Sizes and existence come from `lib/storage/entries.ts` — a `list`
  of the parent directory, there being no `stat` — and lemonade-sync takes
  one inventory per root up front instead of a stat per file, re-listing
  between its two passes. Its `LemonadeSides` are now paths within the
  `lemonade` root (`builtin`, `extra`, `''`); the cache _scan_ keeps
  absolute directories under its own `LemonadeCacheDirs`. `copyFileWithMeta`
  moved to `storage/copy-meta.ts` beside the transfer core it wraps, still on
  absolute paths, so `audit.ts` carries no `fs` import without touching the
  job API's territory; `audit.ts` keeps re-exporting it.
- The job API, for `hf/hf-download-stream.ts`: `start(spec)` on the
  interface, `download` and `copy` jobs in `lib/storage/local-jobs.ts`
  (the `send` kind waits for the agent it needs; `hash` stayed a verb). The
  download job owns the `hf` spawn and validates its arguments itself —
  `lib/hf/download-request.ts` holds the predicates both it and the route's
  400s use — and reports hf's stderr as `log` events and its exit as `done`;
  the host draws the progress bar from a `list` of the landing directory a
  second, as the Jobs section says. The copy job wraps `streamCopyResumable`
  with throttled progress and a `move` that is a rename on one filesystem, so
  the post-download cold transfer is one job per file; the legacy sidecar
  follows through `move`/`copy`. `hf-download-stream.ts` has no `fs` or
  `child_process` import left; `file-transfer.ts` keeps its streams as part
  of the storage implementation, which is where the table at the top always
  put them.

- `models/repo-files.ts` and `audit/incomplete-models.ts`, whose Hugging
  Face reads stay on the host but whose presence checks were an `existsSync`
  and a `statSync` per expected file: each is now one `list` of the model
  directory (`entriesUnder` in `lib/storage/entries.ts`) answering presence
  and size for the whole tree. A prune shared between `remove` and the copy
  job's `move` (`lib/storage/prune.ts`) arrived alongside, after a
  download moved to cold storage was found leaving its local directory
  standing with nothing but hf's `.cache` in it.

- The cold-storage transfer routes (`cold-storage/to-local`, `from-local`),
  on one `copy` job per file: same NDJSON fields, same 8 MiB emit cadence,
  same 400s, and the resume a partial destination gets. `copy-meta.ts`'s
  provenance helpers take a `Site` now (`updateMetaAt` in `tjmeta.ts` for
  the no-repo branch), so every caller of `propagateFileMeta` can hand it a
  root rather than a directory.

Remaining call sites:

None. Steps 1–3 are complete, the Rust agent included. What remains is
step 4 — cutting peers over to thin agents one at a time
(`agent_address` in their peer entries), which needs the host to answer
a peer's models table, downloads and audits through `HttpStorage`
where today it asks the peer's app, plus the lifetime-bearing
inventory cache in the agent that makes those remote walks usable —
and retiring `lib/storage/site.ts`'s transitional string arm when the
last caller passes a real site. `lib/config` stays on the host.

### Where step 3 has got to

- The wire, in three pieces. `agent-protocol.ts` fixes the encodings
  (JSON for the verbs; raw bytes for `read`/`write`; NDJSON for hash
  frames and job events, cancelled by closing the connection — which is
  what abandoning a local handle already meant). `agent-handlers.ts`
  serves every verb and job kind as plain Request → Response with no
  framework in it, and `HttpStorage` (`http-storage.ts`) speaks it back
  as a `Storage`. The full app mounts the handlers at
  `/api/v1/storage/[op]`, so a peer running all of Turbo Jumbo already
  answers as an agent — the sameness the mixed fleet of step 4 rests
  on. Conformance-tested over an in-process fetch: confinement, the
  small-file cap at both ends, dtype inventories byte-identical to the
  local walk, link dry runs, hash progress and abort, and copy jobs
  with their resume.

- The `send` job and its `receive` endpoint. The third job kind is run
  by the machine holding the file: it proves the far side's partial
  with the same hash-compare a local resume uses — the target's `hash`
  verb over the wire against its own matching region — then streams
  8 MiB chunks to the target agent's `receive`, whose offset check
  refuses to splice into a file that changed since. Two deviations from
  the sketch above: `to` is `{agent, token?, ref}` — the protocol URL
  and bearer token handed along by whoever built the spec, the control
  host trusting its own config — and there is no caller-supplied
  `offset`, because a resume point is verified, never asserted. Jobs
  also grew a `verify` event for the hash-compare stretch, which the
  copy job now reports too, so a driving route can label the wait.
  Tested with two in-process agents: fresh sends, proven and refused
  resumes, an already-complete destination sending nothing, and a
  control host driving A→B while holding none of the bytes.

- The peer-to-peer copy, on the wire. `/api/v1/copy` now speaks entirely
  in sites and jobs: every (file, destination) leg is one job on the
  machine that holds the bytes — a cold end pairs onto the other end's
  machine as a local copy job there (the archive is one shared mount),
  and two different machines' models roots are a `send` — and the route
  relays job events into the same NDJSON frames the clients already
  read, phases and resume labels included. Provenance travels as
  `propagateFileMeta` between any two sites, delete-after-copy is
  `deleteFileWithMeta` on whichever storage owns the source (local
  sources now get the same sidecar-and-husk cleanup remote ones always
  had), and `copy/check` answers sizes from one inventory entry,
  recorded digests from sidecars wherever they sit, and computed ones
  from the far machine's own `hash`. Support files expand through
  `expandSupportFiles` over any site. Retired with their callers:
  `local-models/push`, `upload`, `download`, `checksum`, `file-meta`,
  `support-files`, `cold-storage/to-local`, `from-local`,
  `sendFileMeta`, `copyFileWithMeta`, and peer-resume's endpoint-backed
  reader. Agents also carry fs error codes across the wire
  (`x-tj-error-code`), so a remote ENOENT stays an ENOENT to the
  sidecar readers' tolerance checks.

- The standalone agent. `agent/server.ts` is the same handlers behind a
  bare `Bun.serve` — no Next, no UI build, no fleet knowledge — guarded
  by one bearer token from its own config (`agent/index.ts`,
  `agent.yaml.sample`), run as `bun run agent`. On the control host a
  peer entry's `agent_address`/`agent_token` point `storageForPeer` —
  and the send specs it builds — at the agent instead of the full app;
  the token is a secret like the Lemonade key, held off the `Peer`
  object. Exercised over real sockets in tests: the verbs, 401s for a
  missing or wrong token, streamed hashes, and an agent-to-agent send
  with resume — the design's end state in miniature.
  (It served as the reference implementation until the Rust agent
  reached parity, then retired.)

- The Rust agent, complete. Every op and job kind, landed slice by
  slice, each gated on the conformance suite
  (`agent/rust-agent.test.ts`) that spawns the compiled binary on real
  sockets and holds it to `createLocalStorage`'s answers — closing
  with the TS reference and the Rust binary sending into each other's
  receive endpoints, both directions, byte-identical at rest. With
  parity reached the TS agent retired (`agent/*.ts` gone; the lib
  handlers stay, serving the full app's own `/api/v1/storage`).
  Deployment is bare metal by decision: a release binary and a
  systemd user unit (`deploy/tj-agent.service`), no container.

### Where step 4 has got to

- The peer views, over the agent. Every `peers/[slug]` route that
  asked the peer's app grew an agent branch, taken when the peer has
  an `agent_address`: the models scan (cold annotation included, when
  the agent has a cold root), deletes with the full sidecar-and-husk
  cleanup, incomplete/invalid and repo-files (their Hugging Face
  reads were always the host's own), and disk usage, which probes
  each root and reads "not configured" as absence. The peer monitor
  polls an agent's liveness — nearly free — and runs the scan only on
  the transition to up, when the peer-up event needs it; the version
  chip reads the agent's own /api/v1/version (the crate version,
  never "dev"). Conformance-tested by running scanModels and
  deleteFileWithMeta whole over the agent's storage, equal to their
  local answers. Still asking the peer's app: downloads, audits and
  Lemonade — the next slices.

- Downloads, over the agent. `streamHfDownload` takes a
  `DownloadTarget` — this host's storage by default, an agent peer's
  from the download proxy — and everything inside follows it: the
  `hf` spawn (the agent's machine, whose environment carries the
  CLI), the once-a-second progress poll of the landing directory,
  the sidecar pass, and the optional cold transfer. Which roots the
  agent has is probed, as everywhere. The conformance suite runs a
  download job end to end against a stand-in `hf` on the agent's
  PATH — argv, spawn, stderr into log events, exit into the done
  record, bytes on disk.

## Decided

- **Live with `hf`.** The agent image carries Python and `huggingface_hub`.
  Losing Xet on 100 GiB pulls costs more than the megabytes save, and routing
  every download through one fat box doubles traffic for a model wanted
  elsewhere. "Scanty" means no Node, no Next, no UI build — not no Python.
- **Cache the inventory.** Worth doing for its own sake, before any agent
  exists: the scan is uncached today, so every models-table request re-walks
  the tree and re-reads safetensors headers. Invisible on local disk, and the
  thing that would make a remote walk unusable. It belongs with the
  `models.ts` migration, and the cache lives with whoever owns the
  filesystem — the agent — rather than the UI host caching responses. Done
  for the local case in the stale-proof form described under step 2; the
  lifetime-bearing inventory a remote walk needs belongs to the agent and
  lands with `HttpStorage`.

- **Shared mounts already cover Lemonade beside an agent.** The model
  directories are shared mounts presented identically to the host and
  its containers — how the fleet runs today — so an agent in LXC and a
  Lemonade on the host see the same cache and extra-models directories
  with nothing extra to bind-mount.

- **The production agent is Rust on Tokio.** Bun proved the protocol
  but is the wrong weight for a scanty container, so the agent is
  being rewritten as a single static binary: axum over tokio for the
  server, serde for the wire, sha2 for digests, reqwest for a send's
  outbound legs, tokio::process for the `hf` spawn, rustix for
  statfs. The TS agent (`agent/*.ts`) stays as the reference
  implementation until the Rust one passes the same conformance
  suites, which become the protocol's contract — the wire is the
  seam, so the host (HttpStorage, the copy route, the full app still
  serving /api/v1/storage for mixed fleets) does not change at all.
  Two consequences accepted: storage semantics live twice (TS for
  the app, Rust for the agent), refereed by the conformance tests;
  and Python still rides along for `hf` downloads — "no JS" is not
  "no Python" — with Rust-native xet-core noted as a possible later
  retirement of that too.
- **`list` order is unspecified.** With one implementation, both ends
  of a compare shared a single walk; with two, byte-order equality
  would pin readdir order across languages for no caller's benefit —
  the policy modules already tolerate any order. Callers must not
  depend on it, and conformance assertions compare sorted.

## Open questions

None right now: authorization and Lemonade's mounts are settled under
Decided.
