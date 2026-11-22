# ADR-0043 — A rejection's echoed rows are a fresh read

Date: 2026-11-22

## Status

accepted (supersedes the no-record arm of [ADR-0013](0013-pos-free-roundtrip-optimization.md) §3 and T3f's deletion recorded in [ADR-0018](0018-exact-position-served-span-verification.md), [ADR-0019](0019-lease-identity-served-span-resolution.md) and [ADR-0020](0020-atomic-store-pairs-and-corrupt-lineage-repair.md); amends [ADR-0042](0042-shifted-buffer-rejections-are-served-or-absent.md) §Decision's "No serve, lease or mirror write exists on the reject path")

Upstream referent: `pi-better-edit@47a04f7` — _scope served canons per file and serve fresh read (#152)_. `[E_STALE_RANGE]` no longer mandates a blind retry, it serves the current range as a fresh read. `5412d3f` — _walk the outline fold gate in served coordinates (#270)_ — postdates the absorption cursor `0b1934c` and is unabsorbed; it landed downstream as issue #150, whose refusal is served-or-absent for a changed batch buffer ([ADR-0042](0042-shifted-buffer-rejections-are-served-or-absent.md)). This record states the downstream decision only.

Downstream records: `src/mutation/rejection-serve.ts` (`recordRejectionRows`), `src/mutation/engine.ts` (`collectAbortPart`, `AbortPart.rowsServed`), `src/session-view.ts` (`recordServed`, `grantServeLeases`, `_mergeServedRows`), `src/domain-errors.ts` (`E_STALE_RANGE` payload note), `src/prompts.ts` (`EDIT_GUIDANCE`, `READ_GUIDANCE`), `test/core/issue-142-rejection-rows-are-served.test.ts`.

## Context

Issue #142, five steps: (1) `read` serves `left`, `middle`, `right`; (2) the model holds those three anchors; (3) an external write changes `middle` to `external`; (4) an edit spanning the served `left`→`right` rejects with `[E_STALE_RANGE]` and its echo shows the CURRENT file's rows — `left`, `external`, `right`; (5) a retry with the echoed `external` anchor rejects `[E_UNKNOWN_ANCHOR]`.

Step 5 was the defect. The echo was a real rendering of the committed snapshot's rows, but nothing recorded them, so the anchor the model was just shown could not be spent. The published reject-and-serve contract — a row-carrying refusal recovers in one turn — was true only of a `read` that happened to follow it, not of the rows the refusal itself displayed.

T3f deleted the only recorder on this path, and that deletion was correct for the recorder it removed. `recordEchoServes`' last body (`git show a11a8332:src/served-state.ts`) was:

```ts
export async function recordEchoServes(sessionKey, path, rows, policy) {
  if (policy !== "live") return;
  await recordServed(sessionKey, path, rows);
}
```

Rows only — no line count, no canons, no snapshot content. `grantServeLeases` returns early without `content`/`hashes`, so no lease was ever granted; the recorded anchors were therefore unusable, and the write also left the previous slot in place, which is the duplicate-anchor defect [ADR-0018](0018-exact-position-served-span-verification.md) records as the reason for the deletion ([ADR-0020](0020-atomic-store-pairs-and-corrupt-lineage-repair.md) records the symbol-level removal). The recorder predates the lease seam of [ADR-0019](0019-lease-identity-served-span-resolution.md); it was deleted rather than hardened.

Two things changed since:

1. [ADR-0042](0042-shifted-buffer-rejections-are-served-or-absent.md) made a row-carrying refusal name current-file rows only — a changed batch buffer shows no rows at all and names the read. "The rows are not reliably current-file rows" no longer holds: a refusal either carries servable rows or carries none plus a named read.
2. The recorder now passes the whole serve triple (content, hashes, canons) through `recordServed`, so the row merge, the lease grant and the canon patch land in the same unit a windowed `read` uses. The T3f defect — a recorded anchor with no lease — is unrepresentable.

## Decision

A rejection that shows current-file rows records them as served — rows, canons, snapshot and leases — exactly like a windowed `read` of those lines. Its message says so, and a retry with an echoed anchor resolves without a `read`.

A refusal that cannot show current-file rows records nothing and names the read.

Preconditions, non-negotiable:

- Recording happens only from the committed on-disk snapshot of the call (`originalNormalized` / `originalHashes` in `src/mutation/engine.ts`), never from a working buffer.
- Recording happens only when no earlier item of the call changed the buffer (`frames === undefined`); the [ADR-0042](0042-shifted-buffer-rejections-are-served-or-absent.md) arm stays rowless and records nothing.
- Recording happens only when the rejection itself carried the rows (`error.servedRows.length > 0`), i.e. the verifier identified the region. The `echoRowsForItem` fallback arm is a rendered preview of a region nobody proved served — never recorded.
- `fullRead: false`: the full-read effects (retired-anchor clear, hazard cards, whole canon array) stay off a rejection. A refusal names one window, never the whole file.

All-or-nothing duplicate gate. The echo's anchors come from the edit path's content-addressed assignment (`normFromText` → `lineHashes` with no `previous`), which can differ from the read path's served-stable assignment (`readAndServe` reconstructs `previous` from served canons and passes it to `lineHashes` → `mapStableHashes`). If a recorded hash is already served at a position OUTSIDE the recorded window, writing it would put one anchor at two mirror positions — the duplicate-anchor state [ADR-0018](0018-exact-position-served-span-verification.md) removed the heal for. Such a window records nothing at all: no subset, so the mirror is either untouched or exactly the recorded window. The message then says the rows were NOT recorded as served and names the read.

What stays forbidden:

- Recording preview or buffer rows (`echoRowsForItem`'s zero-row fallback is a rendered preview, never a serve; the batch-buffer arm of [ADR-0042](0042-shifted-buffer-rejections-are-served-or-absent.md) stays rowless and records nothing).
- Recording a range the caller never proved served (no identified region, no rows).
- Recording a duplicate-producing window by any route (subset, heal, blanking an outside slot).

Property this buys: a recorded window can never create a duplicate, and a declined window leaves the mirror byte-identical.

## Considered Options

- **Docs-only fix (the issue's own suggestion)** — declined. The published one-turn contract can be made true for less work than un-publishing it, and a rowless-only rewrite leaves the common case (a single-item stale range) costing a read.
- **Record and accept the duplicate** — declined. It would bless duplicate anchors in the next read, weakening [ADR-0018](0018-exact-position-served-span-verification.md)'s duplicate/`read2 ≡ control` invariant rather than reversing an old no-serve pin.
- **Partial record (drop only the conflicting rows)** — declined. A partially recorded window cannot be retried (the retry needs both boundary anchors leased), so the message would promise a recovery the served state cannot honour.
- **Served-aware echo (re-hash the window the way a read would, then record that)** — declined. The echo would stop being `fileHashes[position]` of the verified snapshot ([ADR-0022](0022-region-scoped-rejection-serves.md) decision 1) and every refusal would need a read-shaped re-hash.
- **Reuse `recordServedTruncated`** — declined. Its `clearFrom` truncation is an edit-shaped contract (drop everything from the edited line on); a rejection names one window and must not truncate.
- **Harden the old `recordEchoServes` shape (rows only)** — declined by the recorder already being unfit: without the serve triple no lease is granted, which is exactly why T3f removed it.

## Consequences

- `test/core/issue-142-rejection-rows-are-served.test.ts` pins the new rule in six cells: the 5-step repro (retry applies), the read-first control, the changed-buffer rowless arm (records nothing, rows and grants byte-identical), the `echoRowsForItem` preview arm (rows shown, records nothing), a rolled-back serve write (message says NOT recorded, anchor unusable), and the duplicate gate (declined whole, mirror byte-identical, next read equals control with no duplicates, a read then applies the edit).
- Test pins updated DELIBERATELY, each with its one-line reason:

  | Pin                                                                                                                           | Reason                                                                                                                    |
  | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
  | `test/core/range-family-retry-truth.test.ts` C1                                                                               | The echoed retry now applies; the read-then-apply control moved to its own fresh file.                                    |
  | `test/arch/rejection-payload-region.test.ts` "a rejection re-serves only its region and leaves out-of-region slots untouched" | The mirror after a row-carrying rejection now holds the current file's rows; the payload region rule itself is unchanged. |
  | `test/core/serve-leases.test.ts` CONTRACT comment                                                                             | The block now pins the two arms that still record nothing (rowless refusal, declined duplicate window).                   |

- No assertion was weakened. The four duplicate-anchor cells in `test/core/serve-leases.test.ts` (insert-only, windowed, consecutive rejections, batch abort) pass unchanged — the duplicate gate is what keeps them green, and `read2 ≡ control` with no duplicate anchors remains pinned.
- Residual risk: the recorded window is what the edit path proves served, so stale slots OUTSIDE the window can survive until a read covers them — the same bounded residual [ADR-0018](0018-exact-position-served-span-verification.md) already accepts for the exact-write rule; `sweepAndRetire` still runs, so displaced anchors are retired.
- Cost: a row-carrying refusal now writes the serve unit (rows + canons + snapshot + leases). A declined window costs one bounded read; the message names it.
- The rule is stated to the model in `EDIT_GUIDANCE`/`READ_GUIDANCE` (`src/prompts.ts`), in the README reject-and-serve bullets (en/zh), and in `GLOSSARY.md`'s `reject-and-serve` entry.
- `docs/absorption-plan.md` is NOT touched: no upstream cursor moves, and neither upstream commit is absorbed by this decision.
