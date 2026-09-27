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
pass that would otherwise evict it. That call is exercised end to end by the undo-pin cell in the
interaction corpus.

The predicate pins **one snapshot id per row** (`SELECT DISTINCT fs.snapshot_id`), never a path or a
hash alone — a path or hash is not an idempotent pin key.

### Two triggers, one report owner

1. **Store open — the deterministic boundary.** `store-lifecycle.onStoreOpen` calls
   `store.vacuumSnapshots()` after the existing row TTLs and the throttled `pruneMissing`, and hands
   the returned result to `reportVacuum`. Its `try`/`catch` warns loudly and **names the store**,
   then lets `onStoreOpen` resolve: on this store the open path is the only place that can reclaim a
   store that crashed over budget, and a retention fault must be loud but non-fatal (pinned by the
   store-open failure cell).
2. **After an authoritative materialization.** `hash-store`'s `vacuumAfterMaterialization` runs
   after `upsertSnapshot` / `commitSnapshot` has committed, **outside** that call's
   `withTransaction` block, and reports through the same `reportVacuum`. It guards only
   `content === undefined` — a legacy-only write materializes no v7 row, so there is nothing to
   protect or sweep for (the legacy-only upsert cell) — and leaves the deferral to the sweep.

**The deferral lives in the sweep, for atomicity.** `vacuumSnapshots`' first statement returns a
`skippedInTransaction` result when `db.isTransaction` is true. TM probe M1 measured why: the
`withTransaction` in `deleteVacuumSnapshots` _joins_ a caller-owned unit rather than raising, so a
joined sweep is nesting-safe — but a mid-loop ABORT inside that unit leaves the pair invariant
broken (`lineageLessSnapshots = 1`) even after the caller's COMMIT, while the same ABORT at the
outermost boundary rolls the whole sweep back. One sweep is therefore one atomic unit, and putting
the guard in the sweep rather than at the call site makes `HashStore.vacuumSnapshots()` safe from
any call site by construction. `skippedInTransaction` is what keeps the zero counters from reading
as "swept, nothing to reclaim": `reportVacuum` reports a skip as a skip.

The materialization trigger passes `{ protectSnapshotIds: [justCommittedId] }`, resolved through the
new `lineageStore.snapshotIdFor(path, snapshotHashFor(content))`. This is load-bearing, not
defensive: the in-flight-protection cell injects a fault on the delete of exactly the row a read has
just materialized and
asserts the sweep never targets it — dropping the resolution at the trigger (T5M20), or its
application in the sweep (T5M7), turns cells RED. The measured reachable shape is the **read** path's
hash materialization (outermost, the `hash.ts` write), not the edit path, whose v7 write is the
serve write inside `recordServed`'s `withStore` and therefore defers.

### One report owner: payload coverage, a reported skip, a bounded throttle

`deferredBytes = max(0, totalBytes − VACUUM_GLOBAL_BUDGET_BYTES)` and
`overSoftOverflow = deferredBytes > VACUUM_SOFT_OVERFLOW_BYTES − VACUUM_GLOBAL_BUDGET_BYTES`.

`reportVacuum(result, context)` is the **single report owner**: the sweep never writes to the
console, and both triggers call it. It reports when `deferredBytes > 0 || overSoftOverflow`, and the
warning carries the payload — `totalBytes`, `pinnedBytes`, `deferredBytes` — because a call-count
assertion is not a claim about what an operator can see: the report-payload cell asserts the exact
numbers on an
over-budget, under-soft-cap pass, where r1's `overSoftOverflow`-only reporter was silent. A
`skippedInTransaction` result is reported as a skip, so "0 bytes deferred" can never be read as
`skippedInTransaction` result is reported as a skip, so "0 bytes deferred" can never be read as
"nothing to do" (the materialization-report cell). A pin is the only copy of the lineage a live anchor
resolves through, so
the 100 MiB figure never unlocks eviction of pinned rows — it only decides when the warning fires.

