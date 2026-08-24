import nodePath from 'path';

/**
 * A root-relative path as an absolute one, confined to `dir`.
 *
 * Two checks, deliberately belt and braces: the segment rules reject the
 * paths that could escape, and the prefix check catches anything the rules
 * missed. A traversal bug here is the whole confinement story — which is why
 * this lives in one module that `LocalStorage` and the agent's byte endpoints
 * share, instead of each keeping its own copy.
 */
export function resolveRef(dir: string, relPath: string): string {
  if (nodePath.isAbsolute(relPath)) {
    throw new Error(`Path must be relative to its root: ${relPath}`);
  }
  if (relPath.split('/').some((seg) => seg === '..')) {
    throw new Error(`Path must not climb out of its root: ${relPath}`);
  }
  const full = nodePath.resolve(dir, relPath);
  const base = nodePath.resolve(dir);
  if (full !== base && !full.startsWith(base + nodePath.sep)) {
    throw new Error(`Path resolves outside its root: ${relPath}`);
  }
  return full;
}
