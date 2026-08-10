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
  size: number;
  mtimeMs: number;
  /** Where a symlink points, verbatim and unresolved. Symlinks only. */
  linkTarget?: string;
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
}

export interface RemoveOptions {
  /**
   * After removing, delete directories the removal left empty, walking up to
   * the root. What `delete-file.ts` does today so a deleted model leaves no
   * skeleton behind.
   */
  pruneEmptyDirs?: boolean;
}

export interface Storage {
  /** Recursive inventory. The only traversal verb. */
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

  /** Bulk symlink creation, for Lemonade's extra-models directory. */
  link(links: Array<{target: Ref; at: Ref}>): Promise<void>;

  usage(root: Root): Promise<Usage>;
}
