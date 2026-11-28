# ADR-0054 — Fence stored canon evidence by the snapshot epoch

Date: 2026-11-25

## Status

accepted (amends [ADR-0041](0041-anchor-identity-from-raw-bytes.md)'s reuse claim; adds no schema step, no migration and no sweep change)

## Context

The snapshot key `${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}` has carried both axes since [ADR-0041](0041-anchor-identity-from-raw-bytes.md), and the exact-key reads are current-epoch by construction because they recompute the key. The evidence stored beside a key is a different question. `line_lineage.canon_hash`, `served_leases.canon_hash` and the `line_id`s paired through them are only comparable to today's digest under the canon that wrote them, yet three seams reused them without asking:

- `latestSnapshotStmt` (`src/snapshot-store/lineage-store.ts`) reads the newest `file_snapshots` row for a path and fed `commitSnapshot`'s pairing, `latestLineageFor`'s read-path alignment and `positionsByIdentity`'s fallback — no predicate at all;
- the lease source (`leaseSourceFrom` in `src/mutation/engine.ts`) resolved a `served_leases` row by anchor and honoured it whatever epoch stamped it;
- the undo gate (`getUndo` in `src/undo-edit.ts`) asked the full epoch, so a canon-only-foreign pin was DELETED and its undo history lost — over-fenced rather than under-fenced.

A canon-only change is a plain cache miss for the exact key, so the first two seams could only read a prior-canon family when it outlived the store's open-time sweep. A concurrent mixed-version writer produces exactly that: it commits rows after this build opened the store, and nothing re-runs the sweep in this process's lifetime. The stored digest it wrote can equal today's digest of a line this build never folded, so a paired `line_id` would carry identity across an external rewrite — the defect the upstream fix names.

Upstream `pi-better-edit@7e9c982` (`fix(canon): fence stored canon evidence by snapshot epoch`, PR #340) reached the same conclusion with a single epoch module and a stat-adoption seam this repository does not have.

## Decision

- **One owner of the epoch shape.** `src/snapshot-store/epoch.ts` exports `parseSnapshotEpoch`, `snapshotEpochKey`, `snapshotEpochPrefix`, `isCurrentSnapshotEpoch` and `isCurrentRawAnchorGeneration`, and imports only `../hashline/hash-assign.js`. `snapshotHashFor`, `cacheKey` and the `meta` stamp all derive from it, so the key and its predicates cannot drift apart.
- **Two predicates, because there are two kinds of evidence.** Raw anchors are a function of the raw bytes, so anchor reuse asks the generation alone (`isCurrentRawAnchorGeneration`). Stored canon evidence is only comparable under the canon that wrote it, so every seam that reuses it asks the full epoch (`isCurrentSnapshotEpoch`).
- **Fence the three reuse seams.** `latestSnapshotStmt` gains `AND snapshot_hash LIKE ?`, bound to `${snapshotEpochPrefix()}%` — one SQL change fences S_latest pairing, the read-path alignment and the identity-position fallback. The lease source returns `undefined` for a lease whose `served_snapshot_hash` is not the current epoch, instead of resolving it.
- **Undo re-derives rather than adopting.** Downstream has no pin-adoption seam: `undo_last_edit` re-materializes the pre-image through `upsertSnapshot`/`commitSnapshot`, which recompute the key on the current epoch. The pin is therefore only a validity gate, and the gate asks the raw-anchor axis. A pin from another generation is still deleted; a canon-only-foreign pin is kept, its stored anchors are reused, and its restored lease names today's epoch — so the next edit needs no intermediate read.
- **Retention is not validity.** `sweepForeignAnchorGeneration` keeps its full-epoch stamp and miss semantics. A row that survives the sweep (one written after it) is still refused at every reuse seam.
- **No schema change, no migration.** The epoch lives in keys, as ADR-0041 decided. There is no per-row column and no backfill.

## Consequences

- A path whose only snapshot is prior-epoch pairs nothing: its next materializing write allocates fresh `line_id`s instead of inheriting identity from evidence it cannot verify. Fail-closed on a churned path, and observable — the anchors a read serves stay the same, because anchor reuse never asked the canon.
- The read path's checksum-miss alignment loses prior-epoch evidence until the next materializing read; until then it falls back to fresh allocation rather than to a pairing it cannot prove.
- Same-epoch behavior is byte-identical: every reachable row under a current store takes the same path as before, and the `meta` stamp value does not move.
- A canon-only-foreign undo pin now restores instead of reporting no history. Its stored raw anchors are generation-valid, and the restore's lease names the current epoch.
- The open-time sweep still deletes prior-epoch rows on a real canon upgrade in a fresh process; the fence covers the rows a concurrent writer mints after it.

## What this deliberately does not do

- It does not change the open-time sweep or its stamp. Retention semantics stay as ADR-0041 recorded them, so no migration and no one-time restamp are implied.
- It does not add a stat-adoption seam. Downstream has no `findStatSnapshotFor`/`adoptStatSnapshotFor`; the upstream patch's arm there has no carrier and is not invented.
- It does not move the absorption cursor. `7e9c982` is a targeted defect fix, not a range absorb.
- It does not change payload shapes, lease authority or the anchor canon/generation constants.

## References

- #221 — this change.
- [ADR-0041](0041-anchor-identity-from-raw-bytes.md) — the two axes and the raw-byte anchor identity this decision keeps.
- [ADR-0013](0013-anchor-identity-derives-from-raw-bytes.md) — upstream's referent for the same split.
- upstream `pi-better-edit@7e9c982` (`fix(canon): fence stored canon evidence by snapshot epoch`, PR #340) — the implementing source.
- `test/core/snapshot-epoch-isolation-221.test.ts`, `test/integration/undo-canon-epoch.test.ts`, `test/core/undo-generation-gate.test.ts` — the fence, the restore and the retention-versus-validity arms.

## Amendment (2026-11-25, #222)

The sweep now clears only the v7 family: `served_session_meta` is the served-state table it wipes wholesale, while the v6 shells (`served`, `snapshots`, `undo`) are v6-owned and are no longer deleted by a v7 sweep — strengthening ADR-0016's data-destruction rule, since a sweep that wiped them would destroy a live v6 session's data on a version flap. The retention-is-not-validity rule is unchanged: the stamp still keeps the full-epoch prefix for keyed rows and decides the whole unkeyed `served_session_meta` family, and a row that outlives the sweep is still refused at every reuse seam. See [ADR-0055](0055-served-session-meta-owns-live-state.md).
