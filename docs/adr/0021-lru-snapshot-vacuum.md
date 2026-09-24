# ADR-0021 — The LRU snapshot vacuum: pin predicates, budgets and the reported deferral

Date: 2026-09-25
Status: accepted
Related: `src/snapshot-store/vacuum.ts` (new), `src/snapshot-store/index.ts` (re-exports),
`src/snapshot-store/lineage-store.ts` (`snapshotIdFor`), `src/hash-store.ts` (`upsertSnapshot`,
`commitSnapshot`, `vacuumSnapshots`), `src/store-lifecycle.ts` (`onStoreOpen`),
`src/constants.ts` (`SERVED_TTL_MS`), [ADR-0017](0017-content-addressed-line-identity.md),
[ADR-0020](0020-atomic-store-pairs-and-corrupt-lineage-repair.md), mvcc spec §3.6 item 1
(storage sizing and global eviction ordering) and §3.1 items 2-3 (the re-serve lease refresh).

## Context

The v7 identity substrate appends rows on every materialization: `file_snapshots` gains one row per
`(path, snapshot_hash)` and `line_lineage` one row per served line. At HEAD there was **no** pruner
for that family — `vacuumSnapshots` did not exist in any form (`git grep -c vacuumSnapshots -- src/`
→ 0), and the only deletes were whole-path `deleteByPath` (called from `pruneMissing`) and the
repair-at-detection discard of one unusable snapshot. The store was therefore unbounded: nothing
reclaimed a version no live anchor could still resolve through.

Two adjacent mechanisms were measured and are **not** this retention tier:

- `storeMaxAgeS` / `storeMaxTotalBytes` are read by the central janitor
  (`store-lifecycle.ts:169`, `:180`), which evicts whole `runtime/<name>-<hash8>/` **directories** —
  a different invariant with a different owner.
- the legacy `served` table already has its own TTL pruner at store open.

The pins existed as _data_ but not as _predicates_: `served_leases` rows and
`file_undo.snapshot_hash` were written and never read by any retention decision.

## Decision

### One row-family module, module-level policy

`src/snapshot-store/vacuum.ts` is the single owner of `file_snapshots` + `line_lineage` retention.
Its budgets are module-level policy, never call-site configuration:

| constant                        | value   | meaning                                                     |
| ------------------------------- | ------- | ----------------------------------------------------------- |
| `VACUUM_GLOBAL_BUDGET_BYTES`    | 50 MiB  | global CAS budget, priced `40 B × line_count` per snapshot  |
| `VACUUM_SOFT_OVERFLOW_BYTES`    | 100 MiB | tolerated soft-overflow window; governs the **report** only |
| `VACUUM_PER_PATH_BUDGET_BYTES`  | 10 MiB  | per-path window budget                                      |
| `VACUUM_MAX_SNAPSHOTS_PER_PATH` | 10      | window ceiling                                              |
| `VACUUM_MIN_SNAPSHOTS_PER_PATH` | 2       | window floor                                                |
| `VACUUM_LINEAGE_BYTES_PER_LINE` | 40      | the lineage price constant                                  |
| `VACUUM_RETIRED_PIN_MS`         | 1 h     | retired-lease grace                                         |

