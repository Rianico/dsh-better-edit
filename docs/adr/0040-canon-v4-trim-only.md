# Canon v4 — trim-only over the frozen 28-code-point whitespace class

Date: 2026-11-21

## Status

accepted (amends [ADR-0002](0002-whitespace-insensitive-anchors.md), whose "Caveat (verified)" consequence is superseded for interior positions; the frozen class itself is upstream ADR-0002's canon v3 class)

## Context

ADR-0002 made the anchor canon strip every ASCII whitespace run (`[ \t\r\n]`, global) and recorded the caveat as benign because the only external writer was assumed to be a formatter. Issue #135 disproved that premise with a real data-loss path: an external writer changed `String s = "a b";` to `String s = "ab";`, the two lines canonicalized identically, the served lease stayed alive, and the next edit reported success while overwriting the other writer's bytes.

`canon` is the pairing evidence the served-evidence verifier compares, so any whitespace run the canon drops is invisible to verification — including runs inside string and char literals, where whitespace is content.

## Decision

`canon(line)` is trim-only over the frozen 28-code-point whitespace class: it strips one leading run and one trailing run, never an interior run. `CANON_VERSION` becomes 4. Interior whitespace — between tokens and inside a literal alike — is significant: a foreign writer that changes it rotates `canonDigest`, `pairLineIds` allocates a fresh `line_id`, the lease retires, and the edit rejects fail-closed (`[E_STALE_ANCHOR]` at the lease, surfaced inside the `E_BATCH_ABORT` envelope).

Formatter tolerance is kept only where a formatter moves edges: a pure re-indent and a trailing-whitespace strip still fold. This is a deliberate narrowing: an interior reformat (`foo( a, b )` vs `foo(a,b)`) now rejects too, because a token-boundary special case would reintroduce a lexical predicate `canon` cannot own.

Snapshot keys carry both invalidation axes (`${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}` in `src/snapshot-store/index.ts` and `snapshotHashFor` in `src/snapshot-store/lineage-store.ts`; the generation axis arrives with [ADR-0041](0041-anchor-identity-from-raw-bytes.md)), so pre-v4 rows are inert cache misses rebuilt on the next read. No schema migration; in-flight anchors rotate once.

## Consequences

- The #135 data-loss path is closed: an intra-literal whitespace rewrite rejects and the external bytes survive on disk.
- ADR-0002's "Caveat (verified)" paragraph and its survivor/removed-hash consequence (interior-space formatting matching across a format pass) are superseded. The edge tolerance ADR-0002 decided still holds.
- The trim class widens from ADR-0002's ASCII-only set to the frozen 28 code points at the edges (NBSP, em space, ideographic space, BOM, LTR/RTL marks, NEL, …). ADR-0002's "NBSP and all Unicode whitespace remain significant" holds for interior positions and is superseded for edges.
- Cost: interior-only formatter churn (operator spacing, argument spacing) now costs one rejection plus a re-read instead of being silently absorbed. Rejections are fail-closed and serve fresh rows, so recovery is one turn.
- Tests: `test/core/canon-v4-disposition.test.ts` is the executable disposition table (41 rows: edge variants fold for the 28 class members, the middle position is significant for every row); `test/integration/intra-literal-whitespace-135.test.ts` pins the tool-seam cases (intra-literal rewrite rejects with bytes preserved, re-indent applies, trailing strip applies, interior operator reformat rejects).
