# User-facing drift signals

Date: 2026-08-28

## Status

accepted

## Context

After `edit` the tool appended three informational signals to **model content** (`content.text`) via `edit-response.ts:finalizeResult` (`diff + warnBlock + driftBlock`): `driftNotice` (windowed rows, capped by `SERVED_ECHO_CAP`), `drift: already reported` (one-liner dedup), and `Batch drift note` (warning when `editedIntervals` are disjoint, `edit-pipeline.ts:559`). All three are not needed for the model to retry — they describe changes outside the edited range that the next `edit` can ignore. In traces they dominated attention: a successful batch edit concatenated `diff + warnings + driftBlock` (4 sections repeating "re-read to see"), and the already-reported one-liner fired on every subsequent edit until re-read. Grill `Q1–Q9` agreed: `level` means audience — `model-facing signal` vs `user-facing signal` — and all three drift signals should be human-only.

`CONTEXT.md` already defined `drift notice` but had no umbrella for audience. `model–tool boundary` says the tool owns verification; the model owns intent. Drift is informational drift, not a staleness rejection (`E_RANGE_*`, `E_EDIT_HASH_ECHO`).

## Decision

Route all drift signals to **user-facing only** — details, not model content — and keep `diff` / success summary / `noop` classification and all staleness/hash-echo rejections **model-facing**.

- **Model content (`content.text`)** — `diff` + success summary (`Successfully edited… Added/removed`) + `noop` classification + `warnBlock` for non-drift warnings only. No `driftBlock`. Batch drift note filtered from `warnBlock` in model content.
- **User-facing (`details`)** — `details.driftNotice` and `details.warnings` (including `Batch drift note`) remain, rendered collapsed in TUI (`edit-render.ts:buildAppliedText` appends `driftNotice`/`warnings` dimmed). `already reported` stays as a one-liner in `details`, once per episode (existing `driftReported` dedup).
- **Batch drift note trigger unchanged** — `hasGap && editedIntervals.length > 1` still fires whenever batch intervals are disjoint (Q8 a); only routing changes. Per-interval gap drift (reporting drift inside gaps) remains future work as documented in `edit-pipeline.ts` phase diagram.
- **Glossary** — `CONTEXT.md` adds `model-facing signal` / `user-facing signal`; `drift notice` is classified as `user-facing signal`.

## Considered Options

- **Keep drift in model content (status quo)** — simplest, but wastes attention on every success; model learns to ignore drift block and may miss real staleness that is co-located in the same text shape.
- **Per-signal verbosity levels (`silent`/`brief`/`verbose`)** — rejected; `level` as defined in grill is binary audience, not verbosity. A `verbose` drift window still competes with `diff` in model context.
- **New `verbosity` param on `edit`** — model-requested verbosity. Rejected for now; tool-side suppression + TUI collapse (`a + c` in Q4) achieves the same without enlarging the payload contract. Can be re-added if a model needs on-demand drift.
- **Suppress already-reported entirely after first emission** — rejected; keep the one-liner user-facing so the human sees that drift is still pending, but not in model content.
- **Make Batch drift note conditional on `served` gap occupancy** — more precise (only when gap contains served lines), but adds a scanning pass and conflates routing fix with correctness fix; deferred.

## Consequences

- `CONTEXT.md` adds `model-facing signal`, `user-facing signal`, and classifies `drift notice` as user-facing.
- `src/edit-response.ts` — `finalizeResult` / `buildNoop` / `buildChanged` / `buildBatchResult` no longer append `driftBlock` to `content.text`; non-drift warnings still in `content`, `Batch drift note` filtered from `content` warn block. `driftNotice` stays in `details`.
- `src/edit-pipeline.ts` — `Batch drift note` warning push unchanged; comment notes it is user-facing (details only).
- `src/edit-render.ts` — `buildAppliedText` renders `details.driftNotice` and `details.warnings` collapsed (dim) for human view; model still sees only `diff`/summary.
- Batch gap drift accuracy unchanged — still union `[minStart, maxEnd]` with gap treated as edited; the warning remains user-facing until per-interval drift is implemented.
