# Remove boundaryDups auto-fix — tool is pure range+replacement

Date: 2026-08-31

## Status

accepted

## Context

`AnchorPipeline` (`src/hashline/anchor-pipeline.ts`) auto-spliced `replacement_text` when its edge equaled an adjacent file line. Four helpers formed the seam: `trailingDups`/`leadingDups` (byte `===` vs `fileLines[endLine+k]` / `fileLines[startLine-2-k]`, 1-line threshold) and `firstNewAfterDups`/`lastNewBeforeDups` (`canon()` + `sectionIsUnique` gate on the first genuinely new line). Origin `ec472e1`/`1d71c29` was copy-paste slip of a diff block; the invariant was `swapReversed → stripBare → stripDiff → valEdit → boundaryDups splice → valEdit → verifyServed → resToSpan`.

Downstream `dsh-better-edit#38` proved the 1-line byte trap breaks the `model–tool boundary` (`CONTEXT.md`): `a\nb` over `a` (`Wot..Wot "a\nb"`) → `2` not `3` lines (`a\nb\nb\n`); `case A` C++ switch (`lA0..AU6`) → `9` not `10` lines, outermost `}` lost, every later line mis-nested. `firstNewAfter`/`lastNewBefore` share the same surprise — `canon` equality still rewrites intent. Models now reliably pass correct `remove_from`/`remove_to` hashes; a loud duplicate is reversible (next edit deletes it), silent loss is not.

## Decision

Delete all four `boundaryDups` helpers and their seam: `trailingDups`, `leadingDups`, `firstNewAfterDups`, `lastNewBeforeDups`, plus `sectionIsUnique`, `canonCounts`, `findNewEdge` (kept only as stub if re-exported), `BDup`/`AutoFix` types, `boundaryDups` field in `valEdit`, and the `splice → second valEdit` block in `applyEdit`. `AnchorPipeline` invariant becomes:

```
swapReversed → stripBare → stripDiff → valEdit → verifyServed → resToSpan
```

`replacement_text` is taken literally; `range = [remove_from, remove_to]` by hash, `replacement` is exact. No auto-splice, no new error code.

## Considered Options

- **Keep all four (status quo):** preserves diff-block paste ergonomic, but keeps 1-line `}` loss and violates `anchor philosophy: rejected, never fuzzy-matched`. Rejected.
- **Raise threshold to ≥2 consecutive lines:** fixes `#38` single-`}` case but `}\n}` (2-line run per `1d71c29`) still silently loses, still guesses intent. Rejected — still violates `model owns intent`.
- **Fail-closed `E_BOUNDARY_DUP` on three-in-a-row (`last == remove_to == endLine+1`):** converts silent loss to loud reject-and-serve, consistent with `E_RANGE_*`. Viable but punishes legitimate intentional duplicate (`a\nb` where model *did* want `b` twice) and adds a new code models have never seen. Deferred.
- **Symmetric extend (also delete `fileLines[endLine+k]`):** keeps file length consistent (`1b4d7e6` gap) but changes `hash_bounds` meaning behind model's back (`remove 1` deletes `2`). Rejected — same surprise, worse contract.
- **Delete all four (chosen):** removes surprise, keeps `model–tool boundary` pure, makes file result predictable (`a\nb` over `a` → `3` lines, `case` → `10`). Loud duplicate is visible in post-edit diff (`details` per ADR-0006) and fixable next turn. Hard to reverse silently (fork must re-add seam), but that's the point — surprising without context.

## Consequences

- `src/hashline/anchor-pipeline.ts` — invariant trimmed, imports `firstNonEmptyIndex`/`lastNonEmptyIndex` removed, `HashAssign.canon` import kept for `verifyServed` only.
- `CONTEXT.md` — `boundary duplicate` marked `historical, removed by ADR-0007`; `model–tool boundary` sharpened (tool never rewrites `replacement_text`).
- Tests — `hashline-apply-internals`, `hashline-fuzz-autofix` drop run-semantics; expectations become `no dedup` (`a\nb` → `3`). No new `E_BOUNDARY_DUP` code.
- Prompt stays `replacement_text is bare content without HASH│`; no guidance change.
- Breaking: one major bump (`feat(hashline)!`); downstream forks re-adding the seam must own the surprise.

