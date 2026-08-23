import path from 'path';
import type {
  Model,
  ModelFile,
  Shard,
  SingleFile,
  SplitGroup,
} from '@/lib/models/model-types';
import {pathImpliedRepo} from '@/lib/audit/audit-verdict';
import {parseHubCachePath} from '@/lib/hf/hf-cache';
import {isMmprojFilename, repoIdFromModelUrl} from '@/lib/models/model-name';
import {isDiffusersComponentFile} from '@/lib/models/diffusers';
import {
  MODEL_SIDECAR_NAME,
  readModelSidecar,
  summarizeModel,
} from '@/lib/models/model-sidecar';
import type {TjModel} from '@/lib/models/model-sidecar';
import {metaPath, readMetaAt} from '@/lib/models/tjmeta';
import {
  ggmlModelVariant,
  isGenericWeightName,
  isWeightFile,
} from '@/lib/models/weight-files';
import {SPLIT_RE, extractModelName, extractQuant} from '@/lib/models/quant';
import {parentDir} from '@/lib/storage/entries';
import {siteStorage, type Site} from '@/lib/storage/site';
import type {FileEntry} from '@/lib/storage/storage';

// Re-exported so existing `@/lib/models` importers keep working.
export {isWeightFile};
// Quant/shard parsing lives in the fs-free lib/models/quant.ts so client code
// can import it; re-exported here because this has always been its address.
export {extractModelName, extractQuant};

export type {
  Model,
  ModelFile,
  Shard,
  SingleFile,
  SplitGroup,
} from '@/lib/models/model-types';
export {shardPath, shardSize} from '@/lib/models/model-types';

/**
 * Which model sidecar (`tjmodel.json`) owns each file of an inventory: the
 * nearest ancestor directory holding one, the root included. The sidecars are
 * located from the inventory itself — no probing directory by directory — and
 * each is read once, however many files it owns. An unparseable sidecar is
 * passed over for the next one up, as the walk that tried each directory in
 * turn always did.
 */
function sidecarOwners(
  site: Site,
  entries: FileEntry[],
): (relPath: string) => Promise<TjModel | null> {
  const dirs = new Set<string>();
  for (const e of entries) {
    if (e.kind !== 'dir' && path.posix.basename(e.path) === MODEL_SIDECAR_NAME)
      dirs.add(parentDir(e.path));
  }
  const reads = new Map<string, Promise<TjModel | null>>();
  const read = (dir: string): Promise<TjModel | null> => {
    let p = reads.get(dir);
    if (!p) {
      p = readModelSidecar(site, dir);
      reads.set(dir, p);
    }
    return p;
  };
  return async (relPath) => {
    for (let dir = parentDir(relPath); ; dir = parentDir(dir)) {
      if (dirs.has(dir)) {
        const m = await read(dir);
        if (m) return m;
      }
      if (dir === '') return null;
    }
  };
}

/**
 * The variant label for a weight file. A whisper.cpp `ggml-*.bin` is labeled by
 * the model in its filename (tiny, large-v3-turbo, …): one repo ships several
 * standalone models with no quant token, so each is its own variant — like a
 * GGUF quant — rather than collapsing under a generic `pytorch` tag. Otherwise a
 * filename quant token wins (GGUF, or a dtype-tagged safetensors); a generic
 * safetensors file is labeled by its header dtype (BF16/F16/…, read by the
 * inventory walk), a `.bin` by a generic tag, and a tokenless GGUF keeps
 * `unknown`.
 */
function weightLabel(entry: FileEntry, quant: string): string {
  const filename = path.posix.basename(entry.path);
  const ggmlVariant = ggmlModelVariant(filename);
  if (ggmlVariant) return ggmlVariant;
  if (quant !== 'unknown') return quant;
  if (/\.safetensors$/i.test(filename)) return entry.dtype ?? 'safetensors';
  if (/\.bin$/i.test(filename)) return 'pytorch';
  // FastFlowLM's NPU-compiled weights are all one 4-bit format; the extension
  // is the precision label.
  if (/\.q4nx$/i.test(filename)) return 'Q4NX';
  return quant;
}

/**
 * Rewrite filename-derived model names to the repo name when a sidecar-named
 * copy of the same files exists in any of the given scans, then merge models
 * that end up sharing a name within a scan. A model's name depends on sidecar
 * presence (`sidecarRepoId` falls back to the filename), so the same model can
 * be named `gpt-oss-20b` by one scan and `unsloth/gpt-oss-20b-GGUF` by another
 * — e.g. when only the local copy has been audited — and would otherwise
 * produce two table rows. A name claimed by more than one repo is left alone:
 * there's no way to tell which repo the sidecar-less files belong to.
 */
