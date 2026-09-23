# ADR-0017 — Content-Addressed Line Identity

Date: 2026-09-23
Status: accepted
Related: `src/snapshot-store/lineage-store.ts`, `src/hash-store.ts`
(`getSnapshot`, `buildStore`), `docs/adr/0016-store-version-flap-guard.md`

## Context

Anchors (`hash → position`) are rewrite-unstable: any edit reassigns them, so
a lease that names only an anchor cannot survive the edit it is supposed to
track. Upstream solves this with content-addressed line identity plus MVCC
(upstream ADR `content-addressed-line-identity-mvcc`, and the
upstream ADR-0016/0022/0023 lineage); T7 reconciles numbering/parity work —
the patience engine itself is deliberately not ported here (see Decision).

## Decision

Line identity is content-addressed and append-only:

- **Tables.** `file_snapshots` keyed `(path, snapshot_hash)` with
  `snapshot_hash = ${CANON_VERSION}:${contentChecksum(content)}` (the single
  key derivation, shared with the legacy row so both name the same content);
  `line_lineage (snapshot_id, line_number)` carrying `line_id`, `canon_hash`,
  `anchor`; `line_id_counters (path, next_id)`; `served_leases` bound to
  `(session_id, file_path, anchor)` with `line_id`, `canon_hash`,
  `served_snapshot_hash`, `served_line_number`.
- **Adoption allocates nothing.** Re-committing byte-identical content resolves
  the existing `(path, snapshot_hash)` row and writes no lineage and touches no
  counter; leases still grant against the adopted snapshot. Adopt refreshes the `anchor`
  column to the live assignment (compare-then-update, differing rows only); `line_id`,
  `canon_hash` and the counter never change at adopt.
- **Canonical-form pairing (deterministic rules 1–4).** A new snapshot inherits
  `line_id`s from the path's latest committed snapshot: (1) same line number
  and same `canon_hash` wins; (2) a remaining line whose canon matches exactly
  one unclaimed previous line inherits it (moved lines keep identity);
  (3) ambiguous/duplicate canons resolve to the lowest unclaimed previous line
  number; (4) everything else takes fresh ids in line order from one counter
  upsert. Divergence from upstream is deliberate: upstream pairs by patience
  LCS, we pair by canonical form — simpler, deterministic, no
  iteration-order dependence.
- **One digest definition.** `canonDigest(line) = String(xxh32(canon(line)))`
  is the single definition of `served_leases.canon_hash` /
  `line_lineage.canon_hash`; leases carry the digest, and every canon
  comparison in the heal path compares digests on both sides.
- **Named-snapshot binding, never "latest".** `commitSnapshot` resolves lease
  rows through the lineage of the snapshot being committed (adopted or
  inserted), inside the same `BEGIN IMMEDIATE` as the snapshot write. Lease ⇒
  lineage invariant: no lease can point at a snapshot that was never recorded,
  and re-serving old rows after newer snapshots exist still binds the old
  snapshot's lineage.
- **Anchor assignment is not content-determined — and that is why the refresh exists.**
  The same content re-hashed under different retire/reservation sets gets different
  anchors, so the stored `anchor` column goes archaeological while identity stays put.
  Without the adopt refresh, `getSnapshot` would return retired hashes and the lease
  grant's `byAnchor` lookup would silently miss (fail-closed, no lease). The refresh
  keeps the lineage tracking the live assignment inside the same transaction.
- **Live read prefers lineage-with-refresh over the legacy overwrite cache.**
  `HashStore.getSnapshot` materializes anchors from `line_lineage` ordered by
  `line_number` when present, falling back to the legacy row (corrupt-row healing
  applies to the fallback only). Lineage-first is correct only because the adopt
  refresh keeps it live; the legacy row overwrites per hash and cannot serve as the
  identity source. Cross-path scans stay on the legacy table this round.

## Non-changes recorded

- **`served.canons` mirror retained.** v7 stores digests, not canonical text,
  and the read path's stable-hash reuse needs the text at serve time —
  recomputing it from disk on every read would reintroduce the TOCTOU the
  mirror exists to close. Retirement trigger: a canonical-text source lands
  with T3 or later; the mirror goes when the text has a v7 home.
- **`retired`-column wipe retired this round.** The one-shot `DELETE FROM
snapshots` / `DELETE FROM undo` that ADR-0016 left in place (pending CP4)
  is deleted: an upgrade must never destroy snapshot/undo rows. The idempotent
  `ALTER TABLE served ADD COLUMN retired` stays, minus its transaction
  scaffolding (a single atomic ALTER needs none).

## Consequences

- Crash safety is transactional per commit (snapshot + lineage + leases in one
  unit); cross-commit consistency (undo lease restore) is CP4.
- Pairing-rule changes are data-compatible only forward: new snapshots pair
  against whatever lineage exists; old rows are never rewritten.
- Read together with `0016-store-version-flap-guard.md`: 0016 made store open
  non-destructive; this ADR makes the upgrade path non-destructive too. The
  two store ADRs are a deliberate divergence from upstream as a pair.
