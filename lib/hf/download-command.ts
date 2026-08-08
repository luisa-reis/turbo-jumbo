import {MODEL_SIDECAR_NAME, type TjModel} from '@/lib/models/sidecar-types';

export interface DownloadCommandRequest {
  repoId: string;
  branch: string;
  filePaths: string[];
}

/**
 * The shell script that reproduces a download by hand, shown in the download
 * modal's Command section: change into the models directory, fetch the files,
 * then write the provenance sidecar.
 *
 * The `cd` isn't decoration. The server downloads into `<models>/<repoId>` (see
 * `streamHfDownload`), because the audit and the scanner both identify a model
 * by that path — the same file landing at the storage root is named for its
 * filename instead of its repo. Standing in the models directory lets
 * `--local-dir` name the repo, so a copied run puts files exactly where the app
 * would have.
 *
 * The sidecar is staged in /tmp and copied into place, so the one step that
 * needs write access to the models directory is a single `cp` a user can re-run
 * under whatever account owns that mount.
 *
 * It is written with an empty `files` array — the same shape `setModelRevision`
 * creates before any file is verified. That is enough for the model to be
 * identified as coming from its repo; a subsequent audit records each file's
 * size and checksum, which is the only way to get them, since the checksums
 * aren't known until the files are hashed on disk.
 */
export function buildDownloadScript(
  req: DownloadCommandRequest,
  modelsDir: string,
): string {
  const includes = req.filePaths.map((fp) => `--include "${fp}"`).join(' ');
  const sidecar: TjModel = {
    modelUrl: `https://huggingface.co/${req.repoId}`,
    repoId: req.repoId,
    // `main` is the default and is deliberately left unrecorded, matching
    // setModelRevision — an absent revision means main.
    ...(req.branch === 'main' ? {} : {revision: req.branch}),
    files: [],
  };
  const tmp = '/tmp/tjmodel.json';

  return [
    `cd "${modelsDir}"`,
    ``,
    `hf download ${req.repoId} ${includes} --local-dir "${req.repoId}" --revision ${req.branch}`,
    ``,
    `# Provenance sidecar. Staged in /tmp so the copy below is the only step`,
    `# needing write access to the models directory.`,
    `cat > ${tmp} <<'JSON'`,
    JSON.stringify(sidecar, null, 2),
    `JSON`,
    `cp ${tmp} "${req.repoId}/${MODEL_SIDECAR_NAME}"`,
    ``,
    `# Then run an audit in Turbo Jumbo to record each file's size and checksum.`,
  ].join('\n');
}
