# Open questions — nested-folder and per-quantization HF downloads

Decisions made without you while implementing
[the design](2026-08-08-hf-nested-quant-downloads-design.md). Each states the
assumption taken so the work could finish; none is hard to revisit.

## 1. Quantization rows are ordered smallest first

**Assumed:** sort by total size ascending, ties broken by label.

The approved mockup showed ascending sizes, and choosing a quant is mostly a
question of what fits the disk, so the sizes should read in order. The
alternative is HF's own listing order (roughly alphabetical), which would put
`UD-IQ1_M` before `UD-IQ1_S` and scatter the root-level weights among the
folders. Worth revisiting if you'd rather the list mirror what the HF site shows.

## 2. A quantization is all-or-nothing — resolved

**Resolved:** an "Individual files" switch beside the filter, off by default,
makes sharded rows expandable so their files can be ticked one at a time.

The default view is unchanged — no chevrons, no extra column — and the switch
only appears for repos that actually have a sharded quantization to expand. A
part-selected quantization reads as an indeterminate checkbox and says "3 of 4
files", so a collapsed row still admits it holds a partial download, and the
footer counts files rather than quantizations once any group is partial.

Two follow-on assumptions inside that, both cheap to change:

- **Selections survive turning the switch off.** Flipping it off collapses the
  rows and hides the chevrons but keeps whatever is ticked, so a partial
  selection can leave you with an indeterminate row and no visible way to
  inspect it until you flip the switch back on. Clearing partial selections on
  switch-off would be tidier but would silently discard deliberate work.
- **Switch state resets when the URL changes.** Pasting a new repo returns to
  the default. It could persist for the session instead.

## 3. The row's click target is the checkbox, not the whole row

**Assumed:** keep `startContent={<CheckboxInput …>}`, matching the existing file
list.

Astryx offers `interactiveRef` on `ListItem`, which makes the entire row an
enlarged click target that delegates to a nested control without adding a second
tab stop. That is arguably the better pattern here — 15 rows, each with a small
checkbox — but it needs a ref per row and would leave the file list and the
quant list behaving differently unless both were converted. Left alone as a
consistency call, not a considered rejection.

## 4. mmproj projectors are labelled `mmproj (F16)`

**Assumed:** call the projector out rather than labelling it by its quant.

`ggml-org/gemma-3-4b-it-GGUF` ships an F16 projector beside an F16 weight, so
grouping by quant alone produced two rows both reading `F16` with nothing to
distinguish them. The projector is a companion to a quantization rather than one
of them, so it now reads `mmproj (F16)`. The wording is a guess; `projector
(F16)` or simply the filename would do as well.

Related but untouched: the picker doesn't suggest that a vision model's
projector belongs *with* the quant you picked. Selecting a quant and its mmproj
is still two ticks, and nothing warns you if you forget the projector.
`detectMissingMmproj` handles that after the fact, in the audit.

## 5. HF tree pagination is still unhandled

**Assumed:** leave it, as the design records.

The tree API paginates past some page size via a `Link` header and no caller
follows it — `repo-files.ts`, `hf-infer.ts` and the Lemonade path all fetch
unpaginated today. Both repos probed were under the threshold, so the limit
couldn't be measured. This change doesn't worsen Lemonade but newly exposes the
picker: a repo with more files than one page would list partially and silently.
Fixing it means threading pagination through every recursive caller — a separate
change.

## 6. Multi-select is still allowed

**Assumed:** quant rows stay checkboxes, so several quantizations can be
downloaded at once.

The rows read as alternatives, which might argue for radio-style single choice,
but nothing prevents wanting two quants and the previous behaviour allowed it.
Kept permissive.
