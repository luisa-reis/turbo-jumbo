/**
 * The shape a download request must have before anything turns it into
 * filesystem paths or an `hf` argument. Shared by the route that answers 400
 * and the storage that refuses to run — the second doesn't trust the first.
 * Dependency-free so either side can import it.
 */

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;
const FILE_PATH_RE = /^[A-Za-z0-9_. /-]+$/;

// repoId/filePath become filesystem paths (the download lands at
// <base>/<repoId>/<filePath>), so a `..` segment — which the patterns above
// otherwise permit — must be rejected to keep the write inside the storage root.
function hasUnsafeSegment(p: string): boolean {
  return p.split('/').some((seg) => seg === '..');
}

export function isValidRepoId(v: unknown): v is string {
  return typeof v === 'string' && REPO_ID_RE.test(v) && !hasUnsafeSegment(v);
}

export function isValidRevision(v: unknown): v is string {
  return typeof v === 'string' && v !== '' && BRANCH_RE.test(v);
}

export function isValidFilePath(v: unknown): v is string {
  return typeof v === 'string' && FILE_PATH_RE.test(v) && !hasUnsafeSegment(v);
}
