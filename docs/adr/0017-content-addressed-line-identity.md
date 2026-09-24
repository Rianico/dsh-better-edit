# ADR-0017 — Content-Addressed Line Identity

Date: 2026-09-23
Status: accepted; **superseded in part — the pairing rule by [ADR-0019](0019-lease-identity-served-span-resolution.md), the corrupt-lineage throw by [ADR-0020](0020-atomic-store-pairs-and-corrupt-lineage-repair.md); see the Amendment below**
Related: `src/snapshot-store/lineage-store.ts`, `src/hash-store.ts`
(`getSnapshot`, `buildStore`), `docs/adr/0016-store-version-flap-guard.md`

## Context

Anchors (`hash → position`) are rewrite-unstable: any edit reassigns them, so
a lease that names only an anchor cannot survive the edit it is supposed to
track. Upstream solves this with content-addressed line identity plus MVCC
(upstream ADR `content-addressed-line-identity-mvcc`, and the
upstream ADR-0016/0022/0023 lineage); T7 reconciles numbering/parity work —
the patience engine itself is deliberately not ported here (see Decision). **[False as of T3c CP1-r2 — see the Amendment below.]**

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
  **[Superseded by [ADR-0019](0019-lease-identity-served-span-resolution.md) — see the Amendment
  below: the patience/LIS engine is ported, and an ambiguous interval pairs nothing.]** The text above
  is left as written.
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

## Amendment (2026-09-24) — the patience engine is ported; ambiguous intervals pair nothing

Superseded in part by [ADR-0019](0019-lease-identity-served-span-resolution.md). The historical text
above is annotated, not rewritten.

- **`:15` is false now.** The patience engine **is** ported: `src/snapshot-store/pairing.ts` is a
  verbatim port of upstream `pi-better-edit@00f8c34 src/hashline/patience-pairing.ts` — `diff -u`
  against upstream reports only the added `@module` tag. Its 30 upstream oracles
  live in `test/core/pairing.test.ts`.
- **Rule (3) is superseded.** An ambiguous/duplicate interval pairs **nothing**; the current line takes
  a fresh id. Pinned by `test/core/lineage-store.test.ts`: "duplicate canon pairs nothing — the current
  line takes a fresh id" (`[4]`, where the FIFO rule produced `[2]`), "a bare symmetric swap retires
  both lines" (`[3,4]`), "a duplicate exterior insert leaves the duplicated identity unpaired"
  (`[4,5,2,3]`).
- **Why it had to change, measured.** On the two-rule FIFO pairing the deleted-twin contract fixture
  handed the surviving twin the deleted line's `line_id` (lineage `[1,3,4,5,2,7]`); the engine leaves it
  unpaired (`[1,3,4,5,6,7]`). Pinned by `test/core/lineage-store.test.ts` ("the deleted twin does not
  inherit the deleted line's lineId (contract fixture)"). That difference is what makes ADR-0019's
  look-alike-rebind rejection hold.
- **What did not change.** Tables, key derivation, the adopt-no-allocate rule, the anchor refresh, the
  named-snapshot binding and the one-digest definition above all stand; the engine replaced only the
  pairing rule.

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
  unit); cross-commit consistency (undo lease restore) is CP4. The transitional
  dual-write is NOT atomic: `upsertSnapshot` commits the legacy row in its own
  transaction before the lineage commit, so a lineage failure leaves a legacy row
  with no lineage — by design the read prefers lineage when present and falls
  back to legacy otherwise.
- Corrupt snapshots are diagnosed, never silently ignored: adopt on a snapshot row
  whose lineage `diagnoseUnusableLineage` rejects **repairs** it — the unusable
  family is discarded and re-materialised fresh inside the caller's unit, with a
  `console.warn` naming the arm (ADR-0020; nothing in `src/` throws
  `LineageCorruptError`, and the empty-lineage arm is message precision only —
  reachable only with `stored.length === 0 && lineCount ≥ 1`, where the next check
  returns the same class of error and the same repair). Pinned by
  `test/core/lineage-store.test.ts` "adopt with emptied lineage repairs it instead
  of silently no-oping". The read serves a lineage hit only when its length matches
  the content, `line_number`s are dense 1..N, and every anchor matches `HASH_RE` —
  the dense clause pinned by `test/core/hash-store.test.ts` "getSnapshot falls back
  to valid legacy anchors when the lineage family is corrupt", the `HASH_RE` clause
  by "lineage with a corrupt anchor falls back instead of serving it".
- Pairing-rule changes are data-compatible only forward: new snapshots pair
  against whatever lineage exists; old rows are never rewritten.
- Read together with `0016-store-version-flap-guard.md`: 0016 made store open
  non-destructive; this ADR makes the upgrade path non-destructive too. The
  two store ADRs are a deliberate divergence from upstream as a pair.

## Restore and pair-age semantics

- `restore` puts the prior v7 row back **content-identical with a fresh pair
  stamp**: the bytes are the pre-edit content, but `undo.updated_at` and
  `file_undo.updated_at` are rewritten together from the store's single clock
  (`writeUndoPairImpl`'s one `stamp`). Pinned by `test/core/hash-store.test.ts`
  "restore puts the prior v7 row back content-identical with a fresh pair stamp".
- The pair's age is a **pair property**, not a per-row one: `pruneUndoOlderThan`
  prunes a path only when its **newest** side is older than the cutoff, so a
  recently written side keeps the whole pair alive. Splitting the pair across two
  independent per-table deletes is the F1 class this rule exists to prevent.

## Named deviation (T2b-scoped): fresh anchors after undo, not same-string revival

- Upstream consumes `file_undo.snapshot_hash` via `anchorsForSnapshotHash`
  (`../pi-better-edit/src/edit-undo.ts:183-196`) and serves the pinned snapshot's
  anchors, so `read → edit → undo` revives the _same_ anchor strings.
- Our tree serves **fresh** anchors after undo: `line_lineage.anchor` is a
  current-assignment record refreshed on adopt (CP3), and assignment is
  retire/reservation-dependent — a snapshot keeps no anchor history. The undo
  rehash excludes retired/reserved assignments (`removedHashes` /
  `blockedRestoreHashes`), so a retired anchor is never resurrected.
- Therefore the restored lines keep their pre-edit `line_id` and the undo
  response is self-consistent, while a stale handle fails loudly
  (`E_STALE_ANCHOR`, pinned by the CP4 undo-leases test). **Named deviation,
  T2b-scoped** — accepted conditional on that pin.
- Follow-up trigger: _anchor history for same-string revival_ — needed before
  any consumer relies on pre-edit anchor strings surviving an undo (T3
  verification or later); reference upstream `edit-undo.ts:188`.
