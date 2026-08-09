export interface DownloadCommandRequest {
  repoId: string;
  branch: string;
  filePaths: string[];
  sendToCold?: boolean;
  deleteAfterTransfer?: boolean;
}

export interface DownloadCommandContext {
  /** The repo's quantization units, when its listing was grouped into them —
   *  only pick-one repos have any (see `quantGroups`). A selection that covers
   *  whole units is named by their labels instead of file by file. */
  quants?: Array<{label: string; paths: string[]}>;
  /** Every path the repo offers, when the caller knows the listing. */
  repoPaths?: string[];
  /** The machine that should run the download, when it isn't the one serving
   *  this UI — a peer's `host:port`. */
  cliUrl?: string;
}

// Past this width the flags go on continuation lines: a shard set listed file
// by file runs to several hundred characters, which is unreadable in the
// modal's code block and worse when pasted into a terminal. Wide enough that a
// long repo id plus a quantization and the two cold-storage flags still fits on
// one line — those read worse split up than run on.
const WRAP_WIDTH = 100;

// Shell-safe form of an argument. Quantization labels and repo paths are plain
// text almost always, so quoting is applied only when the shell would otherwise
// split or interpret the argument — a bare `--quant UD-IQ3_S` reads better than
// a quoted one.
function shellArg(s: string): string {
  if (/^[A-Za-z0-9_.:/@=+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `tj` command that reproduces a download request, shown in the download
 * modal's Command section and copied by its Copy command button.
 *
 * `tj get` posts to the same `/api/v1/hf-download` the Download button does, so
 * a copied run is the request, not an imitation of it: the server puts the
 * files where the scanner expects them and writes the provenance sidecar.
 *
 * How the selection is expressed follows what `tj get` itself accepts (see
 * `cli/commands/get.ts`, which selects with the picker's own functions):
 *
 *  - whole quantizations by `--quant`, the labels the modal shows;
 *  - anything narrower by `--file`, the repo-relative paths;
 *  - nothing at all when the whole of a repo that isn't a menu of alternatives
 *    is taken, which is what a bare `tj get <repo>` already means. A pick-one
 *    repo never takes this form — there, a bare `tj get` prints the menu.
 *
 * A pinned revision rides in as a `tree` URL because `tj get` has no flag for
 * one; `parseHfUrl` reads the branch back out of it.
 */
export function buildTjGetCommand(
  req: DownloadCommandRequest,
  context: DownloadCommandContext = {},
): string {
  const {quants, repoPaths, cliUrl} = context;
  const base = cliUrl ? `tj --url ${shellArg(cliUrl)} get` : 'tj get';
  // `main` is the default, so a bare repo id says it; anything else needs the
  // URL form that carries a branch.
  const ref =
    req.branch === 'main'
      ? req.repoId
      : `https://huggingface.co/${req.repoId}/tree/${req.branch}`;

  const parts = [
    `${base} ${shellArg(ref)}`,
    ...selection(req, quants, repoPaths),
  ];
  if (req.sendToCold) parts.push('--to cold');
  if (req.deleteAfterTransfer) parts.push('--delete-after');

  const oneLine = parts.join(' ');
  if (oneLine.length <= WRAP_WIDTH || parts.length < 3) return oneLine;
  return parts.join(' \\\n  ');
}

/** The flags naming what to download — see the forms in `buildTjGetCommand`. */
function selection(
  req: DownloadCommandRequest,
  quants: DownloadCommandContext['quants'],
  repoPaths: DownloadCommandContext['repoPaths'],
): string[] {
  const wanted = new Set(req.filePaths);
  if (quants && quants.length > 0) {
    // Whole units only: a part-selected quantization can't be named by label
    // without pulling in files the user unticked.
    const whole = quants.filter((q) => q.paths.every((p) => wanted.has(p)));
    const covered = new Set(whole.flatMap((q) => q.paths));
    if (whole.length > 0 && covered.size === wanted.size) {
      return whole.map((q) => `--quant ${shellArg(q.label)}`);
    }
  } else if (repoPaths && repoPaths.length > 0) {
    // Not a menu of alternatives (no quantizations), and all of it is taken —
    // which is what naming the repo alone already asks for.
    if (
      repoPaths.every((p) => wanted.has(p)) &&
      wanted.size === repoPaths.length
    )
      return [];
  }
  return req.filePaths.map((p) => `--file ${shellArg(p)}`);
}
