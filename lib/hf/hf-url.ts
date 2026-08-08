export type ParsedUrl = {
  repoId: string;
  branch: string;
  /** The directory the reference sits in, at full depth (`split_files/vae`), or
   *  null at the repo root. For a `tree` URL this is the folder itself. */
  folder: string | null;
  filename: string | null;
};

/**
 * Parse a Hugging Face reference into its repo, branch, optional folder and
 * file. Accepts a bare `org/repo`, a repo URL, a `blob|tree/<branch>` URL, a
 * `blob|resolve/<branch>/<path>` file URL, and a `tree/<branch>/<path>` folder
 * URL — the form the site gives you for a repo that keeps each quantization in
 * its own directory. Returns null when the string isn't a recognizable HF
 * reference.
 */
export function parseHfUrl(url: string): ParsedUrl | null {
  const s = url.trim().replace(/\/+$/, '');

  // A tree URL with a path names a directory, so the whole path is the folder
  // and there is no file to preselect.
  const folderMatch = s.match(
    /^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)\/tree\/([^/]+)\/(.+)$/,
  );
  if (folderMatch) {
    return {
      repoId: folderMatch[1],
      branch: folderMatch[2],
      folder: folderMatch[3],
      filename: null,
    };
  }

  const fileMatch = s.match(
    /^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(blob|resolve)\/([^/]+)\/(.+)$/,
  );
  if (fileMatch) {
    const repoId = fileMatch[1];
    const branch = fileMatch[3];
    const filePath = fileMatch[4];
    // The whole directory path, not just its first segment: a file under
    // `split_files/vae/` lives in that folder, and listing `split_files` alone
    // wouldn't find it.
    const slashIdx = filePath.lastIndexOf('/');
    const folder = slashIdx !== -1 ? filePath.slice(0, slashIdx) : null;
    const filename = filePath.slice(slashIdx + 1);
    return {repoId, branch, folder, filename};
  }

  const blobRootMatch = s.match(
    /^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(?:blob|tree)\/([^/]+)$/,
  );
  if (blobRootMatch) {
    return {
      repoId: blobRootMatch[1],
      branch: blobRootMatch[2],
      folder: null,
      filename: null,
    };
  }

  const repoUrlMatch = s.match(
    /^https?:\/\/huggingface\.co\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
  );
  if (repoUrlMatch) {
    return {
      repoId: repoUrlMatch[1],
      branch: 'main',
      folder: null,
      filename: null,
    };
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
    return {repoId: s, branch: 'main', folder: null, filename: null};
  }

  return null;
}
