/**
 * The v7 snapshot family's retention owner: the bounded cache of file versions.
 *
 * WHY — global LRU vacuum (spec §3.6.1). The CAS store is a bounded cache: 50 MB globally, and
 * `min(10, max(2, floor(10 MB / snapshot_lineage_bytes)))` versions per path where
 * `snapshot_lineage_bytes ≈ 40 × line_count`. Eviction is global and oldest-`created_at` first
 * across all paths. Identity wins over budget: a snapshot a session can still resolve through —
 * an active lease inside the 7-day TTL, a `file_undo.snapshot_hash` restore target, or a lease
 * retired inside the 1-hour grace — is PINNED and never evicted, so the vacuum only drops versions
 * no live anchor points at. When every remaining candidate is pinned the vacuum defers, permitting
 * a soft overflow that in practice lapses as leases expire; `deferredBytes` / `overSoftOverflow`
 * report that state and the 100 MB ceiling governs only the report.
 *
 * The budgets are the production policy the store that owns `file_snapshots` / `line_lineage`
 * enforces; they are module-level policy, never call-site configuration (ADR-0017).
 *
 * Never touched by the pass, each for a stated reason: `line_id_counters` (the ID-reuse invariant
 * — a surviving lease must never have its `line_id` re-issued), `served_leases` (the pin set is
 * *computed from* this table; the TTL and grace are pin predicates, not pruners), and the legacy
 * `snapshots` row (one row per path, overwritten, and the documented upgrade fallback).
 * @module dsh-better-edit/snapshot-store/vacuum
 */
import type { DatabaseSync } from "node:sqlite";
import { SERVED_TTL_MS } from "../constants.js";
import { withBusyRetry } from "../store-retry.js";
import { withTransaction } from "./txn.js";

export const VACUUM_GLOBAL_BUDGET_BYTES = 50 * 1024 * 1024;
export const VACUUM_SOFT_OVERFLOW_BYTES = 100 * 1024 * 1024;
export const VACUUM_PER_PATH_BUDGET_BYTES = 10 * 1024 * 1024;
export const VACUUM_MAX_SNAPSHOTS_PER_PATH = 10;
export const VACUUM_MIN_SNAPSHOTS_PER_PATH = 2;
export const VACUUM_LINEAGE_BYTES_PER_LINE = 40;
export const VACUUM_RETIRED_PIN_MS = 60 * 60 * 1000;

/** Bounds for one vacuum pass; the policy values are the module-level production constants. */
export interface VacuumOptions {
  /**
   * Snapshot ids that must survive this pass regardless of budget or per-path retention: the
   * version an in-flight materialization is about to serve. The sweep runs before `served_leases`
   * exists for that version, so without this the freshly materialized row is the unpinned
   * candidate oldest-first eviction takes (spec §3.6.1 — retention must never delete the row the
   * caller is serving, or the next edit is permanently uneditable).
   */
  protectSnapshotIds?: Iterable<number>;
}

export interface VacuumResult {
  /** Snapshots deleted by this pass. */
  evicted: number;
  /** Lineage bytes retained after the pass. */
  totalBytes: number;
  /** Lineage bytes retained by pinned snapshots (always retained). */
  pinnedBytes: number;
  /** Overflow past the hard budget that the pinned set forces the store to keep. */
  deferredBytes: number;
  /** Whether that deferred overflow exceeds the tolerated soft cap (spec §3.6.1). */
  overSoftOverflow: boolean;
}

interface VacuumSnapshotRow {
  snapshot_id: number;
  path: string;
  snapshot_hash: string;
  line_count: number;
  created_at: number;
}

interface VacuumStmts {
  listSnapshots: () => VacuumSnapshotRow[];
  listPinned: (activeCutoff: number, graceCutoff: number) => { snapshot_id: number }[];
  deleteLineage: (snapshotId: number) => void;
  deleteSnapshot: (snapshotId: number) => void;
}

const vacuumStmtsCache = new WeakMap<DatabaseSync, VacuumStmts>();

/**
 * One statement set per store handle. `vacuum.ts` is a row-family module, so it owns its own
 * prepared statements and retries each `.run` itself (the `txn.ts` rule: statement-level retry
 * belongs to the statement's family).
 */
function vacuumStmts(db: DatabaseSync): VacuumStmts {
  const cached = vacuumStmtsCache.get(db);
  if (cached !== undefined) return cached;
  const built = buildVacuumStmts(db);
  vacuumStmtsCache.set(db, built);
  return built;
}