Per-path retention is `min(10, max(2, floor(10 MiB / (40 × newestLineCount))))`, sized against the
path's **newest** version. `vacuumSnapshots(db, options)` sweeps every committed snapshot
oldest-`created_at`-first (`snapshot_id` breaks ties, so equal-millisecond commits stay ordered),
deleting `line_lineage` **then** `file_snapshots` for each evicted version in one transaction
(`withTransaction`, the store's single re-entrant owner; `withBusyRetry` per statement).

The module owns its own prepared statements (cached per `DatabaseSync` in a `WeakMap`) rather than
routing through `hash-store`, which would close an import cycle: `hash-store → vacuum → hash-store`.

### The pin predicate and its two clocks

A version is **pinned** — never evicted, whatever the budgets say — when

```sql
EXISTS (SELECT 1 FROM served_leases sl
        WHERE sl.file_path = fs.path AND sl.served_snapshot_hash = fs.snapshot_hash
          AND ((sl.retired_at IS NULL AND sl.updated_at >= :activeCutoff)
               OR sl.retired_at >= :graceCutoff))
OR EXISTS (SELECT 1 FROM file_undo fu
           WHERE fu.path = fs.path AND fu.snapshot_hash = fs.snapshot_hash)
```

plus `options.protectSnapshotIds`. `activeCutoff = now − SERVED_TTL_MS` (7 days, imported from
`src/constants.ts`), `graceCutoff = now − VACUUM_RETIRED_PIN_MS` (1 hour). The `updated_at` half
**is** the LRU-on-access semantic the spec calls for: a re-serve upserts the lease with
`updated_at = excluded.updated_at` (mvcc spec §3.1 items 2-3), which moves that version back out of
the eviction window. Retention therefore follows _use_, not insertion.

`file_undo.snapshot_hash` is the second, independent referent: an undo restore target survives a
pass that would otherwise evict it. That call is exercised end to end in interaction cell 13.

The predicate pins **one snapshot id per row** (`SELECT DISTINCT fs.snapshot_id`), never a path or a
hash alone — a path or hash is not an idempotent pin key.

### Two triggers

1. **Store open — the deterministic boundary.** `store-lifecycle.onStoreOpen` calls
   `store.vacuumSnapshots()` after the existing row TTLs and the throttled `pruneMissing`, inside
   its own `try`/`catch` that warns loudly. On this store the open path is the only place that can
   reclaim a store that crashed over budget.
2. **After an authoritative materialization.** `hash-store`'s `vacuumAfterMaterialization` runs
   after `upsertSnapshot` / `commitSnapshot` has committed, **outside** that call's
   `withTransaction` block. It is skipped when `db.isTransaction` is true — a materialization that
   joined a caller-owned unit (for example the serve write inside `recordServed`'s `withStore`)
   defers to the store-open pass rather than running a sweep inside another unit's writes. One read
   therefore performs exactly one sweep: the hash materialization is outermost, the serve
   materialization is nested.

The trigger passes `{ protectSnapshotIds: [justCommittedId] }`, resolved through the new
`lineageStore.snapshotIdFor(path, snapshotHashFor(content))`. Without it, an over-budget,
fully-unpinned store could evict the row it had just written, before the serve grants its lease.

### Report the deferral, never resolve it by evicting a pin

`deferredBytes = max(0, totalBytes − VACUUM_GLOBAL_BUDGET_BYTES)` and
`overSoftOverflow = deferredBytes > VACUUM_SOFT_OVERFLOW_BYTES − VACUUM_GLOBAL_BUDGET_BYTES`.
When the soft-overflow state holds and holds for the first time on that `DatabaseSync`, the pass
emits one operator-visible `console.warn` (transition-in throttle, re-armed by a non-overflowing
pass). A pin is the only copy of the lineage a live anchor resolves through, so the 100 MiB figure
never unlocks eviction of pinned rows — it only decides when the warning fires.

Both trigger sites are best-effort but **never silent**: the post-materialization arm catches and
reports through `console.warn` carrying the error, because a retention fault must never fail a read
or edit that already committed, and must never disappear either (the storage-error-transparency
rule this project has already paid for twice). Interaction cell 15 mutation-proves it.

### Declared non-reclaims

The pass never touches, each for a stated reason:

- **`line_id_counters`** — the ID-reuse invariant (mvcc spec §3.6 item 3): a surviving lease must
  never have its `line_id` re-issued. Only `pruneMissing` / `deleteByPath` may drop a counter row,
  and only together with the path's snapshots _and_ leases.
- **`served_leases`** — the pin set is _computed from_ this table; the 7-day TTL and the 1-hour
  grace are **predicates, not pruners**. Consequence, stated as a limit: **`served_leases` rows are
  not reclaimed by the vacuum; that is a separate retention tier with no owner today.** Predicate
  trigger for owning it: the `served_leases` row count in a long-running store, or the first ticket
  that adds a session-teardown seam.
- **the legacy `snapshots` row** — it "does not reclaim the legacy `snapshots` row: one per
  path, overwritten, and the upgrade fallback" read by `getSnapshot` when the v7 family has no
  lineage (`hash-store.ts:811-823`). The legacy-`snapshots` ↔ `file_snapshots` pairing is a separate
  invariant with its own owner. Interaction cell 14 asserts the row survives the pass _and_ that a
  read after a full v7 prune re-materializes the v7 family rather than silently serving from it.
- **the legacy `served` table** — it already has a TTL pruner at store open.
- **no "always keep the newest" special case.** A path's newest version survives because the
  materialization protects its own id (§4) and because callers materialize before they serve;
  naming a newest-row exception would hide a pin bug.

## Considered options (why rejected)

- **A hard cap that evicts pins.** Rejected by the spec (ADR-0017, Considered Options): a pin is the
  only copy of the lineage a live anchor resolves through, so evicting one silently converts a live
  lease into a fail-closed rejection or, worse, a look-alike rebind. Report instead.
- **Per-table deletes (lineage in one unit, snapshot in another).** Rejected: an interrupted delete
  would leave the exact empty-lineage state the adopt arm has to repair, and `deleteByPath`'s
  precedent is one unit for both.
- **Eviction by `last_used_at` on `file_snapshots`.** Rejected: it would add a new column and a new
  writer to the CAS family for a signal the lease table already carries (`updated_at`), and the pin
  predicate would still need the lease join.
- **A `vacuum()` call-site option for the budgets.** Rejected: the spec fixes these as production
  policy; a call-site override is how a "declared" budget becomes an undeclared heuristic.
- **Reusing `deleteByPath` for eviction.** Rejected: it deletes the whole path family — counters and
  leases included — which is precisely what a retention pass must not do.

## Behaviour changes (T7 CHANGELOG inputs)

- New: `vacuumSnapshots(db, options?)` with `VacuumOptions` / `VacuumResult`, the seven
  `VACUUM_*` policy constants, and the `HashStore.vacuumSnapshots()` maintenance member.
- New: `LineageStore.snapshotIdFor(path, snapshotHash)`.
- Store open now also runs a retention sweep (best-effort, warned).
- Every v7 materialization now triggers a retention sweep (best-effort, warned, skipped inside a
  caller-owned transaction), and a soft-overflow pass warns once per store instance.

## Residuals (with triggers)

- **D1 — the served-guard true-LRU is not ported.** The referent (`src/hashline/served-guard.ts`,
  `SERVED_REFUSAL_MAX_ENTRIES = 256`, upstream `595692f`) is **not** an ancestor of the absorbed
  checkpoint `87a17eb` and the module does not exist on this tree. The in-process
  `src/noop-guard.ts:9` `noopLoopTracker` remains an unbounded `Map`. **Predicate trigger:** when
  `git -C ../pi-better-edit merge-base --is-ancestor 595692f <absorbed-checkpoint>` returns true,
  absorb the tracker and bound it. Out of lane here on three grounds: a different retention tier
  (in-process cache bytes, not CAS rows), an unabsorbed basis, and a lane already carrying the five
  interaction cells.
- **`served_leases` rows have no reclaimer** (see Declared non-reclaims above).
- **The in-flight protection is best-effort by construction:** if `snapshotIdFor` cannot resolve the
  just-committed row the sweep runs unprotected. It is resolved on every path that reaches the
  trigger; the residual risk (an over-budget, fully-unpinned store evicting the row it just wrote)
  is stated here rather than hidden.

## Void premises in the ticket (recorded, not invented around)

The CP1 ticket was written against the upstream referent, not this tree. Three of its assertions do
not hold here and were replaced by the tree's actual behaviour:

1. **Cell 11's expected rejection codes.** `E_UNVERIFIED_RANGE` and `E_TARGET_LOST` have no producer
   in this tree — `rg -n 'E_TARGET_LOST' src/` finds one comment inside `DEFERRED_PRODUCERS`. The
   measured fail-closed rejection for an evicted lease target is **`E_STALE_RANGE`** (inside the
   `E_BATCH_ABORT` envelope), with the "no longer resolves to the line identity it was served with"
   message and nothing written. Cell 11 asserts that measured code and asserts the absence of the
   two upstream-only codes, so the cell fails if either premise silently becomes true.
2. **Cell 13's "snapshot missing ⇒ loud undo failure" arm does not exist.** `undo_last_edit`
   restores from the content stored inline in the undo row; it never reads the snapshot
   (`rg -n 'snapshot_hash' src/tool-undo.ts` → 0 hits). A missing snapshot is therefore not a loud
   undo failure. What the cell can and does prove is the pin's _purpose_: with the leases aged out
   and the store over both budgets, the `file_undo` pin is the only thing that keeps the target, and
   the undo still restores. Dropping the pin clause makes that cell RED.
3. **Cell 12 is a guard, not a refutable oracle.** It pins the T3f invariant (a rejected edit is a
   no-op, and a read after a vacuum equals the on-disk bytes). No one-site mutation **inside this
   lane** makes it RED: the vacuum cannot change the read's inputs, so every in-lane mutant tried
   leaves it GREEN. Reported honestly as GREEN with diagnosis meaning (c): the claim is true but not
   falsifiable by mutating the code this lane owns. It stays as the regression guard for the
   interaction a future vacuum must not break.

## Reproduce

The mutation ledger for this ADR lives in `test/tools/mutate-ledger.mjs` (`T5M1`–`T5M15`). Recipe:
archive HEAD into a temp tree, apply the mutant to exactly one site, run the scoped corpus, compare
the failing cells with the table below, discard the tree. Expected RED sets were measured at
`ff03a7e` on the branch `fix/t5-vacuum`; re-run them to re-derive.

```bash
node test/tools/mutate-ledger.mjs --list          # ids, scopes, expected RED counts
node test/tools/mutate-ledger.mjs T5M4            # one mutant, both vacuum corpora
node test/tools/mutate-ledger.mjs T5M2 --keep     # keep the temp tree and the vitest log
```

| id    | site (one, in the mutated tree)                                 | scope                      | expected RED       |
| ----- | --------------------------------------------------------------- | -------------------------- | ------------------ |
| T5M1  | `vacuum.ts`: per-path arm dropped from the eviction condition   | `test/core/vacuum.test.ts` | 01, 03, 04         |
| T5M2  | `vacuum.ts`: global-budget arm dropped                          | unit                       | 02, 07, 08         |
| T5M3  | `vacuum.ts`: the pin probe returns `[]`                         | unit                       | 03, 04, 05, 06, 09 |
| T5M4  | `vacuum.ts`: the lease pin ignores `updated_at`                 | unit + interaction         | 04, 08, 10, 11, 14 |
| T5M5  | `vacuum.ts`: the retired-lease grace clause can never hold      | unit                       | 05                 |
| T5M6  | `vacuum.ts`: the `file_undo` pin can never match                | unit + interaction         | 06, 13             |
| T5M7  | `vacuum.ts`: `protectSnapshotIds` never applied                 | unit                       | 07                 |
| T5M8  | `vacuum.ts`: the sweep wipes `line_id_counters`                 | unit                       | 08                 |
| T5M9  | `vacuum.ts`: the soft-overflow report call deleted              | unit                       | 09                 |
| T5M10 | `lineage-store.ts`: `next_id` reset to 1                        | interaction                | 10                 |
| T5M11 | `vacuum.ts`: lease pin ignores `updated_at` (other corpus)      | interaction                | 10, 11, 14         |
| T5M12 | `vacuum.ts`: the sweep wipes `served_leases`                    | interaction                | 11                 |
| T5M13 | `vacuum.ts`: the `file_undo` pin can never match (other corpus) | interaction                | 13                 |
| T5M14 | `vacuum.ts`: the sweep also deletes the legacy `snapshots` row  | interaction                | 11, 14             |
| T5M15 | `hash-store.ts`: the post-materialization catch swallows        | interaction                | 15                 |

Cell 12 is GREEN under every one of the fifteen mutants (see Void premise 3).

Cells 01–09 are unit cells over `new DatabaseSync(":memory:")` + `createLineageStore`; cells 10–15
drive the real `read` / `edit` / `undo_last_edit` tools over a temp workspace and the live store.
Every cell's corpus is a `test/core/vacuum*.test.ts` file, so each mutant's RED set is exact.

## Consequences

- The CAS family now has exactly one retention owner, and the two pins have exactly one reader —
  the predicate. A future change to lease semantics (a new pin source, a new retire path) must
  touch the predicate, which is why the predicate lives in one prepared statement with a WHY block
  beside it.
- The store-open pass makes a crashed-over-budget store self-healing, and the materialization pass
  keeps a live store bounded without a timer.
- `HashStore.vacuumSnapshots()` joins the maintenance family (`pruneUndoOlderThan`,
  `pruneMissing`), so `store-lifecycle` still cannot reach into a row family it does not own.
- The three void premises above are the ticket-level cost of porting a v1-era brief onto this tree;
  they are recorded rather than absorbed silently, and each is now an assertion that fails if the
  upstream behaviour ever arrives without this ADR being revisited.