export function normalizeModelNames(scans: Model[][]): Model[][] {
  // What a file group would be called with no sidecar present.
  const filenameAlias = (f: ModelFile): string => {
    const filename = f.isSplit ? f.representativeFilename : f.filename;
    const split = filename.match(SPLIT_RE);
    return extractModelName(split ? `${split[1]}.gguf` : filename);
  };

  // Filename-derived alias -> the repo names whose files claim it.
  const aliasRepos = new Map<string, Set<string>>();
  for (const models of scans) {
    for (const m of models) {
      if (!m.name.includes('/')) continue;
      for (const f of m.files) {
        const alias = filenameAlias(f);
        const repos = aliasRepos.get(alias);
        if (repos) {
          repos.add(m.name);
        } else {
          aliasRepos.set(alias, new Set([m.name]));
        }
      }
    }
  }

  return scans.map((models) => {
    const out = new Map<string, Model>();
    for (const m of models) {
      const repos = m.name.includes('/') ? null : aliasRepos.get(m.name);
      const name = repos?.size === 1 ? [...repos][0] : m.name;
      const existing = out.get(name);
      if (existing) {
        existing.files = [...existing.files, ...m.files];
      } else {
        out.set(name, {...m, name});
      }
    }
    return [...out.values()];
  });
}

/**
 * The models a site holds, from one inventory of it. Every file named like a
 * weight becomes a variant of some model: a split set's shards are gathered
 * into one group, anything else stands alone. A model's name is, in order,
 * the repo the hub-cache layout encodes, the `repoId` of the `tjmodel.json`
 * owning the file, the `modelUrl` of a legacy per-file `.tjmeta.json`, the
 * `<org>/<repo>/` directory a flat-layout weight sits in, and finally the
 * filename.
 *
 * A symlinked weight (Lemonade's extra directory, the hub cache's
 * `snapshots/`) reports the size of what it points at; a dangling one is
 * `missing`.
 *
 * `lemonadePath` names Lemonade's own cache, skipped (by directory name, at
 * any depth) when it lives inside the site, so its copies don't show up as
 * this site's models.
 */