The throttle is transition-in and **bounded**: two module-level ledgers keyed by `context` (the
stable site + store identity the triggers pass), each capped at `REPORT_CONTEXT_CAP = 256` with
oldest-inserted eviction. An unthrottled warning would fire on every read and edit while the store
stays over the soft cap; unbounded global state is the leak this project has already paid for. The
overflow ledger re-arms when a pass reports no deferred bytes (the report-payload and report-re-arm
cells pin both halves); the skip
ledger reports once per context, because a skip is a property of the call site rather than of the
store's byte state. The cost of the cap is stated: a process touching more than 256 contexts can
re-report an evicted context once — observability only. The ledgers are **process-global module
state**, so a context must be unique per store _and_ per test: two callers reusing one context string
share a single throttle entry. That is the declared limit of a module-level ledger, and it is the
reason the cap exists; the report-ledger cap cell pins it by bracketing the boundary — of `cap + K`
fresh contexts the K
oldest report again and the K newest stay silent (the cap value is never asserted: one referent that
cannot fail proves nothing).

The store face returns the result (`HashStore.vacuumSnapshots(): VacuumResult`), **superseding the
void maintenance seam** this ADR recorded in r1: the trigger — not the sweep — decides what an
operator sees, so the result must reach the caller. Both trigger sites are best-effort but **never
silent**: the materialization arm catches and reports through `console.warn` carrying the error,
because a retention fault must never fail a read or edit that already committed, and must never
disappear either (the storage-error-transparency rule this project has already paid for twice).
The best-effort-failure interaction cell mutation-proves it, and the store-open failure cell pins the
store-open twin.

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
  lineage (`src/hash-store.ts:861`). The legacy-`snapshots` ↔ `file_snapshots` pairing is a separate
  invariant with its own owner. The cross-table interaction cell asserts the row survives the pass _and_ that a
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
- Every v7 materialization now triggers a retention sweep (best-effort, reported, deferring inside a
  caller-owned transaction), and `reportVacuum` covers `deferredBytes > 0 || overSoftOverflow` with
  the payload, reports a skipped sweep as a skip, and throttles per context with a 256-entry cap.
- `HashStore.vacuumSnapshots()` returns `VacuumResult` (supersedes the void seam recorded in r1),
  and `reportVacuum(result, context)` is the single report owner both triggers call.

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

### Declared limits (with predicate triggers)

- **One transaction per sweep, at the boundary.** An interrupt between the pair's two deletes rolls
  back, so it cannot be observed at the boundary: the crash-mid-pair cell injects the fault, asserts
  post-fault counts are unchanged (12 snapshots / 36 lineage rows in its shape) and then
  `orphanLineage === 0`.
  The mirror shape — a `file_snapshots` row with no lineage, the codebase's "orphan snapshot row" —
  is **not** repaired here: the adopt/serve path already detects, warns about and repairs it
  (`src/hash-store.ts:849-861`, proven by `test/core/hash-store.test.ts:1665-1706`), and a second
  owner could disagree with the first while both appear to work. Predicate trigger: any sweep path
  that is not wrapped by `withTransaction`.
- **An FK-ON opener masks the explicit pair delete.** Measured (P1 matrix): the explicit
  `deleteLineage` removes `1 → 0` lineage rows per eviction, so it is not a delete that deletes
  nothing; on an FK-ON opener the `line_lineage → file_snapshots` cascade would remove them anyway;
  on an FK-off opener it is the sole remover. No opener in production is FK-off (node:sqlite enables
  post-state effect is masked there — the ledger records that verdict and its meaning for T5M22/T5M26,
  never as evidence that the line is dead.
- **A fail-closed serve grant can leave a served row without a lease.** `session-view.ts:267-268`
  returns early when the serve has no `content`/`hashes` (or a length mismatch), so no lease pins the
  snapshot those anchors came from; the sweep may evict it and the next edit then fails closed
  (measured `E_STALE_RANGE`). Predicate trigger: any served row whose anchor resolves with no lease.
- **An expired `file_undo` row still pins until store open.** `pruneUndoOlderThan` runs at store open
  before the sweep, so a post-materialization sweep sees an undo row past `undo_ttl_s` as still
  pinning. Predicate trigger: a `file_undo` row older than `undo_ttl_s` at a post-materialization
  sweep.

## Void premises in the ticket (recorded, not invented around)

The CP1 ticket was written against the upstream referent, not this tree. Six of its assertions did
not hold here and were replaced by the tree's actual behaviour — items 1–3 by a stronger assertion,
items 4–6 by a measured GREEN with its diagnosis:

1. **The evicted-target rejection codes.** `E_UNVERIFIED_RANGE` and `E_TARGET_LOST` have no producer
   in this tree — `rg -n 'E_TARGET_LOST' src/` finds one comment inside `DEFERRED_PRODUCERS`. The
   measured fail-closed rejection for an evicted lease target is **`E_STALE_RANGE`** (inside the
   `E_BATCH_ABORT` envelope), with the "no longer resolves to the line identity it was served with"
   message and nothing written. That cell asserts the measured code and asserts the absence of the
   two upstream-only codes, so the cell fails if either premise silently becomes true.
2. **The undo pin's "snapshot missing ⇒ loud undo failure" arm does not exist.** `undo_last_edit`
   restores from the content stored inline in the undo row; it never reads the snapshot
   (`rg -n 'snapshot_hash' src/tool-undo.ts` → 0 hits). A missing snapshot is therefore not a loud
   undo failure. What the cell can and does prove is the pin's _purpose_: with the leases aged out
   and the store over both budgets, the `file_undo` pin is the only thing that keeps the target, and
   the undo still restores. Dropping the pin clause makes that cell RED.
3. **The reject-no-op cell no longer needs a guard exemption.** Its r1 form could not be made RED
   in-lane; r2
   strengthened it to assert that the boundary actually removed the v7 row the rejected edit was
   resolved against (the pre-edit content), so dropping the lease-recency pin (T5M4/T5M11) turns it
   RED.
4. **A6's "make a legacy serve return something wrong" pin is covered, not refutable.** The cross-table cell
   diverges the legacy `snapshots.hashes` row for the path after the prune and still asserts the
   served anchors equal the on-disk lineage; disabling `getSnapshot`'s lineage-first branch (T5M28)
   leaves that unrefuted, because the anchors are validated and re-materialized downstream of
   `getSnapshot` (the hash phase and the serve write). The ledger records that verdict and its
   meaning — the effect is covered by another mechanism. The D2 hazard itself is pinned by the
   cross-table cell's re-materialization assertion (the path's v7 row count is 1 after the read) and
   by `test/core/hash-store.test.ts`'s three cells.
