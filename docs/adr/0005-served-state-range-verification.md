# Served-State Range Verification for replace

Date: 2026-08-11

## Status

accepted

## Context

`replace` verifies only its two boundary anchors today; a change to an interior line slips through and is silently overwritten. Paged reads, truncated previews, and disjoint diff hunks mean full-file content diffing is unreliable without served-content storage and coverage bookkeeping. Reread nudges and diff visibility alone do not narrow the tool's two-line validation scope.

## Decision

We decided `replace` must verify every line of the resolved range against the served state — the tool's session-scoped, per-line record of the hashes it delivered to the model — rejecting with `[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]` plus fresh range content when the interior no longer matches what the model was shown. The check is boundary-anchored span comparison: the served span between the two anchors' served positions must equal the current resolved span line-for-line. The model is never asked to supply verification data or to re-read; the tool owns verification, the model owns intent.

### Considered Options

- **expected_hashes (the model submits the hash of every removed line)** — rejected on the model–tool boundary: it makes the model supply verification data and multiplies the hash-copy error surface the autocorrection layer already exists to paper over.
- **edit `force` / model-asserted serve override** (apply unverified ranges anyway, or record the model's claim that it saw content through bash or another channel) — rejected on the model–tool boundary: the tool would certify content it never delivered, corrupting the served mirror and unsoundly waiving verification. A soft "asserted-not-served" variant was considered and rejected for the same confabulation risk (a context-lost, looping model reaches for whatever waives verification). Only the tool's own serves — read output, post-edit diffs, rejection echoes — count.
- **Position-indexed served state** — rejected: false-rejects when an out-of-range edit shifts positions (a deleted line above the range moves every line down, so served[pos] no longer matches the same content).
- **Hash-set served state** — rejected: false-accepts when externally-changed content duplicates another served line (same content ⇒ same hash).
- **Whole-file content diff with drift-overlap abort** — rejected as the abort mechanism: sound only when serves are full; paged reads, truncated auto-read previews and disjoint diff hunks break content diffing and would force served-content storage plus coverage bookkeeping. Absorbed as the drift-notice complement instead.
- **Per-line epoch counters on anchors** — rejected: content-derived hashes already change on any content change; counters only add change-then-revert detection, which is a false positive.
- **Status quo (reread nudges + diff visibility + undo)** — rejected: nudges are unreliable, and no mitigation narrows the tool's two-line validation scope.

## Consequences

- Rejection feedback rows count as serves; without that, reject-and-serve would reject every retry.
- Served state is cleared at session start; leaking it across sessions would let a fresh-session model edit blind on interior lines it never saw.
- With auto-read disabled, the model's own edits leave changed lines never-served; a follow-up edit spanning them pays one reject-and-serve roundtrip (accepted — the tool verifies from its own records only).
- Drift outside the range but in served territory is reported as an informational drift notice on replace results — applied and noop, not undo: capped, rows count as serves, and it fires once per drift episode, already-reported drift shrinking to a one-line pointer until a read re-serves the lines. Drift inside the range is the check's own reject path, so the two never overlap.
- Previews (noPersist) run the check read-only and never update served state.
- The span check is best-effort, never a guarantee: the file can change between verification and the atomic write (TOCTOU). We claim no atomicity — the served record is the source of truth for what the model saw; the current-file check is best-effort for what is on disk now. Worst-case post-race recovery is already covered by saveUndo + [E_UNDO_STALE].
