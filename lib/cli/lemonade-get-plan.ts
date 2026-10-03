// Planning for `tj lemonade get`: which catalog entry a name refers to, and
// which files a download of it should fetch. Pure — the command supplies the
// catalog, the repo listing and the target's inventory, and turns the result
// into a request. The resolvers are the ones the download modal itself uses,
// so what the CLI fetches and what the dialog fetches cannot drift apart.

import type {FlmModel, FlmSource} from '@/lib/lemonade/flm';
import type {
  LemonadeComponent,
  LemonadeModel,
} from '@/lib/lemonade/lemonade-types';
import {
  matchVariantFiles,
  missingVariantFiles,
  planRepoJobs,
  resolveCheckpointFiles,
} from '@/lib/lemonade/lemonade-plan';
import type {Model} from '@/lib/models/model-types';

/** A downloadable Lemonade entry: a catalog GGUF model, one of the catalog's
 *  other standalone models (vLLM, ONNX, image, speech, TTS — carried as
 *  components), or a live server's FLM model. Omni collections aren't listed
 *  or fetched by the CLI, so they have no kind here. */
export type LemonadeEntry =
  | {kind: 'catalog'; model: LemonadeModel}
  | {kind: 'component'; model: LemonadeComponent}
  | {kind: 'flm'; model: FlmModel};

/** A resolved download: what to ask `/api/v1/hf-download` for. */
export interface DownloadPlan {
  repoId: string;
  branch: string;
  filePaths: string[];
  /** Set when the model is narrower than its repo — see `--exact`. */
  fileScope?: string[];
}

export type PlanResult =
  {ok: true; plan: DownloadPlan} | {ok: false; error: string};

/** A component's download: one plan per repo its checkpoints name. */
export type MultiPlanResult =
  {ok: true; plans: DownloadPlan[]} | {ok: false; error: string};

/**
 * The entries a `tj lemonade get <pattern>` could mean. Refuses to guess the
 * way `tj copy` does: several matches come back so the caller can list them
 * and stop, since the wrong download is gigabytes and minutes.
 */
export function matchEntries(
  entries: LemonadeEntry[],
  pattern: string,
): LemonadeEntry[] {
  const needle = pattern.trim().toLowerCase();
  const hits = entries.filter((e) =>
    e.model.name.toLowerCase().includes(needle),
  );
  // An exact name beats being a substring of longer ones.
  const exact = hits.filter((e) => e.model.name.toLowerCase() === needle);
  return exact.length === 1 ? exact : hits;
}

/**
 * A catalog GGUF model's download: the files its variant resolves to within
 * its own repo, narrowed to those the target is still missing. When the target
 * has them all, the whole variant is re-requested rather than nothing — the
 * downloader skips what already matches, and a run that asks for nothing would
 * report a success that transferred no bytes and checked nothing.
 */
export function planCatalogDownload(
  model: LemonadeModel,
  repoFiles: Array<{path: string; size: number}>,
  targetModels: Model[],
): PlanResult {
  const all = matchVariantFiles(repoFiles, model.variant, model.mmproj);
  if (all.length === 0) {
    return {
      ok: false,
      error:
        `No file in ${model.repoId} matches "${model.variant ?? 'any gguf'}".\n` +
        `Run 'tj get ${model.repoId}' to see what it holds.`,
    };
  }
  const missing = missingVariantFiles(all, targetModels, model.repoId);
  return {
    ok: true,
    plan: {
      repoId: model.repoId,
      branch: 'main',
      filePaths: missing.length > 0 ? missing : all,
    },
  };
}

/**
 * A component's download — a vLLM or ONNX model, or any other catalog entry
 * that isn't a single llamacpp GGUF. Its checkpoints can span several repos
 * (an image pipeline's UNet and VAE), so this yields one plan per repo, in the
 * order the catalog names them, and the caller runs them in sequence.
 *
 * A repo the target already holds in full is dropped rather than re-requested:
 * unlike a single-repo download, there is something else left to do. When
 * *nothing* is left, the whole thing is re-requested rather than planning an
 * empty run that would report a success having checked nothing.
 *
 * A checkpoint resolving to no file at all means the catalog names something
 * its repo no longer has. That fails the whole plan: half a multi-repo model —
 * an image pipeline without its VAE — can't run, so fetching the rest of it
 * would be worse than fetching none.
 */
export function planComponentDownload(
  component: LemonadeComponent,
  listings: Map<string, Array<{path: string; size: number}>>,
  targetModels: Model[],
): MultiPlanResult {
  const plans: DownloadPlan[] = [];
  const complete: DownloadPlan[] = [];
  const unresolved: string[] = [];
  for (const job of planRepoJobs(component.checkpoints)) {
    const files = listings.get(job.repoId) ?? [];
    const all = [
      ...new Set(job.variants.flatMap((v) => resolveCheckpointFiles(files, v))),
    ];
    if (all.length === 0) {
      unresolved.push(
        `${job.repoId} (${job.variants.join(', ') || 'whole repo'})`,
      );
      continue;
    }
    const missing = missingVariantFiles(all, targetModels, job.repoId);
    const plan = {
      repoId: job.repoId,
      branch: 'main',
      filePaths: missing.length > 0 ? missing : all,
    };
    if (missing.length > 0) plans.push(plan);
    else complete.push(plan);
  }
  if (unresolved.length > 0) {
    return {
      ok: false,
      error:
        `Couldn't find the catalog's files for ${component.name} in: ` +
        `${unresolved.join('; ')}.`,
    };
  }
  return {ok: true, plans: plans.length > 0 ? plans : complete};
}

/**
 * An FLM model's download, from the HF source FastFlowLM's registry pins for
 * its tag: fetch what the target lacks, and record the registry's whole list as
 * the model's file set. The repo carries more than the model — per-model NPU
 * kernels FastFlowLM no longer fetches — so without that scope everything else
 * would count against it as missing. (The live registry wins when it can be
 * reached; the recorded scope is the fallback, see completeFileSet.)
 *
 * A file the registry names but the repo no longer has means the two have
 * drifted; that fails rather than quietly fetching a partial model that would
 * then read as complete.
 */
export function planFlmDownload(
  source: FlmSource,
  repoFiles: Array<{path: string; size: number}>,
  targetModels: Model[],
): PlanResult {
  const available = new Set(repoFiles.map((f) => f.path));
  const wanted =
    source.files.length > 0 ? source.files : repoFiles.map((f) => f.path);
  const absent = wanted.filter((f) => !available.has(f));
  if (absent.length > 0) {
    return {
      ok: false,
      error: `${source.repoId}@${source.revision} is missing: ${absent.join(', ')}.`,
    };
  }
  const missing = missingVariantFiles(wanted, targetModels, source.repoId);
  return {
    ok: true,
    plan: {
      repoId: source.repoId,
      branch: source.revision,
      filePaths: missing.length > 0 ? missing : wanted,
      fileScope: wanted,
    },
  };
}
