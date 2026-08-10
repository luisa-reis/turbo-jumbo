// Pure helpers for presenting model names. No node-only deps, so these are safe
// to import from both server code (lib/models/models.ts) and client components.

import {WEIGHT_EXT_RE} from '@/lib/models/weight-files';

/**
 * Extract the `org/repo` identity from a sidecar `modelUrl` such as
 * `https://huggingface.co/unsloth/Qwen3-GGUF`. Returns null when the URL isn't a
 * well-formed huggingface.co model URL.
 */
export function repoIdFromModelUrl(modelUrl: string): string | null {
  const m = modelUrl
    .trim()
    .match(
      /^https?:\/\/huggingface\.co\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)\/?$/,
    );
  return m ? m[1] : null;
}

/**
 * The label to show for a model identity: the repo segment of an `org/repo`
 * (e.g. `Qwen3-GGUF` from `unsloth/Qwen3-GGUF`), or the name unchanged when it
 * isn't an `org/repo` (a filename-derived name has no slash).
 */
export function modelDisplayName(name: string): string {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
}

/**
 * The org segment of an `org/repo` identity (e.g. `unsloth` from
 * `unsloth/Qwen3-GGUF`), or null when the name has no org prefix (a
 * filename-derived name has no slash). Used to disambiguate two models that
 * share a repo name but come from different orgs.
 */
export function modelOrg(name: string): string | null {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? null : name.slice(0, slash);
}

/**
 * Order two model identities by repo name, ignoring the org prefix, so a table
 * groups by the model (Qwen3-GGUF) rather than by who published it. Use as a
 * `.sort` comparator: `models.sort((a, b) => compareByRepoName(a.name, b.name))`.
 */
export function compareByRepoName(a: string, b: string): number {
  return modelDisplayName(a).localeCompare(modelDisplayName(b), undefined, {
    sensitivity: 'base',
  });
}

/**
 * A GGUF projector file (mmproj-F16.gguf, mmproj-BF16.gguf, …). Pass a
 * basename. Pure and client-safe, so both the table builders and the
 * server-only mmproj audit can share one definition.
 */
export function isMmprojFilename(basename: string): boolean {
  const lower = basename.toLowerCase();
  return lower.startsWith('mmproj') && lower.endsWith('.gguf');
}

/**
 * A weight file that is not a model on its own: it pairs with a quantization
 * rather than standing beside one.
 *
 * Naming them matters because their filenames lie about what they are. An MTP
 * head called `DeepSeek-V4-Flash-MTP-Q4K-Q8_0-F32.gguf` ends in a dtype, so a
 * quant parser reads it as an F32 quantization and lists it as a peer of the
 * 153 GiB weight it belongs to — small, plausible, and nothing says the two go
 * together. Whether you actually want the companion is a separate question the
 * repo's own card has to answer; this only stops it posing as a choice.
 */
export type CompanionKind = 'mmproj' | 'mtp' | 'draft';

/**
 * Bounded by a delimiter on both sides, so `mtparser` and `redraft` stay
 * ordinary weights. A companion is a claim about a file, not a substring.
 */
const COMPANION_TOKENS: ReadonlyArray<readonly [CompanionKind, RegExp]> = [
  ['mtp', /(?:^|[-_.])mtp(?:[-_.]|$)/i],
  ['draft', /(?:^|[-_.])draft(?:[-_.]|$)/i],
];

/** Which companion a file is, or null when it is a weight in its own right. */
export function companionKind(basename: string): CompanionKind | null {
  if (isMmprojFilename(basename)) return 'mmproj';
  // Only weights can be companions: a README naming MTP is documentation.
  if (!WEIGHT_EXT_RE.test(basename)) return null;
  const stem = basename.replace(WEIGHT_EXT_RE, '');
  return COMPANION_TOKENS.find(([, re]) => re.test(stem))?.[0] ?? null;
}
