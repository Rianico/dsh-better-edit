# ADR-0055 — `served_session_meta` owns the live v7 served state

Date: 2026-11-25

## Status

accepted (moves `HASH_STORE_VERSION` 8 → 9 with one forward copy step; amends [ADR-0016](0016-store-version-flap-guard.md)'s shell/version boundary and [ADR-0054](0054-snapshot-epoch-fence.md)'s sweep subject)

## Context

ADR-0016 §Schema v7 already named `served_session_meta` as the per-session, per-file reported state, but v7 never used it. The live per-(session, path) facts — the served mirror (`hashes`), the reported dedup set, the retired set, the hazard cards and the canons — stayed on the v6 `served` shell, written through single-column `ON CONFLICT` upserts that re-created a shell row for every `reported`/`retired`/`canons`/`cards` write. The same store also kept a legacy `snapshots` adapter beside the v7 snapshot family and a dual-written `undo` mirror beside `file_undo`, so each read and write path had two owners and the pair rules had to keep both halves in step.

Upstream `pi-better-edit@af83291` (`refactor(store): consolidate dual-storage debt onto session meta`, PR #316, closes #307/#308) consolidated the same debt by dropping the bare `served`, `snapshots` and `undo` tables, deleting the JSON importer and the retired memory store, and relocating the real facts (`hashes`, `blocked_hashes`, `epoch_id`, `outline_folds`) onto `served_session_meta`. Downstream cannot take the drop: ADR-0016's shell-retention contract keeps the v6 shells at their exact shapes so an un-restarted v6 process never meets a missing table or a dropped column. This decision therefore consolidates the state only — one live owner — and leaves every v6 shell byte-shape intact.

## Decision

- **One live table for the served state.** `served_session_meta(session_id, file_path, hashes, reported, retired, canons, cards, updated_at)` with `PRIMARY KEY (session_id, file_path)`. The 15 `served*` prepared statements become 14 `servedMeta*` statements against it; the dead `servedAllForPath` scan is not replaced.
- **Downstream's vocabulary and evidence stay.** The retirement column is `retired` (ADR-0028's name; upstream's `blocked_hashes` is refused), and the hazard-card `canons`/`cards` pair is kept. There is no `epoch_id`: downstream's epoch evidence lives in `served_leases`/`file_snapshots` keys and is fenced by ADR-0054, not by a meta column. There is no `outline_folds` — downstream has no outline surface.
- **`HASH_STORE_VERSION` 8 → 9, one forward step.** `copyServedShellIntoMeta` runs inside the existing `BEGIN IMMEDIATE` of `migrateForward`, after `assertNotNewer` and ordered after `ensureSchema` (which creates the table and backfills the shell columns) and before the anchor-stamp sweep. It is a single `INSERT … SELECT … ON CONFLICT(session_id, file_path) DO NOTHING`.
- **`DO NOTHING`, never `DO UPDATE`.** A re-migration (a v8 stamp written after a downgrade) must not let the shell row clobber the live v7 row a concurrent v6 writer has since rewritten for the same key.
- **Legacy rows are not copied.** `snapshots` blob rows carry no line text, so no line identity can be derived from them; they are rebuilt from content on the next read (ADR-0016's existing rationale). `undo` rows are not copied either: v8 wrote the `file_undo` half of every live pair, and a legacy-only `undo` row is already refused by the pin gate, so no live record is lost.
- **The v6 shells are v6-owned.** `served`, `snapshots` and `undo` keep their exact v6 DDL, their column backfills (`served.cards`, `canons`, `retired`) and the pre-session-keyed `DROP TABLE served` guard, but v7 neither reads nor writes them: they are removed from the anchor-stamp sweep, from `allKnownPaths`, and from `pruneMissing`.
- **The legacy adapters are deleted.** The `snapshots` adapter in `src/snapshot-store/index.ts` and the pre-SQLite `hash-store.json` importer (`src/snapshot-store/migrate.ts`) are gone. `getSnapshot` is lineage-only; `upsertSnapshot` requires `content` (a plain `Error`, because the closed model-facing error registry has no `E_INTERNAL_INVARIANT`); the dead path-by-hash surface (`findSnapshotPathsByHashes`, `allSnapshotHashes`, `deleteSnapshot`, `findSnapshotPaths`) is removed.
- **`file_undo` is the sole undo row.** The pair rules collapse to one row: one upsert, one delete, one age prune on its own stamp. The pin it carries is the #221/ADR-0054 gate.
- **TTL keeps its shape.** The open-time janitor still runs one whole-row age delete (`DELETE FROM served_session_meta WHERE updated_at < ?`), so a stale `reported`/`cards` set can never outlive the mirror it describes.

## Consequences

- The warm served mirror, reported dedup set, retired set, canons and hazard cards survive the upgrade through the copy, so a migrated v8 store and a fresh v9 store behave identically afterwards.
- Copied anchors are reclaimable by the anchor-stamp sweep exactly as before: a foreign generation stamp clears the whole `served_session_meta` family. The ADR-0054 residual window (rows a concurrent v6 writer mints after the sweep) is unchanged.
- Legacy-only `snapshots` rows become a cache miss rebuilt from content; legacy-only `undo` rows stay unread, which ADR-0016 already records as safe.
- A v6 process that re-opens the store is refused as newer (`E_STORE_NEWER_VERSION`); an un-restarted v6 session still finds its shells intact, so the version flap stays survivable in the direction ADR-0016 protects.
- `pruneMissing` no longer stats or deletes v6-only paths: a path referenced only by a shell row is not v7's to reclaim.
- The prepared-statement count drops: `src/hash-store.ts` 39 → 33, `src/snapshot-store/index.ts` 4 → 0 (store layer 43 → 33).

## What this deliberately does not do

- It does not drop or reshape the v6 shells. That is ADR-0016's contract, taken upstream at the cost of a permanent shell.
- It does not copy legacy snapshot blobs or legacy-only undo rows.
- It does not adopt upstream's `epoch_id`, `outline_folds` or `blocked_hashes`.
- It does not change the canon/generation constants, the payload contract, the lease authority or the v6 shell DDL.
- It does not move the absorption cursor. `af83291` is a targeted defect/debt port, not a range absorb.

## References

- #222 — this change.
- [ADR-0016](0016-store-version-flap-guard.md) — the shell-retention contract, the version boundary and the legacy-import rationale this decision extends.
- [ADR-0028](0028-blocked-hash-vocabulary.md) — the `retired` name this table keeps.
- [ADR-0054](0054-snapshot-epoch-fence.md) — the epoch fence whose sweep subject narrows to the v7 family here.
- upstream `pi-better-edit@af83291` (`refactor(store): consolidate dual-storage debt onto session meta`, PR #316) — the implementing referent.
- `test/core/store-v9-migration.test.ts`, `test/core/v6-shell-compat-222.test.ts` — the forward copy and the shell contract on both sides.
