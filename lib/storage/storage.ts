/**
 * The seam between deciding and doing.
 *
 * Everything in `lib/` that reasons about models — which quant a file belongs
 * to, what makes a duplicate, which mmproj pairs with what — needs to know
 * what is on disk, not where the disk is. This is the whole vocabulary it
 * needs: eleven verbs, derived from the call sites they replace (see
 * docs/specs/2026-08-10-storage-interface-design.md).
 *
 * Today the only implementation is local. The point of the interface is that
 * a second one can speak to an agent on another machine without a single
 * policy module knowing the difference.
 */

/** The three directories a machine holds models in. */
export type Root = 'models' | 'cold' | 'lemonade';

/**
 * A path within a root: relative, `/`-separated, never containing a `..`
 * segment. Confinement is structural — there is no way to name a path outside
 * a root, so no implementation has to remember to check.
 */
export interface Ref {
  root: Root;
  path: string;
}

export interface FileEntry {
  /** Relative to the root, `/`-separated on every platform. */
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  /**
   * For a symlink, the size and mtime of what it points to — Lemonade's
   * extra directory and the hub cache's `snapshots/` are links to weights,
   * and what anyone asks about a link is the weight behind it, never the
   * link's own byte count. A dangling link reports size 0 and `dangling`.
   */
  size: number;
  mtimeMs: number;
  /** Where a symlink points, verbatim and unresolved. Symlinks only. */
  linkTarget?: string;
  /** A symlink whose target is gone. Symlinks only. */
  dangling?: boolean;
  /**
   * The dominant tensor dtype of a `.safetensors`, when `list` was asked for
   * it. Read during the walk because that is the one moment it is cheap: a
   * caller fetching it afterwards turns one call into one per file.
   */
  dtype?: string;
}

export interface Usage {
  free: number;
  total: number;
  /**
   * Which filesystem this root sits on. Opaque — compare two for equality,
   * never interpret. Models and cold storage sharing one filesystem means
   * their free space is a single pool, which the download warnings depend on
   * knowing.
   */
  device: string;
}

/**
 * The cap on `read` and `write`. Sidecars and catalogs pass; weights do not,
 * which is what stops this interface quietly becoming a way to move a 116 GiB
 * file through JSON. Bulk data moves by job instead.
 */
export const MAX_SMALL_FILE = 8 * 1024 * 1024;

export interface ListOptions {
  /** Limit the walk to a subdirectory of the root. */
  under?: string;
  /**
   * Read the dtype of every `.safetensors` encountered. Off by default: only
   * the scan that labels weights needs it, and it costs a header read a file.
   */
  dtype?: boolean;
  /**
   * Fail instead of returning a truncated inventory when something can't be
   * read. Off by default — an inventory is worth having even with a hole —
   * but a decision like "this directory holds no weights, delete it" must
   * not mistake "couldn't look" for "nothing there". A missing directory is
   * still an empty result either way: gone is an answer.
   */
  strict?: boolean;
}

/** What `link` did (or, on a dry run, would do) at one path. */
export type LinkOutcome = 'created' | 'replaced' | 'kept' | 'skipped';

export interface RemoveOptions {
  /**
   * After removing, delete directories the removal left empty, walking up to
   * the root. What `delete-file.ts` does today so a deleted model leaves no
   * skeleton behind.
   */
  pruneEmptyDirs?: boolean;
}

/**
 * Anything that runs long enough to need progress or cancelling. Two kinds so
 * far, both of an agent's own machine: a download (the agent runs `hf`
 * through this one named verb, validating every argument — never a shell) and
 * a copy between roots, which resumes a partial destination and can be a move.
 * A cross-agent `send` is the third kind the design names; it lands with the
 * agent that receives it. Hashing is the `hash` verb — its callbacks already
 * are the progress and cancellation a job gives.
 */