5. **F5's order-swap mutant is covered, not refuted.** T5M22 (swap the pair deletes) and T5M26 (drop
   the explicit lineage delete) are both masked by the FK cascade on every opener in use — the ledger
   records that verdict and its meaning (P1 matrix). That is not evidence that the order is free: the
   pair-invariant cell asserts the invariant FK-mode-agnostically, and the crash-mid-pair cell asserts
   the boundary rollback.
6. **The ticket's empty-content aside is not written anywhere here**, because `splitLines("")`
   returns `[""]` (`src/utils.ts:14-18`), so near-empty content also fails `getSnapshot`'s lineage
   length check and falls back to the legacy row.

## Reproduce

The mutation ledger for this ADR lives in `test/tools/mutate-ledger.mjs` (`T5M1`–`T5M30`). Recipe:
archive HEAD into a temp tree, apply the mutant to exactly one site, run the scoped corpus, compare
the failing cells, discard the tree. Every expected set is verified at the revision the run asserts —
the run prints that revision (`revision <sha>`, `worktree clean`) and `--expect-rev=<sha>` refuses
loudly on mismatch, so a stale expectation cannot pass quietly. Re-run them to re-derive with
`node test/tools/mutate-ledger.mjs T5M<id> --expect-rev=$(git rev-parse HEAD)`. Behavioural provenance
rather than a revision claim: `T5M30`, the cap bracket, was measured after the CP2-r3 cell landed.

```bash
node test/tools/mutate-ledger.mjs --list          # ids, scopes, RED counts, per-mutant rationale
node test/tools/mutate-ledger.mjs T5M20           # one mutant, its corpus
node test/tools/mutate-ledger.mjs T5M2 --keep     # keep the temp tree and the vitest log
```

> The authoritative expected RED sets, scopes and per-mutant rationale are what the ledger prints:
> `node test/tools/mutate-ledger.mjs --list`, asserted at the revision under test with
> `--expect-rev=$(git rev-parse HEAD)`. This table is explanatory only; it is not a second source of
> truth.

