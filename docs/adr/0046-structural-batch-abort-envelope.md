# ADR-0046 — The batch-abort envelope is structural: one verdict line, one bullet per failing item

Date: 2026-11-24

## Status

accepted (amended 2026-11-25 by spec #214; amends [ADR-0043](0043-rejection-rows-are-a-fresh-read.md)'s render contract — the serve claim it records keeps its semantics and moves once, under the bullet)

Upstream referent: `Rianico/pi-better-edit#323` — the structural batch-abort envelope request. The cursor is unchanged (`0b1934c`); this record states the downstream decision only.
Downstream records: `src/domain-errors.ts` (`ErrorPayloadMap["E_BATCH_ABORT"]`, `batchAbortFormat`, `splitErrorHeader`, `batchAbortItem`, `noopLoopFormat`), `src/mutation/batch-rejection.ts` (`throwBatchRejection`, `BatchFailure`, `RejectionRecorder`), `src/mutation/engine.ts` (`collectFailure`, `shiftedBufferProjection`, `enforceNoopLoop`), `test/arch/edit-rejection-goldens.test.ts`, `test/arch/batch-rejection-assembler.test.ts`, `test/arch/rejection-payload-region.test.ts`

## Context

`E_BATCH_ABORT` was a prose envelope wrapped around an already-rendered error message. Two shapes leaked from that construction:

1. **Rows were echoed twice.** The inner formatter rendered the failed region (`Current range:` plus `HASH│content` rows), and `collectAbortPart` built an `echoBlock` from the same rows under its own heading — `Current on-disk range for edits[i] (unchanged — nothing was written)`. One rejection therefore showed the same anchors in two blocks with two headings, and a single-failure message carried both. The model had to decide which block was current; the second block added no fact.
2. **The trailing prose carried the verdict.** The atomicity fact lived in `BATCH_ATOMICITY_TRAILER` AFTER the payload (`The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied.`), followed by a conditional `Fix the failing edit(s) …, then resubmit the batch.` A reader that stops at the first block misses that nothing was written; a reader that stops later reads a remedy that repeats the registry's `remedy` field. Neither sentence is load-bearing once the payload is shaped as a verdict.

Multi-failure output had the same defects in a flatter form: `edits[0] (f) failed: <inner>; edits[1] (f) failed: <inner>` joined by `; `, so an inner message containing its own lines was glued into one paragraph.

`total` was also missing from the payload. The envelope could say how many items failed, never how many the call submitted, so `1 of 2 edits failed` was unrepresentable even though the engine knew `items.length` at the call site.

## Decision

- **The verdict is the lead line.** `Batch rejected: <failed> of <total> <edit|edits> failed; nothing was written.` The atomicity fact frames the payload instead of trailing it, and there is no trailing remedy prose: the registry's `remedy` field stays the machine-payload remedy (`Fix the failing edit, then resubmit the batch.`) and is not re-rendered.
- **One bullet per failing item.** `- edits[<i>] (<path>) [<E_CODE>]: <headerless inner message>`, with every continuation line indented two spaces so one failure stays one list entry. `splitErrorHeader` strips the inner `[TO MODEL]`/`[TO USER]` audience prefix and lifts its `[E_*]` token into the bullet label — the audience header appears exactly once in the message, and each item keeps its own code.
- **The inner error owns the single row echo.** `batchAbortFormat` no longer renders `servedRows` or `servedBlock`; a row-carrying inner message keeps its own `Current range:` rows exactly once, and a rowless inner message stays rowless. There is no `Call read() to get fresh anchors.` fallback line: a rowless refusal's own message already names the read that helps.
- **The serve disposition is stated once.** A single failure appends its serve outcome as one indented sentence under the bullet (`  These rows are the file's current anchors …`), carried as `serveNote` and set only when a serve was attempted. Multi-failure envelopes make no serve claim, because the engine sets `serveNote` only for the one-part case.
- **`total` is the submitted item count.** `buildBatchAbort(file, parts, total)` takes `items.length` from the call site and the payload renders `<failed> of <total>`; the noun follows `total` (`1 of 1 edit`, `1 of 2 edits`). `total` is optional in the payload type with `failed` as the fallback, so a producer that holds no tally still renders a truthful verdict.
- **Warnings are untouched.** `W_*` renders never echoed rows and still do not; no error code, serve decision, serve record, or warning vocabulary moves.
- **Rejected alternatives.** Keeping the second block behind a flag would preserve the ambiguity for every profile; moving the rows-only-echo rule into the inner formatters would put the envelope's shape inside eleven unrelated payload formatters; dropping `servedRows`/`servedBlock` from the payload would break third-party adapters that read the machine shape (pinned by the wire-shape test).

## Consequences

- The model-facing shape changed, so the pins moved with it: `test/core/batch-aggregation.test.ts` (lead counts `1 of 2` / `2 of 2`, bullets, no trailer, no fix prose, one audience header), `test/core/issue-142-rejection-rows-are-served.test.ts` (row-carrying rejection keeps rows once and appends the serve sentence; rowless `E_UNKNOWN_ANCHOR` renders no preview and records nothing; a declined duplicate says NOT recorded), `test/core/range-family-retry-truth.test.ts` (`rangeBlockAnchors` tolerates the two-space indent and finds one `Current range:` block; C11a/C11b assert the structural envelope and the absent fallback), `test/core/hashline-p063-literal-pipe-content.test.ts` (`/Batch rejected:/`), `test/core/vacuum-interaction.test.ts` cell 11 (lowercase `nothing was written`).
- No machine payload is lost. `servedRows` and `servedBlock` are still unioned and joined in item order, `cause`/`details` still ride on unanimous diagnosis, and `total` is additive.
- Messages get shorter: the duplicate heading, the trailer, and the remedy sentence are gone, while the rows, the codes, and the serve claim remain.
- A rowless rejection that resolves no rows no longer shows the `echoRowsForItem` preview. That preview was never a serve (ADR-0043) and repeated rows the envelope now declines to invent; the inner message names the read instead.

## References

- #144 — this change.
- [ADR-0043](0043-rejection-rows-are-a-fresh-read.md) — a rejection's echoed rows are a fresh read; the serve claim this envelope now states once.
- [ADR-0042](0042-shifted-buffer-rejections-are-served-or-absent.md) — the served-or-absent arm; its rows are inner-message rows under the same bullet.
- upstream `Rianico/pi-better-edit#323` — the structural envelope request.

## Amendment — 2026-11-25 (spec #214, lane `unify-diagnosis`)

Upstream referent: `Rianico/pi-better-edit` PR #349 (squash `958f874`, `fix(edit): unify batch rejection diagnostics under one grammar`). #323 was already absorbed by this ADR, so the amendment ports the remaining delta by defect and decision, not by range, and the cursor does **not** move (`0b1934c` unchanged). Downstream tickets: #215 (assembler), #217 (admission refusals), #216 (no-op-loop), #218 (ratchets/goldens), #219 (this record).

### Arity rule

`total === 1` throws the failing item's own error, so the header code is the actionable one and no batch vocabulary appears; a non-domain failure at arity one surfaces as `E_UNKNOWN` at the tool boundary. The verdict/bullet grammar belongs to calls that have a batch to roll back. This supersedes the Decision bullet's `1 of 1 edit` phrasing: that rendering is now unreachable from the assembler (the formatter still supports it defensively).

**Serve disposition at arity one (ruling).** `serveNote` is rendered only by the `E_BATCH_ABORT` formatter, and arity one throws before the envelope exists, so a one-item refusal does not state whether its echoed rows were recorded. The ledger behaviour is unchanged — the rows are recorded before the throw — so only the sentence is lost, and the behaviour stays refutable: `test/core/issue-142-rejection-rows-are-served.test.ts` asserts the recorded arm's retry applies and the rolled-back arm's echoed anchor is refused with `E_UNKNOWN_ANCHOR`. Giving arity one a disposition slot is a later decision, not a bug fix.

### The one assembler

`src/mutation/batch-rejection.ts` owns build → record → throw: `throwBatchRejection({ failures, total, path, record? })` records each failure's rows through `recordRejectionRows`, then throws. `collectAbortPart`, `buildBatchAbort`, the `AbortPart` type and the inline part literal are deleted. Rows with no recorder context throw `TypeError` — omission fails loud, never a skipped lease. Every engine rejection site (the pre-pass, the in-loop typed failure, and the no-op-loop guard's decision) carries one pre-batch `rejectionRecord`. The structural ratchet (`test/arch/batch-rejection-assembler.test.ts`) pins one definition, one verdict literal, one recorder site, and the recorder-carrying seam-call set; its rowless allowlist is empty and reviewed.

