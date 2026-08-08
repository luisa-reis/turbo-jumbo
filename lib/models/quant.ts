// Quantization tokens and split-shard naming, read straight off a filename.
// Like lib/models/weight-files.ts this module is intentionally
// dependency-free — the download picker groups a repo's files by quant in the
// browser, so it must not pull in the server-only scanner (lib/models/models.ts,
// which transitively imports `fs`/`child_process`). models.ts re-exports
// everything here, so server-side callers are unaffected by the split.
import {WEIGHT_EXT_RE} from '@/lib/models/weight-files';

// A quantization token: IQ2_XS, Q4_K_M, MXFP4 (Microscaling FP4), BF16, F16, …
const QUANT_TOKEN =
  '(?:UD-)?(?:IQ\\d+_(?:XXS|XS|NL|[SML])|Q\\d+(?:_K(?:_(?:XL|XS|[SML]))?|_[01])?|MXFP4|BF16|F16|F32)';

// Match a quant token delimited by - _ . and followed by another delimiter or
// end of name. Global so callers take the LAST occurrence: the quant is usually
// the final token, but may be followed by descriptor suffixes — e.g.
// "GPT-OSS-20B-…-MXFP4-Aggressive" carries the quant before "-Aggressive".
const QUANT_RE = new RegExp(`[-_.](${QUANT_TOKEN})(?=[-_.]|$)`, 'gi');
export const SPLIT_RE = /^(.+)-(\d+)-of-(\d+)\.(gguf|safetensors|bin)$/i;

function stripExtension(filename: string): string {
  return filename.replace(WEIGHT_EXT_RE, '');
}

function lastQuantMatch(base: string): RegExpMatchArray | null {
  const matches = [...base.matchAll(QUANT_RE)];
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

export function extractModelName(filename: string): string {
  const base = stripExtension(filename);
  const m = lastQuantMatch(base);
  if (m?.index == null) return base;
  // Remove the matched token along with its leading delimiter, leaving any
  // descriptor suffix (and its own delimiter) intact.
  return base.slice(0, m.index) + base.slice(m.index + m[0].length);
}

export function extractQuant(filename: string): string {
  const m = lastQuantMatch(stripExtension(filename));
  return m ? m[1].toUpperCase() : 'unknown';
}
