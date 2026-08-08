import {SPLIT_RE, extractQuant} from '@/lib/models/quant';
import {WEIGHT_EXT_RE, ggmlModelVariant} from '@/lib/models/weight-files';
import {isMmprojFilename} from '@/lib/models/model-name';

/**
 * One thing a user picks in the download modal: a single weight file, or the
 * whole shard set of a split one. `paths` is what the download request carries.
 */
export interface QuantGroup {
  /** Stable identity for selection state — the unit's path with any shard
   *  suffix removed, so it survives re-listing. */
  key: string;
  /** What's shown: the quantization (`UD-IQ3_S`, `Q4_K_M`), a whisper.cpp model
   *  variant (`large-v3`), or the filename when the weight carries neither. */
  label: string;
  /** The directory holding the files, or null at the repo root. Shown to tell
   *  apart two quantizations that happen to share a label. */
  folder: string | null;
  paths: string[];
  size: number;
  fileCount: number;
}

/**
 * Group a curated pick-one listing (GGUF quants, standalone ggml `.bin` models)
 * into the units a user actually chooses among — see `repoDownloadKind`, which
 * decides when this applies.
 *
 * Repos disagree about where the quantization lives: `unsloth/Qwen3-0.6B-GGUF`
 * puts it in the filename, `unsloth/DeepSeek-V4-Flash-0731-GGUF` gives each its
 * own directory, and the latter still keeps a weight at the root and another
 * under `dspark/`. Grouping by quant rather than by directory covers all three
 * with one rule.
 *
 * Units key on directory + shard base, so two directories holding the same
 * quant stay separate rather than merging into one impossible download.
 */
export function quantGroups(
  files: Array<{path: string; size: number}>,
): QuantGroup[] {
  const groups = new Map<string, QuantGroup>();

  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    const folder = slash === -1 ? null : f.path.slice(0, slash);
    const filename = f.path.slice(slash + 1);

    // A shard collapses onto its set: `…-00002-of-00004.gguf` keys the same as
    // `…-00001-of-00004.gguf`. Anything else is its own unit.
    const split = filename.match(SPLIT_RE);
    const base = split ? `${split[1]}.${split[4]}` : filename;
    const key = folder ? `${folder}/${base}` : base;

    const existing = groups.get(key);
    if (existing) {
      existing.paths.push(f.path);
      existing.size += f.size;
      existing.fileCount += 1;
      continue;
    }

    // Same precedence the models table uses (see weightLabel): a whisper.cpp
    // variant names itself, otherwise the quant token, otherwise the bare
    // filename — a tokenless weight still needs something to pick.
    //
    // An mmproj projector is called out rather than labelled by its quant: it
    // is a companion to a quantization, not one of them, and a repo shipping an
    // F16 projector beside an F16 weight (ggml-org/gemma-3-4b-it-GGUF) would
    // otherwise offer two rows both reading "F16".
    const quant = extractQuant(base);
    const plain =
      ggmlModelVariant(base) ??
      (quant === 'unknown' ? base.replace(WEIGHT_EXT_RE, '') : quant);
    const label = isMmprojFilename(base) ? `mmproj (${plain})` : plain;

    groups.set(key, {
      key,
      label,
      folder,
      paths: [f.path],
      size: f.size,
      fileCount: 1,
    });
  }

  // Smallest first: choosing a quantization is mostly a question of what fits,
  // so the sizes should read in order. Label breaks ties so the order is stable.
  return [...groups.values()].sort(
    (a, b) => a.size - b.size || a.label.localeCompare(b.label),
  );
}
