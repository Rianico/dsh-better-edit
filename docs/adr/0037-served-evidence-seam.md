# ADR-0037 — The served-evidence seam, and the import ring it closes

Status: Accepted (ticket arch-T5, lane `arch-impl-candidates`).
Related: [ADR-0018](0018-exact-position-served-span-verification.md) — the exact-position served-span
verification `verifyServedRange` implements; [ADR-0019](0019-lease-identity-served-span-resolution.md)
and [ADR-0022](0022-region-scoped-rejection-serves.md) — the lease identity gate and the
region-scoped rows the route union decides; the interior-hole ruling the route's three questions
encode is `pi-better-edit` ADR-0024 decision 1 — upstream's own numbering, recorded locally in
ADR-0019's FU-3 amendment; [ADR-0028](0028-blocked-hashes-vocabulary.md) — the `retired` vocabulary
the verifier reads.
Downstream records: `src/hashline/served-evidence.ts` (the seam),
`src/hashline/anchor-pipeline.ts` (`applyEdit`'s call site, `fmtRegion`),
`src/session-view.ts` (`computeDrift`), `src/edit-mode.ts`, `src/store-lifecycle.ts`
(`OpenStoreFace`), `src/hashline/index.ts` (the barrel's external surface).

## Context

`src/hashline/anchor-pipeline.ts` held two seams in one file: the write pipeline (ordered autofix
chain, span resolution, the apply/assemble path) and the read-side **served-evidence** verdict
(what the anchors a session was served can still prove). Everything the read side needs lived
there — the rejection vocabulary, the echo renderers, the lease view, the route union and its three
questions, the boundary interception, and the verifier itself.

That co-location was not free. Measured on `4c6301f` with a scripted Tarjan pass over `src/**/*.ts`
(relative specifiers, `.js`→`.ts`, `dir`→`dir/index.ts`, `export … from` counted as the edge it
is), the tree had exactly two non-trivial strongly-connected components:

```
[2] hash-store.ts, store-lifecycle.ts
    hash-store.ts -value-> store-lifecycle.ts
    store-lifecycle.ts -type-> hash-store.ts

[9] contract.ts, edit-diff.ts, file-encoding-state.ts, file-view.ts, fs-bridge.ts,
    hashline/anchor-pipeline.ts, hashline/index.ts, hashline/parse.ts, session-view.ts
    contract.ts                -type->  file-view.ts
    edit-diff.ts               -type->  hashline/anchor-pipeline.ts
    edit-diff.ts               -value-> hashline/index.ts
    file-encoding-state.ts     -value-> edit-diff.ts
    file-view.ts               -type->  fs-bridge.ts
    file-view.ts               -type->  hashline/anchor-pipeline.ts
    file-view.ts               -value-> edit-diff.ts
    file-view.ts               -value-> hashline/index.ts
    fs-bridge.ts               -value-> file-encoding-state.ts
    fs-bridge.ts               -value-> file-view.ts
    hashline/anchor-pipeline.ts -type-> contract.ts
    hashline/anchor-pipeline.ts -value-> session-view.ts
    hashline/index.ts          -value-> hashline/anchor-pipeline.ts
    hashline/index.ts          -value-> hashline/parse.ts
    hashline/parse.ts          -value-> hashline/anchor-pipeline.ts
    session-view.ts            -value-> hashline/anchor-pipeline.ts
```

Two return edges held the nine-node ring closed, and both came from the mixed seam:

- `session-view.ts -value-> hashline/anchor-pipeline.ts` — the drift renderer borrowed
  `fmtServedRows` and the drift shapes borrowed `ServedRow`/`ResolvedRange`, so the module that
  owns the served mirror imported the module that verifies it.
- `hashline/anchor-pipeline.ts -type-> contract.ts` — `EditMode` (one line:
  `"general" | "literal"`) typed `applyEdit`'s `mode` argument; `contract.ts` in turn imports
  `ReadWindow` from `file-view.ts`, which imports the hashline barrel.

The `store-lifecycle ↔ hash-store` pair was the other half: `onStoreOpen` typed its third parameter
`HashStore`, and `hash-store` calls `onStoreOpen`. The edge is type-only, so it never existed at
runtime — but it is a real compile-time cycle and a false statement about the layering.

## Decision

1. **The read-side evidence is one module, `src/hashline/served-evidence.ts`, and
   `verifyServedRange` is its entry point.** Everything else in the file is private to that call:
   the `ServedEvidenceRoute` union and its three questions (`owesInteriorScan`,
   `acceptsInteriorHole`, `checksPosition`), the leased-route boundary interception, the per-lease
   `lineIdentityDecision`, and `throwUnknownOrForeign`. They are not exported, so no caller can
   consult half a route.
2. **`verifyRebasedSpan` stays exported**, and only because two cells pin the leased route through
   the barrel (`test/core/lease-resolve-seam.test.ts`, `test/core/served-evidence-route.test.ts`).
   This ticket may not touch assertions, so the symbol has to keep its name and reachability; the
   module docblock says plainly that it is not a second entry point.
3. **The moved set is the ticket's span plus the three declarations the span silently depended
   on.** The verifier throws `ServedRejectionError` fourteen times and echoes through
   `buildRangeEcho`/`fmtServedRows`/`paginationHint`, all of which sat outside the stated
   `559–1107` range. `ServedRejectionError` and its `ServedCode` union **had** to move: left behind,
   they would have made `served-evidence → anchor-pipeline` a second real edge alongside
   `anchor-pipeline → served-evidence` (`applyEdit` calls the verifier), i.e. a fresh two-node cycle
   in place of the one being removed. `ResolvedRange` moved for the same reason on the read side —
   it is the shape `session-view`'s drift computation carries, so leaving it in the write file
   would have kept `session-view → anchor-pipeline` alive. With the move,
   `served-evidence.ts` imports exactly `../domain-errors.js`, `./hash-assign.js` and
   `../constants.js` — three leaves.
4. **`servedPositionsOf` moves with the verifier** and stays re-exported from `session-view.ts`, so
   its three test importers are untouched. It is a pure six-line scan with two in-verifier call
   sites; the module that calls it owns it, and the mirror module keeps its public surface.
5. **One renderer, two entry points.** `fmtServedRows` is the row kernel and `fmtRegion` keeps its
   own fail-loud length guard, then delegates:
   `fmtServedRows(hashes.map((hash, index) => ({ position: index, hash })), lines)`. Byte-identity
   holds for every production caller because all four pass dense, parallel arrays built in one pass
   (`src/file-view.ts`: the preview builders), where the two renderers agree exactly. The single
   divergence is the sparse-slot case (`fileLines[row.position] === undefined`): `fmtServedRows`
   has always rendered `""` there and the old `fmtRegion` would have rendered the string
   `"undefined"`. That case is unreachable for `fmtRegion` — the guard above it rejects a length
   mismatch, and a dense array cannot carry `undefined` — so the unification removes an
   unobservable difference rather than a behaviour. The guard is kept, not folded: it is the
   region renderer's own invariant, never flow control.
6. **The `[... N more — X]` frame is shared; the `[Showing lines a–b of N …]` family is not.**
   `moreRowsHint(count, tail)` is the one frame producer. The serve echo's pagination tail
   (`paginationHint`, tail `` `read offset=${nextOffset}` ``) and the drift notice's tail
   (`session-view`, tail `"re-read to see"`) both call it, so the frame cannot drift between them.
   The two `[Showing lines …]` sentences are deliberately **not** folded in: `file-view`'s
   `formatPaginationHint` and `tool-str-replace-editor`'s preview are a different sentence with
   different brackets, a different count basis (`endLine`/`totalLines` vs an unshown-count) and, in
   the editor's case, a different continuation verb (`view_range`, not `offset`). Folding them would
   change bytes, so the shared thing is the frame, not the sentence.
7. **`EditMode` gets its own leaf** (`src/edit-mode.ts`, re-exported by `contract.ts` so the
   contract's consumers are unchanged). One type earns a module because it is the _only_ edge from
   the write pipeline back into the request contract — with it in place, `anchor-pipeline` imports
   the request shapes' neighbour and not the contract, and the last return edge of the nine-node
   ring disappears.
8. **`store-lifecycle` types its store parameter structurally** (`OpenStoreFace`:
   `pruneUndoOlderThan`, `pruneMissing`, `vacuumSnapshots` — the three members `onStoreOpen`
   actually calls). The store handle is a leaf there; importing its type was a vice, not a
   dependency.

## Consequences

Measured after the change (`4c6301f` → this tree, 60 → 62 nodes, same script):

```
nodes: 62, non-trivial SCCs: 1

[2] file-view.ts, fs-bridge.ts
    file-view.ts -type-> fs-bridge.ts
    fs-bridge.ts -value-> file-view.ts
```

The ladder, in the order it closes:

1. **The extraction alone** takes the nine-node ring to eight: `session-view` leaves it
   (`anchor-pipeline → served-evidence` replaces `anchor-pipeline → session-view`, and
   `session-view → served-evidence` replaces the reverse edge). The ring still closes through
   `anchor-pipeline → contract (type: EditMode) → file-view → hashline/index → anchor-pipeline`.
2. **The structural store face** removes the two-node pair: `store-lifecycle` no longer names
   `hash-store`.
3. **The `EditMode` leaf** opens the ring at its last return edge, and the eight-node component
   collapses entirely — every remaining edge among those modules runs one way.
4. **The residual pair is `file-view ↔ fs-bridge`**, out of this ticket's scope: `fs-bridge` imports
   `fileSnap` from `file-view` (value, the snapshot half of the IO seam) and `file-view` imports
   `type FileIO` back (type-only). It is the IO seam's own two halves; cutting it is a different
   design question (which of the two owns the snapshot), not an evidence-extraction side effect.

Also consequential:

- `src/hashline/anchor-pipeline.ts` no longer re-exports any read-side evidence symbol; the barrel
  `src/hashline/index.ts` re-exports the read side from `served-evidence.js`, so its external
  surface is unchanged and the six barrel-importing test files needed no edit. `ServedRow` and
  `RangeCause` still come from `anchor-pipeline`'s `domain-errors` re-export — those are the
  registry's types, not evidence logic.
- The 14 `throw new ServedRejectionError({` sites keep their exact shape (the arch oracles count
  them per code across the tree: 12 `E_STALE_RANGE`, 2 `E_UNSERVED_RANGE`), so
  `test/arch/range-family-signal.test.ts` and `test/arch/domain-error-registry.test.ts` stay true
  and now report the new file in their failure output.
- The mutation ledger's three recipes anchored in the moved text (`T6M2`, `RX1M1`, `RX2M1`) retarget
  their `file:` to `src/hashline/served-evidence.ts`; their `old:` strings move byte-identically, so
  the RED sets are unchanged. `N1` (the `parseRef` anchor) stays in `anchor-pipeline.ts`.
- Two source-comment and prose cite families drift with the move and are recorded here rather than
  silently: `docs/adr/0022` §"evidence" still counts "13 arms" (the tree has had 14 since the
  ADR-0023/FU-3 split) and its historical `reread` grep transcript keeps its old line numbers, as do
  the `anchor-pipeline.ts:703` mentions in `test/core/deleted-twin-anchor.test.ts`,
  `test/core/batch-aggregation.test.ts` and the ledger's retired-`M7` note. Those are transcripts of
  runs at older revisions, not live pointers.

## Rejected alternatives

- **Leave the verifier in `anchor-pipeline` and only retarget the barrel.** Nothing breaks, but the
  read side keeps importing the write pipeline for its renderers and shapes, and the nine-node ring
  stays: the dependency direction remains a cycle no matter how the exports are spelled.
- **Split by direction instead of by ownership** — e.g. a `served-render.ts` for the formatters and
  a `served-verify.ts` for the verifier. Two modules that are only ever used together, each needing
  the other's types, is a cycle with extra steps.
- **Re-export `ServedRejectionError` from `anchor-pipeline` for compatibility.** It would restore
  `served-evidence → anchor-pipeline` for the throws and re-close the cycle this ADR removes. The
  one shim importer (`src/hashline/served.js` is `export * from "./anchor-pipeline.js"`) was
  retargeted instead.
- **Fold `[Showing lines …]` into `moreRowsHint`.** Different sentence, different count basis,
  different continuation verb — the emitted bytes would change.
- **Remove `fmtRegion`'s length guard in favour of the row kernel's tolerance.** The guard is the
  region renderer's invariant; the tolerance is the echo's. One entry point cannot carry both
  policies, so both stay and only the row kernel is shared.
- **Delete `EditMode` and inline the union.** `contract.ts` owns the request vocabulary and its
  validation; the write pipeline only needs the two literal arms. A leaf keeps both.

## References

- [ADR-0018](0018-exact-position-served-span-verification.md) — the exact-position rule and the
  echo the verifier renders.
- [ADR-0019](0019-lease-identity-served-span-resolution.md) — the lease identity gate
  (`verifyRebasedSpan`) and why the lease source is opt-in.
- [ADR-0022](0022-region-scoped-rejection-serves.md) — region-scoped rows for the anchors' range.
- [ADR-0019](0019-lease-identity-served-span-resolution.md) §FU-3 amendment — the interior-hole
  ruling behind `acceptsInteriorHole`/`owesInteriorScan` (`pi-better-edit` ADR-0024 decision 1,
  upstream's numbering).
- [ADR-0028](0028-blocked-hashes-vocabulary.md) — the `retired` vocabulary the verifier reads.
- `GLOSSARY.md` — `served row`, `served span`, `lease`, `retired anchor`, `drift`.