### No-op-loop joins the grammar

`E_NOOP_LOOP`'s payload gains `servedRows`, its rendered body drops the leading `ref` (the bullet already names `edits[i] (path)`), and the guard returns its refusal to the sequencer, which routes it through the assembler — so the rows it shows are recorded as served and, in a multi-item call, it carries the verdict and its own bullet. The changed-buffer variant stays rowless: no rows shown, none recorded, its note naming the current-file lines an anchored read would serve.

### Admission refusals

`EDIT_PAYLOAD_HINT` (972 characters) and `describeReceived` are deleted. The two arms that carried the paragraph render `<fault>. Edit payload: { file, edits: [{ anchor_from, anchor_to, replace_with }], mode?, dry_run?, allow_encoding_migration? }` — one shape line, no echo — so a malformed payload drops from 1201 to 171 characters. Scope ruling: the shape line rides only on those two arms (the generic admission arm and the prepared-arguments entry point); the named arms (`file`, `dry_run`, `allow_encoding_migration`, mode, edit count, item shape) keep their own sentences and no shape line, so upstream's wider placement is deliberately not adopted. Anchor-reason strings lose only their terminal period, and `E_MALFORMED_ANCHOR` supplies exactly one terminator, so no refusal renders a doubled terminator.

### Deviation from upstream: `edits[i]`, not `edit[i]`

Upstream renders `- edit[<i>]`. Downstream keeps `- edits[<i>]` because the tool's own vocabulary already says `edits[i]`: the no-op-loop ref and the applied-tier `W_NOOP` notices name `edits[i] (path)`, and the payload key is `edits`. One vocabulary beats byte parity; the next absorption must not "fix" this to `edit[i]` without changing those producers too.

### Served prompt

`src/prompts.ts`'s error bullet gains one clause: in a batch the verdict names `K of N` and that the whole call rolled back, and each bullet opens that item's own instruction; a one-item call shows the bare code and its own line. No error-code taxonomy is added — every refusal stays self-describing (`[TO MODEL] [E_CODE]` plus its own text).

### Consequences

`test/arch/edit-rejection-goldens.test.ts` pins ten full-message renders through the real tool; `test/arch/edit-refusal-budget.test.ts` pins the admission budget at the direct and tool boundaries; `test/arch/rejection-payload-region.test.ts` covers the no-op-loop arm; and the producer ratchet in `test/arch/domain-error-registry.test.ts` admits only `formatError`/`formatWarning` as header composers. Machine payload fields are unchanged (`servedRows`/`servedBlock`/`cause` aggregation and `details` routing stay); the only payload-value change is that a rowless failure no longer unions the never-rendered, never-leased `echoRowsForItem` pre-batch guess.