function buildVacuumStmts(db: DatabaseSync): VacuumStmts {
  const listStmt = db.prepare(
    "SELECT snapshot_id, path, snapshot_hash, line_count, created_at FROM file_snapshots " +
      "WHERE committed = 1 ORDER BY created_at ASC, snapshot_id ASC",
  );
  // WHY — pinning is a two-table predicate (spec §3.6.1): a lease still active inside the session
  // TTL, a lease retired inside the 1-hour grace, or an undo restore target. The `updated_at` half
  // is the LRU-on-access semantic: a re-serve refreshes the row (`lineage-store.ts` upsert
  // `ON CONFLICT … updated_at = excluded.updated_at`), moving that snapshot back out of the window.
  const pinnedStmt = db.prepare(
    "SELECT DISTINCT fs.snapshot_id AS snapshot_id FROM file_snapshots fs " +
      "WHERE fs.committed = 1 AND (" +
      "EXISTS (SELECT 1 FROM served_leases sl WHERE sl.file_path = fs.path " +
      "AND sl.served_snapshot_hash = fs.snapshot_hash " +
      "AND ((sl.retired_at IS NULL AND sl.updated_at >= ?) OR sl.retired_at >= ?)) " +
      "OR EXISTS (SELECT 1 FROM file_undo fu WHERE fu.path = fs.path " +
      "AND fu.snapshot_hash = fs.snapshot_hash))",
  );
  const deleteLineageStmt = db.prepare("DELETE FROM line_lineage WHERE snapshot_id = ?");
  const deleteSnapshotStmt = db.prepare("DELETE FROM file_snapshots WHERE snapshot_id = ?");
  return {
    // SAFETY: the SELECT list matches VacuumSnapshotRow field-for-field; node:sqlite returns one
    // record per row with exactly those columns.
    listSnapshots: () => listStmt.all() as unknown as VacuumSnapshotRow[],
    // SAFETY: same shape contract for the pin probe — one `snapshot_id` column per row.
    listPinned: (...params) => pinnedStmt.all(...params) as unknown as { snapshot_id: number }[],
    deleteLineage: (snapshotId) => {
      withBusyRetry(() => {
        deleteLineageStmt.run(snapshotId);
      });
    },
    deleteSnapshot: (snapshotId) => {
      withBusyRetry(() => {
        deleteSnapshotStmt.run(snapshotId);
      });
    },
  };
}

/** The lineage price of one snapshot: `40 bytes × line_count`, floored at one line for an empty file. */
function lineageBytes(row: VacuumSnapshotRow, perLine: number): number {
  return perLine * Math.max(1, row.line_count);
}

/**
 * The per-path window, sized against the path's NEWEST version (the file size retention is meant
 * for) and clamped into `[minVersions, maxVersions]`.
 */
function perPathRetention(newestLineCount: number): number {
  const snapshotLineageBytes = VACUUM_LINEAGE_BYTES_PER_LINE * Math.max(1, newestLineCount);
  const window = Math.floor(VACUUM_PER_PATH_BUDGET_BYTES / snapshotLineageBytes);
  return Math.min(VACUUM_MAX_SNAPSHOTS_PER_PATH, Math.max(VACUUM_MIN_SNAPSHOTS_PER_PATH, window));
}

// WHY — soft-overflow throttle (spec §3.6.1): the vacuum runs after every authoritative
// materialization and at store open, so an unthrottled warning would fire on every read and edit
// while the store stays over the soft cap. The rule is transition-in per store instance: warn only
// on the false → true transition for a given `DatabaseSync`, stay silent while the overflow
// persists, and re-arm when a pass reports no overflow. Observability only: never throws, never
// evicts, never alters the caller's result.
const softOverflowWarnedByDb = new WeakMap<DatabaseSync, boolean>();

/**
 * Emit the one operator-visible soft-overflow warning for a vacuum pass. Warns only when
 * `result.overSoftOverflow` holds and only on the transition into that state for the given store
 * instance; silent otherwise. Never throws: a diagnostic failure must not fail the caller.
 */
