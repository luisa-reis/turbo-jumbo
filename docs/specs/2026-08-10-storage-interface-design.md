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

  /** FastFlowLM's models exist only inside a running Lemonade; ask its binary. */
  flmModels(): Promise<FlmModel[]>;

  /** Anything that runs long enough to need progress or cancelling. */
  start(spec: JobSpec): Promise<JobHandle>;
}
```

### Jobs

Three operations take long enough that a request/response call is the wrong
shape: downloading, hashing a large file, and sending one to another agent.
They share one job API rather than three bespoke endpoints, and their events
are NDJSON — the format `lib/util/ndjson.ts` already speaks.

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
  | {kind: 'hash'; ref: Ref; algo: 'sha256'}
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

`send` is the whole peer-transfer story: the control host asks agent A to send
to agent B, agent B exposes the receiving half, and the control host watches
progress without touching a byte.

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

Remaining call sites, easiest first so an interruption lands somewhere
coherent:

1. `audit/audit.ts`, `lemonade/lemonade-sync.ts`, and `audit/fix-duplicates.ts`
   with them — fix-duplicates looked easy but its I/O is really audit.ts's
   full-path helpers (`resolveSource`, `localSha256`, `findHistoricalMatch`,
   `moveFileWithMeta`), so the two migrate together
2. `hf/hf-download-stream.ts`, `storage/file-transfer.ts` — these need the job
   API, which is specified above but not yet written in code

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

## Open questions

- **Authorization.** A shared token per agent is the floor. Worth deciding
  whether agents authenticate each other for `send`, or trust a token minted by
  the control host.
- **Lemonade's mounts.** If Lemonade runs on the host and the agent in LXC, the
  container needs its cache and extra-models directories bind-mounted.