export type JobSpec =
  | {
      kind: 'download';
      repoId: string;
      /** A branch, tag or commit; `main` when absent. */
      revision?: string;
      /** In-repo paths. Empty means the whole repo. */
      files: string[];
      /** The directory the files land under, at their in-repo paths. */
      into: Ref;
    }
  | {
      kind: 'copy';
      from: Ref;
      to: Ref;
      /**
       * Remove the source once the destination is complete. A move between
       * roots on one filesystem is a rename and finishes at once; across
       * filesystems it is the copy, then the delete. Either way the
       * directories it leaves empty go with it, as `remove`'s
       * `pruneEmptyDirs` takes them — a moved-out model leaves no husk of
       * hf's `.cache` bookkeeping behind.
       */
      move?: boolean;
    };

export type JobEvent =
  /** Bytes so far; `total` when the job knows it. Throttled, never per chunk. */
  | {kind: 'progress'; done: number; total: number | null}
  /** Output as it arrives — a tool's stderr, verbatim. */
  | {kind: 'log'; line: string}
  /** The job ran to its end; `result` is the kind's own record. */
  | {kind: 'done'; result: unknown}
  /** The job could not run or broke off. Terminal, like `done`. */
  | {kind: 'error'; message: string};

/** What a finished `download` job reports. A non-zero exit is still `done`:
 *  the tool ran, and what its code means is the caller's to say. */
export interface DownloadResult {
  exitCode: number | null;
  signal: string | null;
  /** The tool's stdout — `hf --json`'s one-line record. */
  output: string;
}

/** What a finished `copy` job reports. */
export interface CopyResult {
  /** The byte the stream started at: 0 for a fresh copy, the verified prefix
   *  of a resumed one, the whole size when a move was a rename. */
  resumedFrom: number;
  size: number;
}

export interface JobHandle {
  id: string;
  /** The job's events, ending with `done` or `error`. Read once. */
  events(): AsyncIterable<JobEvent>;
  cancel(): Promise<void>;
}

export interface Storage {
  /**
   * Recursive inventory. The only traversal verb. Symlinks are reported, not
   * followed: descending into one would inventory the same weights twice.
   */
  list(root: Root, opts?: ListOptions): Promise<FileEntry[]>;

  /** A small file — a sidecar, a catalog. Throws past `MAX_SMALL_FILE`. */
  read(ref: Ref): Promise<Uint8Array>;

  /** A small file, creating parent directories. Throws past `MAX_SMALL_FILE`. */
  write(ref: Ref, bytes: Uint8Array): Promise<void>;

  mkdir(ref: Ref): Promise<void>;

  /** Bulk: deleting a model is one call, not one per shard. */
  remove(refs: Ref[], opts?: RemoveOptions): Promise<void>;

  /** Rename. Across roots is allowed; across machines is a job. */
  move(from: Ref, to: Ref): Promise<void>;

  copy(from: Ref, to: Ref): Promise<void>;

  /**
   * Bulk symlink creation, for Lemonade's extra-models directory. Replaces a
   * link pointing elsewhere, keeps a correct one, and never touches a real
   * file — that is somebody's own model, not ours to swap for a link. With
   * `dryRun` nothing changes and the outcomes say what a real run would do,
   * so a sync preview is a dry run of the sync and the two can't disagree.
   */
  link(
    links: Array<{target: Ref; at: Ref}>,
    opts?: {dryRun?: boolean},
  ): Promise<LinkOutcome[]>;

  usage(root: Root): Promise<Usage>;

  /**
   * The SHA-256 of a file, however large — the one read that may cross
   * `MAX_SMALL_FILE`, because it never hands the bytes back. This is the
   * hash job of the design in its in-process form: `signal` cancels it and
   * `onBytes` reports each chunk hashed, which is all a progress bar needs.
   * A remote implementation runs it as a job underneath.
   */
  hash(
    ref: Ref,
    opts?: {signal?: AbortSignal; onBytes?: (n: number) => void},
  ): Promise<string>;

  /** Start a job (see `JobSpec`). Resolves once it is running, not done. */
  start(spec: JobSpec): Promise<JobHandle>;
}