export async function scanModels(
  site: Site | undefined,
  lemonadePath?: string,
): Promise<Model[]> {
  if (!site) return [];
  const {storage, root} = siteStorage(site);
  const lemonadeName = lemonadePath ? path.basename(lemonadePath) : null;
  const entries = await storage.list(root, {dtype: true});
  const present = new Set(entries.map((e) => e.path));
  const ownerOf = sidecarOwners(site, entries);

  /** The repoId recorded in the model sidecar owning `relPath`, or null. The
   *  authoritative name for the whole model dir. */
  const ownerRepoId = async (relPath: string): Promise<string | null> => {
    const m = await ownerOf(relPath);
    return m && typeof m.repoId === 'string' ? m.repoId : null;
  };

  /** The model identity a file's legacy `.tjmeta.json` records — the
   *  `org/repo` it was downloaded from / verified against — or null when
   *  there is no such sidecar or its `modelUrl` is missing or unparseable. */
  const metaRepoId = async (relPath: string): Promise<string | null> => {
    if (!present.has(metaPath(relPath))) return null;
    const meta = await readMetaAt(site, relPath);
    return typeof meta?.modelUrl === 'string'
      ? repoIdFromModelUrl(meta.modelUrl)
      : null;
  };

  const singleMap = new Map<string, SingleFile[]>();

  // One representative file path per model name, to read the model's sidecar
  // once after the walk (all of a model's files share its sidecar dir).
  const sampleByModel = new Map<string, string>();

  interface SplitAccum {
    modelName: string;
    quant: string;
    totalShards: number;
    presentIndices: Set<number>;
    presentPaths: Shard[];
    totalSize: number;
    representativeFilename: string;
    // Which shard the representative (and the quant read from it) came from.
    // Kept so the lowest-numbered shard always wins regardless of the order
    // the inventory lists them in — see the update below.
    representativeIndex: number;
  }
  const splitMap = new Map<string, SplitAccum>();

  for (const entry of entries) {
    if (entry.kind === 'dir') continue;
    const relPath = entry.path;
    const segments = relPath.split('/');
    const filename = segments[segments.length - 1];
    if (lemonadeName && segments.slice(0, -1).includes(lemonadeName)) continue;
    const splitMatch = filename.match(SPLIT_RE);
    if (!splitMatch && !isWeightFile(filename)) continue;

    // In the hub cache layout the repo is encoded in the directory, so it's
    // the authoritative name regardless of the (often generic) filename.
    const cacheRepoId = parseHubCachePath(relPath)?.repoId ?? null;
    // A weight file stored under an `<org>/<repo>/` directory (the flat mirror
    // layout) takes that repo as its name when no sidecar says otherwise — the
    // directory is authoritative even for a GGUF whose filename carries the
    // model name. Otherwise the same file is named `gemma-3-4b-it` on a host
    // without a sidecar but `ggml-org/gemma-3-4b-it-GGUF` on one with it, so
    // the two copies don't join (and the peer tab shows the wrong name). A
    // truly loose file (no `<org>/<repo>/` path) still falls back to its
    // filename-derived name.
    const flatRepoId = isWeightFile(filename)
      ? (pathImpliedRepo(relPath)?.repoId ?? null)
      : null;
    // Prefer the authoritative org/repo from the sidecars; fall back to the
    // filename-derived name when there's none.
    const modelNameFor = async (fallback: string): Promise<string> =>
      cacheRepoId ??
      (await ownerRepoId(relPath)) ??
      (await metaRepoId(relPath)) ??
      flatRepoId ??
      fallback;
    const size = entry.size;

    if (splitMatch) {
      const base = splitMatch[1];
      const index = parseInt(splitMatch[2], 10);
      const total = parseInt(splitMatch[3], 10);
      const modelName = await modelNameFor(extractModelName(`${base}.gguf`));
      const quant = extractQuant(`${base}.gguf`);
      const key = `${modelName}::${base}`;
      if (!sampleByModel.has(modelName)) sampleByModel.set(modelName, relPath);

      if (!splitMap.has(key)) {
        splitMap.set(key, {
          modelName,
          quant: weightLabel(entry, quant),
          totalShards: total,
          presentIndices: new Set(),
          presentPaths: [],
          totalSize: 0,
          representativeFilename: filename,
          representativeIndex: index,
        });
      }
      const accum = splitMap.get(key)!;
      // Inventory order is arbitrary and differs between machines holding the
      // same files, so the representative must not be "whichever shard we saw
      // first": the lowest-numbered one wins. The quant follows it, because a
      // mixed-dtype checkpoint reads BF16 off shard 1 and F32 off shard 40 —
      // which made two peers label the identical model differently.
      if (index < accum.representativeIndex) {
        accum.representativeIndex = index;
        accum.representativeFilename = filename;
        accum.quant = weightLabel(entry, quant);
      }
      accum.presentIndices.add(index);
      accum.presentPaths.push({path: relPath, size});
      accum.totalSize += size;
    } else {
      const modelName = await modelNameFor(extractModelName(filename));
      if (!sampleByModel.has(modelName)) sampleByModel.set(modelName, relPath);
      const file: SingleFile = {
        isSplit: false,
        filename,
        path: relPath,
        quant: weightLabel(entry, extractQuant(filename)),
        size,
        missing: entry.dangling === true,
      };
      const existing = singleMap.get(modelName);
      if (existing) {
        existing.push(file);
      } else {
        singleMap.set(modelName, [file]);
      }
    }
  }

  const modelMap = new Map<string, ModelFile[]>();

  for (const [modelName, files] of singleMap) {
    modelMap.set(modelName, [...files]);
  }

  for (const accum of splitMap.values()) {
    const missingIndices: number[] = [];
    for (let i = 1; i <= accum.totalShards; i++) {
      if (!accum.presentIndices.has(i)) missingIndices.push(i);
    }
    const splitGroup: SplitGroup = {
      isSplit: true,
      representativeFilename: accum.representativeFilename,
      files: accum.presentPaths,
      quant: accum.quant,
      totalShards: accum.totalShards,
      presentShards: accum.presentIndices.size,
      missingIndices,
      totalSize: accum.totalSize,
    };
    const existing = modelMap.get(accum.modelName);
    if (existing) {
      existing.push(splitGroup);
    } else {
      modelMap.set(accum.modelName, [splitGroup]);
    }
  }

  const models: Model[] = [];
  for (const [name, files] of modelMap) {
    const sample = sampleByModel.get(name);
    const owner = sample ? await ownerOf(sample) : null;
    const sidecar =
      owner && typeof owner.repoId === 'string' ? summarizeModel(owner) : null;
    const sidecarFiles =
      owner && Array.isArray(owner.files) ? owner.files : null;
    models.push({
      name,
      files: files.sort((a, b) => a.quant.localeCompare(b.quant)),
      ...(sidecar ? {sidecar} : {}),
      ...(sidecarFiles ? {sidecarFiles} : {}),
    });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Basenames carried by more than one file in a scan: basename → every relative
 * path bearing it, keeping only names with 2+ paths. Split groups contribute
 * each shard's own filename. The audit flags these as duplicates — same-named
 * files in different directories within one storage location.
 *
 * A shared basename alone isn't enough: two builds of the same quant from
 * different repos (e.g. `unsloth/…` and `LiquidAI/…` both shipping
 * `LFM2-1.2B-Q4_K_M.gguf`) are different files that merely share a name. The
 * sidecar-recorded `sourceSha256` is a file's identity, so two copies whose
 * hashes are both known and differ are never duplicates of each other. An
 * unknown hash can't disprove a match, so it still pairs with anything — a
 * sidecar-less stray copy is still flagged against its twin, as before.
 */
export function duplicateBasenames(models: Model[]): Map<string, string[]> {
  const byName = new Map<string, Array<{path: string; sha: string}>>();
  const add = (relPath: string, sha: string) => {
    // A cache-layout file is uniquely placed by its repo's snapshot; it is
    // never a stray basename duplicate the way a flat-layout copy can be.
    if (parseHubCachePath(relPath)) return;
    // A diffusers component weight (`unet/…`, `vae/…`) carries a generic basename
    // (`diffusion_pytorch_model.safetensors`) shared across components — its
    // folder, not its name, identifies it, so it's never a basename duplicate.
    if (isDiffusersComponentFile(relPath)) return;
    const name = path.basename(relPath);
    // mmproj projector files carry generic names (mmproj-F16.gguf) that recur
    // across vision models; same-named copies in different repos aren't
    // duplicates of each other, so never flag them.
    if (isMmprojFilename(name)) return;
    // Likewise the generic weight names — `model.safetensors`, and every
    // FastFlowLM model's `model.q4nx`: the directory identifies the file, the
    // name never does, so two models each holding one aren't duplicates even
    // when a missing sidecar hash leaves the content question open.
    if (isGenericWeightName(name)) return;
    const entries = byName.get(name);
    if (entries) entries.push({path: relPath, sha});
    else byName.set(name, [{path: relPath, sha}]);
  };
  for (const model of models) {
    // The model's recorded source hash per file basename, from its sidecar.
    const shaByBase = new Map<string, string>();
    for (const rec of model.sidecarFiles ?? [])
      shaByBase.set(path.basename(rec.path), rec.sourceSha256 ?? '');
    for (const file of model.files) {
      if (file.isSplit)
        for (const shard of file.files)
          add(shard.path, shaByBase.get(path.basename(shard.path)) ?? '');
      else add(file.path, shaByBase.get(path.basename(file.path)) ?? '');
    }
  }
  // Two copies are duplicates unless both hashes are known and differ; keep a
  // path only when some other same-named copy is a possible match.
  const compatible = (a: string, b: string) => !a || !b || a === b;
  const out = new Map<string, string[]>();
  for (const [name, entries] of byName) {
    if (entries.length < 2) continue;
    const dupPaths = entries
      .filter((e) => entries.some((o) => o !== e && compatible(e.sha, o.sha)))
      .map((e) => e.path);
    if (dupPaths.length > 1) out.set(name, dupPaths);
  }
  return out;
}

// Flag each file that has no matching copy in cold storage, so the UI can warn
// that it isn't backed up. A split group counts as present if any shard is. A
// dangling link in the archive is no copy at all.
export async function annotateColdStorage(
  models: Model[],
  coldSite: Site,
): Promise<Model[]> {
  const {storage, root} = siteStorage(coldSite);
  const inCold = new Set(
    (await storage.list(root)).filter((e) => !e.dangling).map((e) => e.path),
  );
  return models.map((model) => ({
    ...model,
    files: model.files.map((file): ModelFile => {
      if (file.isSplit) {
        const present = file.files.some((shard) => inCold.has(shard.path));
        return {...file, notInColdStorage: !present};
      }
      return {...file, notInColdStorage: !inCold.has(file.path)};
    }),
  }));
}
