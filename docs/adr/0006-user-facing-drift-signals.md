# User-facing drift signals

Date: 2026-08-28 (adapted for dsh-better-edit from pi-better-edit)

## Status

accepted (adapted for dsh-better-edit — drift routing via `edit-response.ts`, `mutation.ts`); **the code names at `:13` and the `Batch drift note` half of this Decision are historical — see the Amendment**

## Context

After `edit` the tool appended three informational signals to **model content** (`content.text`) via `edit-response.ts:finalizeResult` (`diff + warnBlock + driftBlock`): `driftNotice` (windowed rows, capped by `SERVED_ECHO_CAP`), `drift: already reported` (one-liner dedup), and `Batch drift note` (warning when `editedIntervals` are disjoint, `edit-engine.ts`/`mutation.ts`). All three are not needed for the model to retry — they describe changes outside the edited range that the next `edit` can ignore. In traces they dominated attention: a successful batch edit concatenated `diff + warnings + driftBlock` (4 sections repeating "re-read to see"), and the already-reported one-liner fired on every subsequent edit until re-read. Grill `Q1–Q9` agreed: `level` means audience — `model-facing signal` vs `user-facing signal` — and all three drift signals should be human-only.

`CONTEXT.md` already defined `drift notice` but had no umbrella for audience. `model–tool boundary` says the tool owns verification; the model owns intent. Drift is informational drift, not a staleness rejection (`E_RANGE_*`, `E_EDIT_HASH_ECHO`).

## Decision

Route all drift signals to **user-facing only** — details, not model content — and keep `diff` / success summary / `noop` classification and all staleness/hash-echo rejections **model-facing**.

- **Model content (`content.text`)** — `diff` + success summary (`Successfully edited… Added/removed`) + `noop` classification + `warnBlock` for non-drift warnings only. No `driftBlock`. Batch drift note filtered from `warnBlock` in model content.
- **User-facing (`details`)** — `details.driftNotice` and `details.warnings` (including `Batch drift note`) remain, rendered collapsed in TUI (if present). `already reported` stays as a one-liner in `details`, once per episode (existing `driftReported` dedup).
- **Batch drift note trigger unchanged** — `hasGap && editedIntervals.length > 1` still fires whenever batch intervals are disjoint (Q8 a); only routing changes. Per-interval gap drift (reporting drift inside gaps) remains future work as documented in `mutation.ts` phase diagram.
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
- `src/mutation.ts` — `Batch drift note` warning push unchanged; comment notes it is user-facing (details only).
- Batch gap drift accuracy unchanged — still union `[minStart, maxEnd]` with gap treated as edited; the warning remains user-facing until per-interval drift is implemented.

## Amendment (2026-09-26) — the code names at `:13` are historical, and `Batch drift note` is retired

The body above is left as written; ADRs are write-once. All measurements are at `ab713dd`, worktree `/Users/zhengxk/development/ai/dsh-better-edit.feat-t7-docs`.

### `:13`'s two code families no longer exist

The distinction `:13` draws — drift is informational, not a staleness rejection — still holds. Only its code names rotted.

- **`E_RANGE_*` is gone.** [ADR-0014](0014-user-model-audience.md) flipped the family to `adj+noun`: `E_RANGE_STALE→E_STALE_RANGE`, `E_RANGE_UNSERVED`+`E_RANGE_UNVERIFIED→E_UNSERVED_RANGE`. `rg -c "E_RANGE_" src/` → 0 hits. The live staleness codes are `E_STALE_RANGE` (25 hits), `E_UNSERVED_RANGE` (15), `E_STALE_ANCHOR` (9).
- **`E_EDIT_HASH_ECHO` is gone.** Merged into one code by ADR-0014, then renamed `E_SUSPICIOUS_TEXT` by the domain-errors registry; `rg -c "E_EDIT_HASH_ECHO|E_WRITE_HASH_ECHO" src/` → 0 hits. The full chain is recorded in [ADR-0005](0005-bounded-hash-echo-guard.md)'s Amendment.
- **Authoritative names live in `CONTEXT.md`**, whose `E_SUSPICIOUS_TEXT` entry is the single home for the echo refusal. Cite the glossary rather than restating a code list here; `:13` is the proof that every copy rots.

### `Batch drift note` was retired after this ADR — no ADR records it

This half of the Decision (`:19`, `:21`, `:30`, `:35`, `:36`, `:37`) is false now. Recorded because the tree currently contradicts itself: a test names the retirement while no `docs/` file does.

- **The producer is gone.** `rg -n "Batch drift note|editedIntervals|hasGap" src/` → 0 hits. `:21`'s trigger `hasGap && editedIntervals.length > 1` and `:36`'s "`src/mutation.ts` — `Batch drift note` warning push unchanged" no longer describe the tree; `mutation.ts` is now a facade whose own header (`:5-12`) says tools became thin adapters.
- **The special-case filter is gone too, and the removal is pinned.** `src/edit-response.ts:109-112` — `finalizeResult` is `input.diff + warnBlock(input.warnings)`; it never reads `driftNotice`. `driftBlock` (`src/edit-response.ts:147`) has **zero call sites** in `src/` or `test/`. `test/core/error-codes.test.ts:147-152` is a describe block titled `batch drift note retired (#55 S2)` whose cell `passes warnings through with no special-casing` asserts a `"Batch drift note: x"` warning reaches model content unfiltered.
- **The retirement is undocumented.** `rg -n "#55" docs/adr/ docs/absorption-plan.md CONTEXT.md AGENTS.md` → 0 hits. Upstream issue `#55 S2` is the only record of why, and it lives in a test title.
- **What survives of this Decision.** The audience axis is intact and stronger than decided: `drift notice` never reaches model content at all, and the `already reported` one-liner is user-facing by heading — `DRIFT_NOTICE_HEADING = "[USER] drift:"` (`src/session-view.ts:502`), emitted at `src/session-view.ts:633`. `SERVED_ECHO_CAP` (`:11`) still exists at `src/constants.ts:14` = 150.
- **Still stale, not corrected here:** `CONTEXT.md:111` lists `Batch drift note` as an example `user-facing signal`; the signal no longer exists, so the example is dead. Correcting a glossary example is a content decision, not a citation fix.
