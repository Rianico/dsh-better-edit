# User/model audience split and glossary-aligned error codes

Date: 2026-09-05 (adapted for dsh-better-edit from pi-better-edit ADR-0014, `dd1a779`)

## Status

accepted (adapted for dsh-better-edit — AnchorPipeline, SessionView, contract.ts, edit-response.ts)

## Context

`E_*` codes mixed `noun+adj` (`E_RANGE_STALE`) with `adj+noun` (`E_STALE_ANCHOR`), overloaded one code for distinct misses (`E_RANGE_UNSERVED` interior hole vs `E_RANGE_UNVERIFIED` boundary miss), retained dead `E_AMBIGUOUS_ANCHOR` (probing + per-session `tombstone` makes file duplicates impossible except synthetic collision), and triplicated anchor-syntax (`E_BARE_HASH_PREFIX`/`E_INVALID_PATCH`/`E_BAD_REF`) as auto-heal warnings — the tool silently rewriting `replacement_text`, violating `model–tool boundary`. `E_NOT_TEXT` leaked an affordance (`Use ls…`); `E_EDIT_HASH_ECHO`/`E_WRITE_HASH_ECHO` split one concept across tools. Our ADR-0013 (tombstone epoch, `canon`+`snapshotId`, position-free verify) made the staleness model `tombstone∉ && canon==` + `snapshotId` epoch, but the surface kept the old names. Our ADR-0006 already defined `model-facing signal` vs `user-facing signal` and filtered `Batch drift note:` from model content — the audience axis exists, the codes did not follow it.

## Decision

**Display-layer audience, glossary `adj+noun` family, no alias.**

- **Audience is display-layer only.** Thrown error `content` carries `[MODEL] [E_*]` (the model must retry); `warnings`/`driftNotice` in `details` carry `[USER]` (human-only, dimmed where the renderer supports it — our dsh plugin has no theme seam, so the prefix is the cue). Raw codes stay bare `E_*` anywhere they are matched programmatically (`String.includes`, `details`, `ServedCode`, `ServedRejectionError.code`).
- **`adj+noun` renames (no alias):** `E_BAD_SHAPE→E_BAD_PAYLOAD`, `E_NOT_TEXT→E_UNSUPPORTED_FILE` (directory message trimmed of `Use ls…`; the encoding Top-3 retry hint stays — it is the actionable retry, not an affordance), `E_FILE_TOO_LARGE→E_LARGE_FILE`, `E_WOULD_EMPTY→E_EMPTY_RANGE`, `E_EDIT_HASH_ECHO`/`E_WRITE_HASH_ECHO→E_SERVED_ECHO`, `E_BAD_OP→E_REVERSED_ANCHORS` (healed `[USER] … swapped (healed)` vs throw `[MODEL] … Range start …`), `E_RANGE_STALE→E_STALE_RANGE`, `E_RANGE_UNSERVED`+`E_RANGE_UNVERIFIED→E_UNSERVED_RANGE` (with `ServedRejectionError.unservedKind`: `"boundary"` for the old cannot-verify-range case, `"interior"` for the never-served-line case), `E_AMBIGUOUS_ANCHOR→E_STALE_ANCHOR` (collision keeps line list + re-read retry), `E_BARE_HASH_PREFIX`/`E_INVALID_PATCH`/`E_BAD_REF→E_BAD_ANCHOR` (single anchor-syntax code, now `throw` not heal).
- **Heal→throw boundary.** `resEdit` block-hash extraction, `HASH│`/diff-prefix anchor parsing, `stripBarePrefixes`, `stripDiffPrefixes` now throw `[MODEL] [E_BAD_ANCHOR]` instead of pushing heal warnings. Only `swapReversedRanges` keeps healed success (`[USER] [E_REVERSED_ANCHORS] … swapped (healed)`). The strips throw `BadAnchorError` carrying the stripped edit so `applyEdit` can distinguish served-echo (re-checked at the resolved start line → `[MODEL] [E_SERVED_ECHO]` denial) from garbage (`E_BAD_ANCHOR` stands) — the served-echo guard keeps its range-relative precision, no behavior loss.
- **Glossary realignment (`CONTEXT.md`, `README.md`):** `boundary staleness` → `anchor staleness` (one-line miss), `range staleness` → `served-range staleness` (span mismatch, `E_STALE_RANGE`/`E_UNSERVED_RANGE` + `reject-and-serve`), `served range` alias for `served span`, merged `E_SERVED_ECHO` entry, trimmed `E_UNSUPPORTED_FILE`.
- **Deferred (no upstream precedent):** `E_NOOP_LOOP`, `E_BATCH_ABORT`, `E_UNDO_STALE`/`E_UNDO_UNAVAILABLE`, `E_NOT_OBSERVED`, `E_BAD_ENCODING`/`E_DECODE_FAILED` keep bare codes — dsh-specific families outside ADR-0014's scope.

## Consequences

- `src/hashline/anchor-pipeline.ts`: `ServedCode` is `"E_STALE_RANGE"|"E_UNSERVED_RANGE"`; `ServedRejectionError` gains `unservedKind`; new exported `BadAnchorError`; `applyEdit` wraps strips with the echo-fallback catch.
- `src/session-view.ts`: `DRIFT_NOTICE_HEADING` is `[USER] drift:`; drift stays details-only (ADR-0006 routing extended, batch note retired from user surface).
- `CONTEXT.md` Language, `README.md` error table, `src/prompts.ts`/`src/guidance/` wording follow the new names.
- Tests assert new codes + `[MODEL]`/`[USER]` prefixes; removed-heal tests assert throws; healed-reverse test asserts `[USER]` success.
- Breaking for any downstream matching old codes (fail-loud by design — stale codes never match silently since matching is substring on the new names).