function reportVacuumSoftOverflow(db: DatabaseSync, result: VacuumResult): void {
  try {
    if (!result.overSoftOverflow) {
      softOverflowWarnedByDb.set(db, false);
      return;
    }
    if (softOverflowWarnedByDb.get(db) === true) return;
    softOverflowWarnedByDb.set(db, true);
    console.warn(
      `dsh-better-edit: snapshot vacuum soft overflow: totalBytes=${result.totalBytes} ` +
        `pinnedBytes=${result.pinnedBytes} deferredBytes=${result.deferredBytes} — pinned ` +
        `snapshots are never evicted and this state is expected to lapse as leases expire.`,
    );
  } catch {
    // SAFETY: observability only — a broken diagnostic sink must never fail the caller.
  }
}

/**
 * Enforce store retention across all paths (spec §3.6.1). The pass is one oldest-first sweep of
 * every committed snapshot: a snapshot is deleted when the running total is over the global budget,
 * or when its path already retains more than its retention window. Pinned snapshots are skipped
 * unconditionally — they are the versions a live anchor can still resolve through — and the
 * resulting deferral is reported, never resolved by evicting a pin.
 *
 * The pass is idempotent and safe with no candidates: it returns the zero result and never throws
 * on an empty store.
 */
export function vacuumSnapshots(db: DatabaseSync, options: VacuumOptions = {}): VacuumResult {
  const now = Date.now();
  const stmts = vacuumStmts(db);
  const rows = stmts.listSnapshots();
  const empty: VacuumResult = {
    evicted: 0,
    totalBytes: 0,
    pinnedBytes: 0,
    deferredBytes: 0,
    overSoftOverflow: false,
  };
  if (rows.length === 0) return empty;

  const pinned = new Set(
    stmts
      .listPinned(now - SERVED_TTL_MS, now - VACUUM_RETIRED_PIN_MS)
      .map((row) => row.snapshot_id),
  );
  // WHY — an in-flight materialization protects its own row: it names the snapshot before the serve
  // grants `served_leases`, so the sweep treats it exactly like a live pin (spec §3.6.1).
  for (const id of options.protectSnapshotIds ?? []) pinned.add(id);

  // WHY — rows ascend by `created_at`, so the last row seen for a path is its newest version — the
  // file size the per-path window is sized against.
  const newestLineCount = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    newestLineCount.set(row.path, row.line_count);
    pathCounts.set(row.path, (pathCounts.get(row.path) ?? 0) + 1);
    total += lineageBytes(row, VACUUM_LINEAGE_BYTES_PER_LINE);
  }

  const evict: number[] = [];
  let pinnedBytes = 0;
  for (const row of rows) {
    const cost = lineageBytes(row, VACUUM_LINEAGE_BYTES_PER_LINE);
    if (pinned.has(row.snapshot_id)) {
      pinnedBytes += cost;
      continue;
    }
    const retention = perPathRetention(newestLineCount.get(row.path) ?? row.line_count);
    const retained = pathCounts.get(row.path) ?? 0;
    if (total > VACUUM_GLOBAL_BUDGET_BYTES || retained > retention) {
      evict.push(row.snapshot_id);
      total -= cost;
      pathCounts.set(row.path, retained - 1);
    }
  }

  if (evict.length > 0) deleteVacuumSnapshots(db, stmts, evict);
  const deferredBytes = Math.max(0, total - VACUUM_GLOBAL_BUDGET_BYTES);
  const result: VacuumResult = {
    evicted: evict.length,
    totalBytes: total,
    pinnedBytes,
    deferredBytes,
    overSoftOverflow: deferredBytes > VACUUM_SOFT_OVERFLOW_BYTES - VACUUM_GLOBAL_BUDGET_BYTES,
  };
  reportVacuumSoftOverflow(db, result);
  return result;
}

/**
 * Delete the evicted snapshots and their lineage in one transaction. `withTransaction` is the
 * store's single re-entrant owner: at the outermost materialization boundary this opens its own
 * `BEGIN IMMEDIATE`; invoked inside a caller-owned unit it joins instead of raising
 * "cannot start a transaction within a transaction". The explicit `line_lineage` delete comes
 * first: the FK cascade covers FK-on openers, but `:memory:` test openers do not enable
 * `foreign_keys`, so the pair must hold for any opener.
 */
function deleteVacuumSnapshots(db: DatabaseSync, stmts: VacuumStmts, snapshotIds: number[]): void {
  withTransaction(db, () => {
    for (const id of snapshotIds) {
      stmts.deleteLineage(id);
      stmts.deleteSnapshot(id);
    }
  });
}
