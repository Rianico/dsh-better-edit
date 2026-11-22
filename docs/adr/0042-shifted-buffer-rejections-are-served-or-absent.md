# ADR-0042 — A rejection raised inside a changed batch buffer is served-or-absent

Date: 2026-11-22

## Status

accepted (amends [ADR-0022](0022-region-scoped-rejection-serves.md)'s reject-and-serve decision for the one region its invariant cannot describe: a region that exists only in an uncommitted batch buffer)

Upstream referent: `pi-better-edit@5412d3f` — _fix(edit): walk the outline fold gate in served coordinates (#270)_. The commit postdates the absorption cursor `0b1934c` and is unabsorbed; this record states the downstream decision only.
Downstream records: [ADR-0019](0019-lease-identity-served-span-resolution.md) (the preview/`noPersist` route was deleted, so rows from a non-persisting path are never a serve), [ADR-0020](0020-atomic-store-pairs-and-corrupt-lineage-repair.md) (the named invariant "no user-visible claim about served anchors may be emitted before a successful serve write"), `src/mutation/engine.ts` (`BufferFrames`, `namedReadSentence`, `shiftedBufferInner`, `collectAbortPart`, `enforceNoopLoop`, `baselineLineById`), `src/domain-errors.ts` (`E_NOOP_LOOP.note`), `src/prompts.ts` (`EDIT_GUIDANCE`), `test/core/issue-150-abort-echo-mixed-snapshot.test.ts`, `test/core/issue-150-noop-loop-rowless.test.ts`

[ADR-0013](0013-pos-free-roundtrip-optimization.md)'s surviving §2 (tombstone/allocation) is orthogonal
to the buffer-frame question; its round-trip option was already dispositioned by
[ADR-0019](0019-lease-identity-served-span-resolution.md).

## Context

Issue #150. A single `edit` call submits two items: item 0 rewrites line 2 (`two`) into two lines, item 1 targets the 3-line span `one..three`. Item 0 applies to the in-memory batch buffer, every coordinate below it shifts, item 1's served window grows from 3 lines to 4, and `verifyServedRange` rejects with `E_STALE_RANGE`. The batch aborts and no byte reaches disk — that half was always correct.

The refusal was not. `collectAbortPart` preferred the rejection's own `servedRows`, which the verifier had built from the **working buffer** (`buildRangeEcho(startLine, endLine, fileHashes)` in `src/hashline/served-evidence.ts`), and then rendered them against the **pre-batch** lines (`fmtServedRows(echoRows, splitLines(originalNormalized))`). The block headed `Current on-disk range for edits[1] (unchanged — nothing was written)` therefore paired anchors that existed only in the uncommitted buffer with text that existed only on disk:

```
hvX│one
vsE│two
5PJ│three
qGt│four
```

`qGt` still anchored `three` on disk; `four` was merely what sat at that buffer position. The model was told, under a heading that promises on-disk truth, that `qGt` names `four`.

[ADR-0022](0022-region-scoped-rejection-serves.md)'s invariant — "a rejection payload carries rows only for the region the submitted anchors identify" — silently assumed the region is a region of the **current file**. A batch buffer is not the current file, so no region it names can be served: the anchors are not ones the model can spend, and the positions are not ones the next `read` will confirm. The same holds for `E_NOOP_LOOP`, whose rows came from the same buffer lookup.

## Decision

A rejection raised once an earlier item of the same call has changed the working buffer (`currentContent !== originalNormalized`) is **served-or-absent**: it shows no `HASH│content` rows, carries no rows in its payload, records no serve, grants no lease, and names only current-file coordinates. Its message keeps the code, keeps the producer's diagnosis, and appends the bounded read an anchored read would serve.

The coordinate frame is derived, never guessed. `baselineLineById` is frozen from the pre-loop identity array (`line_id → pre-batch line`), while the working array `currentIds` advances past every applied item; so `lineOf(bufferLine) = baselineLineById.get(currentIds[bufferLine - 1])`, and `undefined` means the batch itself created that line. `BufferFrames` carries that map plus `complete`, which is false when the store yielded no identity map at all (`currentIds === undefined`). With `complete: false` no line can be mapped, so the note says exactly that ("The current-file line numbers of these rows could not be determined; re-read the file for fresh anchors.") and headlines print `a line` rather than any number — a missing map must never turn into a false claim that the rows do not exist, nor into a buffer number wearing a current-file label.

Per-code disposition (only in-loop rejections, only after the buffer changed):

- `E_STALE_RANGE` — rows dropped; `line N` / `line N-M` in the headline and `firstOffendingLine` re-anchored to current-file lines; an unmapped start keeps its producer text (a batch-created line has no current-file number, and inventing one would name a line that never existed).
- `E_STALE_ANCHOR` — same rule as `E_STALE_RANGE`.
- `E_UNSERVED_RANGE` — same rule as `E_STALE_RANGE`.
- `E_UNVERIFIED_RANGE` — rows dropped, but **not** mapped: its rows come from `lease.servedLineNumber` (served coordinates, already current-file lines), so mapping them through the buffer frame would double-map. Reachability: the arm is unreachable from the in-loop resolver today, because `applyOne` forwards only `ServedRejectionError` / `AnchorMismatchError` to `onReject` and `ServedCode` excludes the code. It is kept as the written form of that frame rule, so a future widening of the catch cannot silently drop it.
- `E_NOOP_LOOP` — the same rule through a new optional `note` payload field: rowless, `servedBlock: ""`, and the note rendered **only** when `servedBlock === ""`. The single-item and unchanged-buffer arms are byte-identical to before.
- `E_UNKNOWN_ANCHOR`, `E_FOREIGN_ANCHOR`, `E_TARGET_LOST`, `E_SUSPICIOUS_TEXT`, `E_BAD_PAYLOAD`, `E_LARGE_FILE` — exempt: they carry no rows, so there is nothing to withhold.

Byte-identical guarantees, all deliberate:

- The pre-pass over the pre-batch snapshot passes no frames, so its echo is unchanged; so are single-item and first-item (buffer-untouched) rejection payloads, and the row-bearing goldens.
- All-or-nothing is unchanged: the throw precedes every disk write, and the tool never reaches its write block. No serve, lease or mirror write exists on the reject path — those writes live once, after the loop, in `src/mutation.ts`.
- A changed-buffer rejection with **no** rows still renders the pre-batch rows through `echoRowsForItem`. Those pairs are self-consistent (pre-batch anchors with pre-batch text), never a mixed snapshot, and upstream only rewrites when rows exist — so this case stays at upstream parity rather than growing a second rule.

### Fold-gate triage (excluded)

Upstream's third hunk is not this decision: it walks the outline-fold interior in served coordinates (`servedStart + k`) instead of rebased coordinates, which changes **what rejects**, not what a refusal shows. Issue #150's repro never reaches that gate — no outline fold exists in it, and the rejection is `verifyServedRange`'s span-length arm. It is therefore excluded from this lane and deferred to its own ticket with an outline-fold batch repro. Recorded here so the omission is a decision, not an oversight.

### Considered Options

- **Coherent snapshot (derive rows and text from the same snapshot)** — declined. Rendering the pre-batch rows consistently would remove the mixed pairs, but the block still claims to describe the region the submitted anchors name, and those anchors address a buffer the call never committed. It would also advertise anchors the model cannot spend. The issue's own "Candidate seam" suggestion is this option; it is rejected by decision, not by omission.
- **Rowless with no named read** — declined. Dropping the rows without naming the current-file lines leaves the model with no bounded next action and turns a one-turn recovery into a blind search.
- **Record the buffer rows as served instead** — declined. Upstream's root cause was exactly this: rows recorded at buffer coordinates patch the persistent mirror at the wrong positions, displacing the real served rows so a later standalone edit of an already served span is refused.
- **Widen `applyOne`'s reject catch to every row-carrying `DomainError` now** — deferred, not declined. Today only three codes can carry rows out of that catch; widening it changes which failures reach the batch envelope at all, which is a larger contract question than #150. The residual gap is stated in Consequences.

## Consequences

- The false evidence is closed and the mixed-snapshot block no longer exists; `test/core/issue-150-abort-echo-mixed-snapshot.test.ts` pins it (no `│`, no on-disk block, the named `current-file lines 1-3`), pins resubmission honesty (the identical batch stays rowless), and pins that a read of exactly the named lines is sufficient to apply.
- `test/core/issue-150-noop-loop-rowless.test.ts` pins the noop arm, including that the original serve record survives the refusal (a standalone edit of the same span still applies afterwards).
- Cost: a rejection that lands after a buffer change now costs one bounded read instead of zero. The message names the exact window, so it is one turn, not a search. A rejection that lands before any item changed the buffer — the common case — is unaffected.
- [ADR-0022](0022-region-scoped-rejection-serves.md)'s invariant is amended, not superseded: a region is a region of the current file; a region named only inside an uncommitted buffer cannot be served, and withholding its rows is the region rule applied honestly rather than an exception to it.
- [ADR-0020](0020-atomic-store-pairs-and-corrupt-lineage-repair.md)'s invariant gains its mirror image: as no claim about served anchors may precede a successful serve write, no claim about on-disk rows may describe rows the call never wrote.
- Residual gap (follow-up decision, not a defect in this rule): a row-carrying `DomainError` that escapes `applyOne`'s narrow catch — `E_UNVERIFIED_RANGE` is the only such code in the resolver today — would escape the batch envelope unwrapped (and, for `E_UNVERIFIED_RANGE`, with buffer-derived rows under a fresh-read heading). Widening that catch is the ticket that closes it.
- The rule is stated to the model in `EDIT_GUIDANCE` (`src/prompts.ts`) and in the README reject-and-serve bullet, so a model reading either learns that a post-buffer-change refusal is rowless before it sees one.