| mutant | one site, and what it is for                                                        |
| ------ | ----------------------------------------------------------------------------------- |
| T5M1   | `vacuum.ts`: the per-path retention arm (dropping it stops per-path eviction)       |
| T5M2   | `vacuum.ts`: the global-budget arm (dropping it stops global eviction)              |
| T5M3   | `vacuum.ts`: the pin probe (returning nothing unpins everything)                    |
| T5M4   | `vacuum.ts`: the lease pin's `updated_at` half, the LRU-on-access semantic          |
| T5M5   | `vacuum.ts`: the retired-lease grace clause                                         |
| T5M6   | `vacuum.ts`: the `file_undo` pin                                                    |
| T5M7   | `vacuum.ts`: the in-sweep application of `protectSnapshotIds`                       |
| T5M8   | `vacuum.ts`: the `line_id_counters` non-reclaim                                     |
| T5M9   | `vacuum.ts`: the overflow warning (the deferred state must be reported)             |
| T5M10  | `lineage-store.ts`: the monotone `next_id` counter                                  |
| T5M11  | `vacuum.ts`: the lease pin's `updated_at` half, in the interaction corpus           |
| T5M12  | `vacuum.ts`: the `served_leases` non-reclaim                                        |
| T5M13  | `vacuum.ts`: the `file_undo` pin, in the interaction corpus                         |
| T5M14  | `vacuum.ts`: the legacy `snapshots` non-reclaim (D2)                                |
| T5M15  | `hash-store.ts`: the best-effort trigger's observable failure                       |
| T5M16  | `vacuum.ts`: the in-sweep deferral guard (atomicity at the boundary)                |
| T5M17  | `hash-store.ts`: the content-less early return (a legacy-only write sweeps nothing) |
| T5M18  | `vacuum.ts`: the overflow dedup, the transition-in throttle                         |
| T5M19  | `vacuum.ts`: the throttle re-arm                                                    |
| T5M20  | `hash-store.ts`: the trigger's resolution of the in-flight id                       |
| T5M21  | `store-lifecycle.ts`: the store-open trigger's report                               |
| T5M22  | `vacuum.ts`: the pair-delete order (child before parent)                            |
| T5M23  | `vacuum.ts`: the `file_undo` pin's path clause (no over-broad pin)                  |
| T5M24  | `hash-store.ts`: the materialization trigger's report                               |
| T5M25  | `store-lifecycle.ts`: the store-open catch (loud, non-fatal)                        |
| T5M26  | `vacuum.ts`: the explicit lineage delete (defensive, cascade-masked)                |
| T5M27  | `vacuum.ts`: the sweep's transaction wrapper (one atomic unit)                      |
| T5M28  | `hash-store.ts`: `getSnapshot`'s lineage-first branch                               |
| T5M29  | `session-view.ts`: the serve write's v7 materialization                             |
| T5M30  | `vacuum.ts`: the report-ledger cap check (eviction)                                 |

A GREEN verdict is possible for four reasons: (1) a real gap, (2) the mutation did not apply, (3) the
claim was too strong, (4) another mechanism covered the effect. Which reason applies to which mutant is
not stated here: the ledger prints `RED=0` and the meaning beside each mutant it diagnoses, and that
print is the record.

A sweep of every in-repo `T5M[0-9]+` occurrence, rooted at
`/Users/zhengxk/development/ai/dsh-better-edit.fix-t5-vacuum`, returns exactly two files: the ledger
`/Users/zhengxk/development/ai/dsh-better-edit.fix-t5-vacuum/test/tools/mutate-ledger.mjs`, which is the
single authoritative source for these sets, and this ADR
`/Users/zhengxk/development/ai/dsh-better-edit.fix-t5-vacuum/docs/adr/0021-lru-snapshot-vacuum.md`,
which is the only in-tree copy of them. The sweep is repo-scoped **by construction**: `.lsz/tmp` is a
symlink and `rg` does not follow symlinks, so the write-once handoff records under it are not reached —
a feature, because transport cannot then be mistaken for an artefact. "Every in-repo copy is two files"
is therefore a different claim from "every copy anywhere is two files"; any sweep intending to cross
that boundary must say so.

## Consequences

- The CAS family now has exactly one retention owner, and the two pins have exactly one reader —
  the predicate. A future change to lease semantics (a new pin source, a new retire path) must
  touch the predicate, which is why the predicate lives in one prepared statement with a WHY block
  beside it.
- The store-open pass makes a crashed-over-budget store self-healing, and the materialization pass
  keeps a live store bounded without a timer.
- `HashStore.vacuumSnapshots()` joins the maintenance family (`pruneUndoOlderThan`,
  `pruneMissing`), so `store-lifecycle` still cannot reach into a row family it does not own.
- The void premises above are the ticket-level cost of porting a v1-era brief onto this tree; they
  are recorded rather than absorbed silently, and each is an assertion that fails if the upstream
  behaviour ever arrives without this ADR being revisited (items 4–6 that way round: the GREEN
  mutants are recorded with their meaning, so a later reader cannot mistake coverage for a gap).
