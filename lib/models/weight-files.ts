// The model weight formats this app tracks: GGUF, safetensors, legacy
// PyTorch `.bin`, and FastFlowLM's NPU-compiled `.q4nx`. Companion files
// (config.json, tokenizer, *.index.json) are not weights. This module is
// intentionally dependency-free so client bundles can import it without
// pulling in the server-only scanner (lib/models/models.ts, which
// transitively imports `fs`/`child_process`).
export const WEIGHT_EXT_RE = /\.(gguf|safetensors|bin|q4nx)$/i;

/** Whether a path names a model weight file (by extension), ignoring any
 *  directory prefix. */
export function isWeightFile(p: string): boolean {
  return WEIGHT_EXT_RE.test(p);
}

// whisper.cpp packs several complete models into one repo as `ggml-<variant>.bin`
// (tiny, base, large-v3-turbo, optionally quantized). Each is a standalone
// single-file model, so it's treated as its own variant — like a GGUF quant —
// rather than a part of one whole-repo model.
const GGML_MODEL_RE = /^ggml-(.+)\.bin$/i;

/** The variant a whisper.cpp `ggml-<variant>.bin` filename names (e.g. `tiny`,
 *  `large-v3-turbo`), ignoring any directory prefix. Null for anything else. */
export function ggmlModelVariant(p: string): string | null {
  const base = p.split('/').pop() ?? p;
  return base.match(GGML_MODEL_RE)?.[1] ?? null;
}

// The generic weight filenames repos share, which identify nothing on their
// own: two different repos both hold a `model.safetensors`, and every
// FastFlowLM NPU model holds its weights as `model.q4nx` (a vision tower's as
// `vision_weight.q4nx`) — the NPU counterpart of `model.safetensors`. Such a
// file is identified by the directory it sits in, never by its name, so
// cross-host matching qualifies it by model and the duplicate audit leaves
// same-named copies in different models alone.
const GENERIC_WEIGHT_RE =
  /^(model|pytorch_model|tf_model|flax_model|consolidated|diffusion_pytorch_model|adapter_model|vision_weight)(-\d{5}-of-\d{5})?\.(safetensors|bin|q4nx)$/i;

/** Whether a basename is one of the generic weight names above. */
export function isGenericWeightName(basename: string): boolean {
  return GENERIC_WEIGHT_RE.test(basename);
}
