# ADR-0045 — Diff alignment follows anchor identity, not text position

Date: 2026-11-24

## Status

accepted

Upstream referent: `pi-better-edit@1ba3186` — _fix(edit): pair duplicate diff lines by anchor identity (#331)_ — the squash-merged form of branch commit `7fa4a7d`; it closes upstream `#326`, which cites downstream `#151`. `1ba3186` is upstream `main` one commit past v2.20.0 and lies outside the absorption cursor `0b1934c`; this record states the downstream decision only.

Downstream records: `src/edit-diff.ts` (`renderLines`, `flattenParts`, `matchLinesByAnchor`, `changePart`, `rebuildParts`, `refinePartsByAnchor`, `diffParts`), `src/edit-response.ts` (dead `buildChanged`/`SuccessInput` retired), `test/core/edit-diff.duplicates.test.ts`.

## Context

An applied diff is the model's anchor map: the guidance tells it to reuse the `HASH│content` rows for the next edit, so a row must name the line identity at its position. `genDiff` rendered from `Diff.diffLines`, whose Myers pairing matches byte-identical text by position. Two equal lines are interchangeable to Myers, but not to the hash assignment: `mapStableHashes` reuses a surviving line's pre-edit anchor and a replaced line's anchor is retired. A text-only pairing therefore swapped identities.

Issue #151 reported two shapes:

1. Replacing the first of `header/dup/dup/footer` rendered the survivor's anchor (`GLZ`) as both context and removed; the replaced line's anchor (`FKY`) never appeared.
2. A range deletion containing one of two identical blank lines rendered the deleted blank as context inside the deletion and the surviving blank as removed.

The undo projection had the same defect. `undo_last_edit` calls `genDiff(current, restored)`, so a revert that brought back a deleted duplicate rendered the survivor's anchor as removed and the deleted blank's anchor as context. The issue asked for an exact-undo control; upstream's fix had no undo regression test.

## Decision

`genDiff` keeps Myers as the base and refines it by line identity only when the caller supplies both hash arrays and each array covers its content line-for-line:

- A **context pair whose old and new anchors disagree** triggers refinement. No disagreement keeps the Myers parts byte-for-byte, so unrelated diffs are unchanged.
- Refinement pairs old to new lines monotonically by **equal anchor and equal text**, using the earliest unclaimed new index. Only monotone matches exist, so a move is never invented.
- Parts are rebuilt from the match list: unmatched old spans become removed rows in pre-edit order, unmatched new spans become added rows, and matches merge into context runs.
- With **zero shared identities** the Myers parts are returned unchanged — a rewrite retires every identity, so text position is already the best available projection.
- A side without a tiling hash array stays on the text-only path; the renderer does not guess identities it was not given.

The dead single-file `buildChanged` builder and `SuccessInput` are deleted. Production already used `buildBatchResult`, and after the deletion `edit-response.ts` holds exactly one batch projection. Upstream additionally threaded a caller-supplied `renderedDiff` through its pipeline because that pipeline kept a second `genDiff` fallback; downstream has no such fallback, so no pipeline rewrite is needed.

## Consequences

- A removed row names the removed line's retired anchor; a context row keeps the survivor's anchor at its post-edit position. `servedRows` keeps its existing meaning: context/addition rows only.
- On refinement, replacement rows may order `-old` before `+new` (the pre-edit snapshot supplies removed rows). Diffs with no identity disagreement are byte-identical to before.
- The undo projection is fixed by the same code path: `tool-undo` already passes current hashes as the old side and restored hashes as the new side.
- Regression coverage: replacing the first and second duplicate, the mirror ordering, a blank-line range deletion, the zero-shared-identity fallback, a chained edit from a diff row, and exact undo of both a duplicate replacement and a range deletion.
- The absorption cursor does not move; this is a defect-driven targeted port (`0b1934c` unchanged).

## References

- Issue #151 (downstream), upstream #326, upstream commit `1ba3186` / branch `7fa4a7d`.
- [ADR-0013](0013-pos-free-roundtrip-optimization.md), [ADR-0040](0040-canon-v4-trim-only.md), [ADR-0041](0041-anchor-identity-from-raw-bytes.md) — anchor identity and survivor reuse.
- [ADR-0043](0043-rejection-rows-are-a-fresh-read.md) — served rows are usable addresses, the premise this diff must keep true.
