import { beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { splitLines } from "../../src/utils.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import {
  createLineageStore,
  snapshotHashFor,
  type LineageStore,
} from "../../src/snapshot-store/lineage-store.js";
import {
  reportVacuum,
  vacuumSnapshots,
  REPORT_CONTEXT_CAP,
  VACUUM_GLOBAL_BUDGET_BYTES,
  VACUUM_MAX_SNAPSHOTS_PER_PATH,
  VACUUM_MIN_SNAPSHOTS_PER_PATH,
  VACUUM_PER_PATH_BUDGET_BYTES,
  VACUUM_SOFT_OVERFLOW_BYTES,
  VACUUM_LINEAGE_BYTES_PER_LINE,
  type VacuumResult,
} from "../../src/snapshot-store/index.js";
import { SERVED_TTL_MS } from "../../src/constants.js";

beforeAll(async () => {
  await initHasher();
});

/** The report ledgers are process-global module state: give every run its own context namespace. */
let reportRun = 0;

/**
 * The helper shape of `lineage-store.test.ts`, plus the `file_undo` table the pin predicate reads
 * (`createLineageStore` owns only the four lineage tables; `hash-store.ensureV7Tables` owns this
 * one in production).
 */
function open(): { db: DatabaseSync; lineage: LineageStore } {
  // The opener every production path uses: node:sqlite enables `enableForeignKeyConstraints` by
  // default and `hash-store` also sets `PRAGMA foreign_keys = ON` (P1 matrix).
  const db = new DatabaseSync(":memory:");
  createFileUndoTable(db);
  return { db, lineage: createLineageStore(db) };
}

function hashesFor(content: string, tag: string): string[] {
  return splitLines(content).map((_, index) => `${tag}${index}`);
}

function commit(lineage: LineageStore, path: string, content: string, tag: string): string[] {
  const hashes = hashesFor(content, tag);
  lineage.commitSnapshot({ path, content, hashes });
  return hashes;
}

function countSnapshots(db: DatabaseSync, path: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM file_snapshots WHERE path = ?")
    .get(path) as { count: number };
  return row.count;
}

function snapshotHashes(db: DatabaseSync, path: string): string[] {
  return (
    db
      .prepare(
        "SELECT snapshot_hash FROM file_snapshots WHERE path = ? ORDER BY created_at ASC, snapshot_id ASC",
      )
      .all(path) as { snapshot_hash: string }[]
  ).map((row) => row.snapshot_hash);
}

/** Synthetic rows for the budget arms: the sweep prices `40 × line_count`, so a big count is enough. */
function insertSnapshot(
  db: DatabaseSync,
  path: string,
  snapshotHash: string,
  lineCount: number,
  createdAt: number,
): number {
  const info = db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) " +
        "VALUES (?, ?, ?, ?, 1)",
    )
    .run(path, snapshotHash, lineCount, createdAt);
  return Number(info.lastInsertRowid);
}

function insertLease(
  db: DatabaseSync,
  path: string,
  snapshotHash: string,
  anchor: string,
  updatedAt: number,
  retiredAt: number | null = null,
): void {
  db.prepare(
    "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, " +
      "served_snapshot_hash, served_line_number, updated_at, retired_at) " +
      "VALUES ('s', ?, ?, 1, 'canon', ?, 1, ?, ?)",
  ).run(path, anchor, snapshotHash, updatedAt, retiredAt);
}

function ageLease(db: DatabaseSync, path: string, anchor: string, updatedAt: number): void {
  db.prepare(
    "UPDATE served_leases SET retired_at = NULL, updated_at = ? WHERE file_path = ? AND anchor = ?",
  ).run(updatedAt, path, anchor);
}

/**
 * The pair-invariant ledger for a store: `lineageLessSnapshots` counts retained snapshots whose
 * lineage is gone, `orphanLineage` the reverse (a lineage row whose snapshot row is gone).
 */
function storeCounts(db: DatabaseSync): {
  snapshots: number;
  lineage: number;
  orphanLineage: number;
  lineageLessSnapshots: number;
} {
  const one = (sql: string): number => (db.prepare(sql).get() as { count: number }).count;
  return {
    snapshots: one("SELECT COUNT(*) AS count FROM file_snapshots"),
    lineage: one("SELECT COUNT(*) AS count FROM line_lineage"),
    orphanLineage: one(
      "SELECT COUNT(*) AS count FROM line_lineage ll WHERE ll.snapshot_id NOT IN " +
        "(SELECT snapshot_id FROM file_snapshots)",
    ),
    lineageLessSnapshots: one(
      "SELECT COUNT(*) AS count FROM file_snapshots fs WHERE NOT EXISTS " +
        "(SELECT 1 FROM line_lineage ll WHERE ll.snapshot_id = fs.snapshot_id)",
    ),
  };
}

/** The ordered `(snapshot_id, path, snapshot_hash)` list — idempotence is about rows, not counts. */
function rowSet(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT snapshot_id, path, snapshot_hash FROM file_snapshots " +
          "ORDER BY created_at ASC, snapshot_id ASC",
      )
      .all() as { snapshot_id: number; path: string; snapshot_hash: string }[]
  ).map((row) => `${row.snapshot_id}:${row.path}:${row.snapshot_hash}`);
}

/** `count` snapshots of 1M-line scale (40 MB each), each pinned by an active lease. */
function insertPinnedBulk(
  db: DatabaseSync,
  tag: string,
  count: number,
  lineCount = 1_000_000,
): void {
  for (let index = 0; index < count; index++) {
    const path = `/defer-${tag}-${index}.ts`;
    const hash = `${tag}:${index}`;
    insertSnapshot(db, path, hash, lineCount, 3_000 + index);
    insertLease(db, path, hash, `${tag}${index}`, Date.now(), null);
  }
}

/**
 * The TM probe M1 injection: after the first of two `file_snapshots` deletes, any further one
 * aborts. A sweep that runs inside a caller-owned unit therefore aborts mid-loop — and the caller's
 * COMMIT would commit the partial sweep, which is why `vacuumSnapshots` defers instead.
 */
const ABORT_LATE_TRIGGER =
  "CREATE TRIGGER abort_late BEFORE DELETE ON file_snapshots " +
  "WHEN (SELECT COUNT(*) FROM file_snapshots) <= 11 " +
  "BEGIN SELECT RAISE(ABORT, 'injected mid-loop failure'); END";
/** Retire-and-age every lease for a path, so no anchor of that snapshot still pins it. */
function ageAllLeases(db: DatabaseSync, path: string, updatedAt: number): void {
  db.prepare("UPDATE served_leases SET retired_at = NULL, updated_at = ? WHERE file_path = ?").run(
    updatedAt,
    path,
  );
}

/** The v7 DDL lives in `hash-store`'s `ensureV7Tables`; the vacuum reads only the pin columns. */
function createFileUndoTable(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS file_undo (" +
      "path TEXT PRIMARY KEY, content TEXT NOT NULL, bom TEXT NOT NULL, ending TEXT NOT NULL, " +
      "hashes TEXT NOT NULL, result_content TEXT NOT NULL, snapshot_hash TEXT, " +
      "updated_at INTEGER NOT NULL)",
  );
}

describe("vacuum — per-path and global budgets", () => {
  it("cell 01 per-path window: the oldest versions are evicted and their lineage goes with them", () => {
    const { db, lineage } = open();
    const path = "/window.ts";
    const lineCount = 3;
    const contents: string[] = [];
    for (let index = 0; index < 12; index++) {
      const content = `alpha\nbravo ${index}\ncharlie`;
      contents.push(content);
      commit(lineage, path, content, `V${index}`);
    }

    const removedBefore = snapshotHashes(db, path).length;
    const result = vacuumSnapshots(db);

    // Retention is the spec formula, clamped to [2, 10]; with 3-line files the window is the max.
    const expectedRetention = Math.min(
      VACUUM_MAX_SNAPSHOTS_PER_PATH,
      Math.max(
        VACUUM_MIN_SNAPSHOTS_PER_PATH,
        Math.floor(VACUUM_PER_PATH_BUDGET_BYTES / (VACUUM_LINEAGE_BYTES_PER_LINE * lineCount)),
      ),
    );
    expect(removedBefore).toBe(12);
    expect(result.evicted).toBe(12 - expectedRetention);
    expect(countSnapshots(db, path)).toBe(expectedRetention);

    const surviving = snapshotHashes(db, path);
    for (const [index, content] of contents.entries()) {
      const hash = snapshotHashFor(content);
      if (index < 12 - expectedRetention) {
        expect(surviving).not.toContain(hash);
        expect(lineage.lineageFor(path, hash)).toEqual([]);
      } else {
        expect(surviving).toContain(hash);
      }
    }
    // No orphan lineage anywhere: every lineage row's snapshot row still exists.
    const orphans = db
      .prepare(
        "SELECT COUNT(*) AS count FROM line_lineage WHERE snapshot_id NOT IN " +
          "(SELECT snapshot_id FROM file_snapshots)",
      )
      .get() as { count: number };
    expect(orphans.count).toBe(0);
  });

  it("cell 02 global budget: oldest-created_at rows are evicted until the total holds", () => {
    const { db } = open();
    const perRow = VACUUM_LINEAGE_BYTES_PER_LINE * 400_000; // 16 MB per synthetic row
    const hashA = "2:bulk-a";
    const hashB = "2:bulk-b";
    const hashC = "2:bulk-c";
    const hashD = "2:bulk-d";
    // Explicit distinct stamps: ordering is by created_at and must never depend on wall-clock ties.
    insertSnapshot(db, "/bulk-a.ts", hashA, 400_000, 1_000);
    insertSnapshot(db, "/bulk-a.ts", hashB, 400_000, 1_100);
    insertSnapshot(db, "/bulk-b.ts", hashC, 400_000, 1_200);
    insertSnapshot(db, "/bulk-b.ts", hashD, 400_000, 1_300);

    const result = vacuumSnapshots(db);

    expect(perRow * 4).toBeGreaterThan(VACUUM_GLOBAL_BUDGET_BYTES);
    expect(result.evicted).toBe(1);
    expect(result.totalBytes).toBe(perRow * 3);
    expect(result.totalBytes).toBeLessThanOrEqual(VACUUM_GLOBAL_BUDGET_BYTES);
    expect(result.deferredBytes).toBe(0);
    expect(result.overSoftOverflow).toBe(false);
    // The oldest row goes first; the three newer rows survive.
    expect(snapshotHashes(db, "/bulk-a.ts")).toEqual([hashB]);
    expect(snapshotHashes(db, "/bulk-b.ts")).toEqual([hashC, hashD]);
  });
});

describe("vacuum — pins", () => {
  it("cell 03 active pin survives: a leased version stays resolvable while siblings are evicted", () => {
    const { db, lineage } = open();
    const path = "/pinned.ts";
    const v1 = "one\ntwo\nthree";
    const h1 = hashesFor(v1, "P");
    lineage.commitSnapshot({
      path,
      content: v1,
      hashes: h1,
      leases: { sessionKey: "s", rows: h1.map((hash, position) => ({ position, hash })) },
    });
    for (let index = 2; index <= 12; index++) {
      commit(lineage, path, `one\ntwo\nthree\nversion ${index}`, `V${index}`);
    }

    const result = vacuumSnapshots(db);

    expect(result.pinnedBytes).toBeGreaterThan(0);
    expect(snapshotHashes(db, path)).toContain(snapshotHashFor(v1));
    expect(lineage.lineageFor(path, snapshotHashFor(v1))).toHaveLength(3);
    const lease = lineage.leaseFor("s", path, h1[1]!);
    expect(lease).toBeDefined();
    expect(lineage.positionsByIdentity(path, v1).get(lease!.lineId)).toBe(2);
    // The unpinned siblings were the sweep's candidates: 12 rows, 1 pinned, window 10.
    expect(countSnapshots(db, path)).toBe(VACUUM_MAX_SNAPSHOTS_PER_PATH);
  });

  it("cell 04 pin recency: an aged lease stops pinning and a re-serve pins again", () => {
    // Half A — aged lease: the target is evictable.
    const aged = open();
    const pathA = "/aged.ts";
    const v1 = "one\ntwo\nthree";
    const h1 = hashesFor(v1, "Q");
    const grant = (store: LineageStore, path: string): void => {
      store.commitSnapshot({
        path,
        content: v1,
        hashes: h1,
        // ONE lease row, so ageing it is enough to unpin the snapshot (the pin is per snapshot_hash).
        leases: { sessionKey: "s", rows: [{ position: 0, hash: h1[0]! }] },
      });
    };
    grant(aged.lineage, pathA);
    for (let index = 2; index <= 12; index++) {
      commit(aged.lineage, pathA, `one\ntwo\nthree\nversion ${index}`, `V${index}`);
    }
    ageLease(aged.db, pathA, h1[0]!, Date.now() - SERVED_TTL_MS - 60_000);
    vacuumSnapshots(aged.db);
    expect(snapshotHashes(aged.db, pathA)).not.toContain(snapshotHashFor(v1));

    // Half B — the re-serve refreshes `served_leases.updated_at`, so the same target stays pinned.
    const refreshed = open();
    const pathB = "/refreshed.ts";
    grant(refreshed.lineage, pathB);
    for (let index = 2; index <= 12; index++) {
      commit(refreshed.lineage, pathB, `one\ntwo\nthree\nversion ${index}`, `W${index}`);
    }
    ageLease(refreshed.db, pathB, h1[0]!, Date.now() - SERVED_TTL_MS - 60_000);
    grant(refreshed.lineage, pathB); // re-serve: adopt + lease upsert with a fresh stamp
    vacuumSnapshots(refreshed.db);
    expect(snapshotHashes(refreshed.db, pathB)).toContain(snapshotHashFor(v1));
    expect(refreshed.lineage.lineageFor(pathB, snapshotHashFor(v1))).toHaveLength(3);
  });

  it("cell 05 retired-inside-grace pins, and a retirement older than the grace does not", () => {
    const { db, lineage } = open();
    const path = "/retired.ts";
    const v1 = "one\ntwo\nthree";
    const h1 = hashesFor(v1, "R");
    lineage.commitSnapshot({
      path,
      content: v1,
      hashes: h1,
      leases: { sessionKey: "s", rows: h1.map((hash, position) => ({ position, hash })) },
    });
    // Retired now, updated outside the active TTL: the grace clause is the only pin left.
    db.prepare("UPDATE served_leases SET retired_at = ?, updated_at = ? WHERE file_path = ?").run(
      Date.now(),
      Date.now() - SERVED_TTL_MS - 60_000,
      path,
    );
    for (let index = 2; index <= 12; index++) {
      commit(lineage, path, `one\ntwo\nthree\nversion ${index}`, `V${index}`);
    }

    const inGrace = vacuumSnapshots(db);
    expect(inGrace.pinnedBytes).toBeGreaterThan(0);
    expect(snapshotHashes(db, path)).toContain(snapshotHashFor(v1));

    // A retirement two hours old is outside the one-hour grace: the same row stops being pinned.
    db.prepare("UPDATE served_leases SET retired_at = ? WHERE file_path = ?").run(
      Date.now() - 2 * 60 * 60 * 1000,
      path,
    );
    const stale = vacuumSnapshots(db);
    expect(stale.pinnedBytes).toBe(0);
  });

  it("cell 06 undo target pinned: a `file_undo.snapshot_hash` survives the per-path and global arms", () => {
    const { db, lineage } = open();
    const path = "/undo.ts";
    const v1 = "one\ntwo\nthree";
    commit(lineage, path, v1, "U");
    for (let index = 2; index <= 12; index++) {
      commit(lineage, path, `one\ntwo\nthree\nversion ${index}`, `V${index}`);
    }
    // Over the global budget too: 80 MB of synthetic lineage on a sibling path.
    insertSnapshot(db, "/bulk.ts", "6:bulk", 2_000_000, Date.now() + 60_000);
    db.prepare(
      "INSERT INTO file_undo (path, content, bom, ending, hashes, result_content, snapshot_hash, " +
        "updated_at) VALUES (?, 'x', '', '\\n', '[]', 'x', ?, ?)",
    ).run(path, snapshotHashFor(v1), Date.now());

    const result = vacuumSnapshots(db);

    expect(result.pinnedBytes).toBeGreaterThan(0);
    expect(snapshotHashes(db, path)).toContain(snapshotHashFor(v1));
    expect(lineage.lineageFor(path, snapshotHashFor(v1))).toHaveLength(3);
    const undo = db.prepare("SELECT COUNT(*) AS count FROM file_undo WHERE path = ?").get(path) as {
      count: number;
    };
    expect(undo.count).toBe(1);
  });

  it("cell 07 protectSnapshotIds: the in-flight id survives an over-budget sweep", () => {
    const { db } = open();
    const paths = ["/protect-0.ts", "/protect-1.ts", "/protect-2.ts", "/protect-3.ts"];
    const oldestId = insertSnapshot(db, paths[0]!, "7:oldest", 400_000, 2_000);
    insertSnapshot(db, paths[1]!, "7:second", 400_000, 2_100);
    insertSnapshot(db, paths[2]!, "7:third", 400_000, 2_200);
    insertSnapshot(db, paths[3]!, "7:fourth", 400_000, 2_300);

    const unprotected = vacuumSnapshots(db);
    expect(unprotected.evicted).toBe(1);
    expect(countSnapshots(db, paths[0]!)).toBe(0);

    // Rebuild, and protect exactly the row the oldest-first sweep would take first.
    const second = open();
    const protectedId = insertSnapshot(second.db, paths[0]!, "7:oldest", 400_000, 2_000);
    insertSnapshot(second.db, paths[1]!, "7:second", 400_000, 2_100);
    insertSnapshot(second.db, paths[2]!, "7:third", 400_000, 2_200);
    insertSnapshot(second.db, paths[3]!, "7:fourth", 400_000, 2_300);
    const guarded = vacuumSnapshots(second.db, { protectSnapshotIds: [protectedId] });

    expect(guarded.evicted).toBe(1);
    expect(countSnapshots(second.db, paths[0]!)).toBe(1);
    expect(countSnapshots(second.db, paths[1]!)).toBe(0);
    expect(oldestId).toBe(protectedId);
    expect(VACUUM_LINEAGE_BYTES_PER_LINE * 400_000 * 4).toBeGreaterThan(VACUUM_GLOBAL_BUDGET_BYTES);
  });

  it("cell 08 counters and leases are never touched, even for a fully evicted path", () => {
    const { db, lineage } = open();
    const path = "/counters.ts";
    const v1 = "one\ntwo\nthree";
    const h1 = hashesFor(v1, "C");
    lineage.commitSnapshot({
      path,
      content: v1,
      hashes: h1,
      leases: { sessionKey: "s", rows: h1.map((hash, position) => ({ position, hash })) },
    });
    ageAllLeases(db, path, Date.now() - SERVED_TTL_MS - 60_000);
    insertSnapshot(db, "/bulk.ts", "8:bulk", 2_000_000, Date.now() + 60_000);

    const counterBefore = db
      .prepare("SELECT next_id FROM line_id_counters WHERE path = ?")
      .get(path);
    const leaseCountBefore = db
      .prepare("SELECT COUNT(*) AS count FROM served_leases WHERE file_path = ?")
      .get(path) as { count: number };

    const result = vacuumSnapshots(db);

    expect(result.evicted).toBeGreaterThan(0);
    expect(countSnapshots(db, path)).toBe(0);
    expect(db.prepare("SELECT next_id FROM line_id_counters WHERE path = ?").get(path)).toEqual(
      counterBefore,
    );
    const leaseCountAfter = db
      .prepare("SELECT COUNT(*) AS count FROM served_leases WHERE file_path = ?")
      .get(path) as { count: number };
    expect(leaseCountAfter.count).toBe(leaseCountBefore.count);
    expect(leaseCountAfter.count).toBe(3);
  });

  it("cell 09 loud deferral: an all-pinned over-budget store reports, never evicts", () => {
    const { db } = open();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let index = 0; index < 3; index++) {
        const path = `/defer-${index}.ts`;
        const hash = `9:defer-${index}`;
        insertSnapshot(db, path, hash, 1_000_000, 3_000 + index);
        insertLease(db, path, hash, `D${index}`, Date.now(), null);
      }

      const result = vacuumSnapshots(db);

      expect(result.evicted).toBe(0);
      expect(result.totalBytes).toBeGreaterThan(VACUUM_GLOBAL_BUDGET_BYTES);
      expect(result.deferredBytes).toBe(result.totalBytes - VACUUM_GLOBAL_BUDGET_BYTES);
      expect(result.deferredBytes).toBeGreaterThan(0);
      expect(result.overSoftOverflow).toBe(
        result.deferredBytes > VACUUM_SOFT_OVERFLOW_BYTES - VACUUM_GLOBAL_BUDGET_BYTES,
      );
      expect(result.overSoftOverflow).toBe(true);
      expect(result.skippedInTransaction).toBe(false);
      // The sweep itself is silent — every trigger reports through the single report owner.
      expect(warn).not.toHaveBeenCalled();
      reportVacuum(result, "cell 09");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("soft overflow"));
      // The pinned snapshots are all still there.
      expect(countSnapshots(db, "/defer-0.ts")).toBe(1);
      expect(countSnapshots(db, "/defer-1.ts")).toBe(1);
      expect(countSnapshots(db, "/defer-2.ts")).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
  it("cell 16 deferral: a sweep inside a caller-owned unit skips, the boundary stays atomic", () => {
    const { db, lineage } = open();
    const path = "/deferral.ts";
    for (let index = 0; index < 12; index++) {
      commit(lineage, path, `one\ntwo ${index}\nthree`, `V${index}`);
    }
    db.exec(ABORT_LATE_TRIGGER);
    const before = storeCounts(db);
    expect(before.snapshots).toBe(12);
    expect(before.orphanLineage).toBe(0);
    expect(before.lineageLessSnapshots).toBe(0);

    // (a) inside a caller-owned unit the sweep defers, so the injection never fires and the
    // caller's COMMIT cannot commit a partial sweep (probe M1: joined + ABORT -> pair broken).
    db.exec("BEGIN IMMEDIATE");
    const inside = vacuumSnapshots(db);
    expect(inside.skippedInTransaction).toBe(true);
    expect(inside.evicted).toBe(0);
    expect(inside.totalBytes).toBe(0);
    db.exec("COMMIT");
    expect(storeCounts(db)).toEqual(before);

    // (b) at the boundary the same injection propagates and the sweep rolls back whole.
    expect(() => vacuumSnapshots(db)).toThrow(/injected mid-loop failure/);
    expect(storeCounts(db)).toEqual(before);
  });

  it("cell 17 report payload: an over-budget deferral under the soft cap is reported with its numbers", () => {
    const { db } = open();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Two pinned 40 MB versions: over the hard budget, under the soft cap — so an
      // `overSoftOverflow`-only reporter would have left this pass silent.
      insertPinnedBulk(db, "c17", 2);
      const first = vacuumSnapshots(db);
      reportVacuum(first, "cell 17");
      expect(first.deferredBytes).toBeGreaterThan(0);
      expect(first.overSoftOverflow).toBe(false);
      // The observable is the payload, not the call: the warning carries the numbers.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `totalBytes=${first.totalBytes} pinnedBytes=${first.pinnedBytes} ` +
            `deferredBytes=${first.deferredBytes}`,
        ),
      );
      // A second identical pass is throttled; the transition-in half.
      reportVacuum(vacuumSnapshots(db), "cell 17");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("cell 18 report throttle: an under-budget pass re-arms the warning", () => {
    const { db } = open();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      insertPinnedBulk(db, "c18", 3);
      reportVacuum(vacuumSnapshots(db), "cell 18");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("deferredBytes="));
      // Under the soft cap: the report is silent and the throttle re-arms.
      db.prepare("DELETE FROM file_snapshots WHERE path != '/defer-c18-0.ts'").run();
      reportVacuum(vacuumSnapshots(db), "cell 18");
      expect(warn).toHaveBeenCalledTimes(1);
      // Over the cap again: the re-arm is proved by a second warning.
      insertPinnedBulk(db, "c18b", 3);
      reportVacuum(vacuumSnapshots(db), "cell 18");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("cell 19 idempotence: a second sweep evicts nothing and changes no row", () => {
    const { db, lineage } = open();
    const path = "/idem.ts";
    for (let index = 0; index < 12; index++) {
      commit(lineage, path, `one\ntwo ${index}\nthree`, `V${index}`);
    }
    const first = vacuumSnapshots(db);
    const afterFirst = rowSet(db);
    const second = vacuumSnapshots(db);

    expect(first.evicted).toBe(2);
    expect(second.evicted).toBe(0);
    expect(second.totalBytes).toBe(first.totalBytes);
    expect(second.pinnedBytes).toBe(0);
    expect(second.deferredBytes).toBe(0);
    expect(second.overSoftOverflow).toBe(false);
    expect(second.skippedInTransaction).toBe(false);
    expect(rowSet(db)).toEqual(afterFirst);
    expect(storeCounts(db).orphanLineage).toBe(0);
  });

  it("cell 20 pair invariant: no orphan lineage after a normal, an aborted-boundary or a deferred sweep", () => {
    const seed = (db: DatabaseSync, lineage: LineageStore, path: string): void => {
      for (let index = 0; index < 12; index++) {
        commit(lineage, path, `one\ntwo ${index}\nthree`, `V${index}`);
      }
      expect(storeCounts(db)).toMatchObject({
        snapshots: 12,
        orphanLineage: 0,
        lineageLessSnapshots: 0,
      });
    };

    // (i) a normal sweep: every retained snapshot keeps its lineage, no orphans either way.
    const normal = open();
    seed(normal.db, normal.lineage, "/pair-normal.ts");
    vacuumSnapshots(normal.db);
    expect(storeCounts(normal.db)).toMatchObject({
      snapshots: 10,
      orphanLineage: 0,
      lineageLessSnapshots: 0,
    });

    // (ii) the mid-loop ABORT at the boundary: the whole sweep rolls back, pair intact.
    const aborted = open();
    seed(aborted.db, aborted.lineage, "/pair-aborted.ts");
    aborted.db.exec(ABORT_LATE_TRIGGER);
    expect(() => vacuumSnapshots(aborted.db)).toThrow(/injected mid-loop failure/);
    expect(storeCounts(aborted.db)).toMatchObject({
      snapshots: 12,
      orphanLineage: 0,
      lineageLessSnapshots: 0,
    });

    // (iii) inside a caller-owned unit: nothing runs, so the state is unchanged.
    const deferred = open();
    seed(deferred.db, deferred.lineage, "/pair-deferred.ts");
    const before = storeCounts(deferred.db);
    deferred.db.exec("BEGIN IMMEDIATE");
    vacuumSnapshots(deferred.db);
    deferred.db.exec("COMMIT");
    expect(storeCounts(deferred.db)).toEqual(before);
  });

  it("cell 21 pair invariant: an eviction leaves no orphan lineage on the real opener", () => {
    const { db, lineage } = open();
    const path = "/order.ts";
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
    for (let index = 0; index < 12; index++) {
      commit(lineage, path, `one\ntwo ${index}\nthree`, `V${index}`);
    }

    const result = vacuumSnapshots(db);

    // FK-mode-agnostic invariant: no lineage row survives its snapshot row, and no retained
    // snapshot loses its lineage. The explicit child-first delete is what makes this true without
    // leaning on the pragma; on this opener the cascade would mask it (P1 matrix), which is why the
    // order/drop mutants are GREEN with meaning 4 rather than RED here.
    expect(result.evicted).toBe(2);
    expect(storeCounts(db).orphanLineage).toBe(0);
    expect(storeCounts(db).lineageLessSnapshots).toBe(0);
  });

  it("cell 26 crash mid-pair: a fault between the two deletes rolls back to a whole pair", () => {
    const { db, lineage } = open();
    const path = "/crash.ts";
    for (let index = 0; index < 12; index++) {
      commit(lineage, path, `one\ntwo ${index}\nthree`, `V${index}`);
    }
    const before = storeCounts(db);
    // The fault fires on the second `file_snapshots` delete, i.e. after one pair's lineage row was
    // already deleted: only the transaction can restore it. (1) ATOMICITY at the boundary — the
    // throw propagates and no pair state survives, neither an orphan lineage row nor a dangling
    // snapshot row. (2) ORPHAN LINEAGE === 0 — the defect direction: an orphan lineage row has no
    // owner to detect it, unlike a `file_snapshots` row with no lineage (the codebase's "orphan
    // snapshot row"), which the adopt path already detects, warns about and repairs
    // (`test/core/hash-store.test.ts:1665`) — this vacuum must not repair that shape eagerly, and
    // (`test/core/hash-store.test.ts:1665`; the full ownership note lives at the pair delete in
    // `src/snapshot-store/vacuum.ts`) — this vacuum must not repair that shape eagerly, and this
    // cell asserts nothing about it.
    db.exec(ABORT_LATE_TRIGGER);
    expect(() => vacuumSnapshots(db)).toThrow(/injected mid-loop failure/);
    const after = storeCounts(db);
    expect({ snapshots: after.snapshots, lineage: after.lineage }).toEqual({
      snapshots: before.snapshots,
      lineage: before.lineage,
    });
    // Post-fault counts, asserted explicitly so the report can paste them: 12 snapshots / 36
    // lineage rows, unchanged by the rollback (neither shape survives), orphanLineage 0.
    expect(before.snapshots).toBe(12);
    expect(before.lineage).toBe(36);
    expect(after).toEqual(before);
    expect(after.orphanLineage).toBe(0);
  });

  it("cell 25 over-broad pin: a file_undo row for another path does not pin the candidate", () => {
    const { db, lineage } = open();
    const path = "/pin-scope.ts";
    const content = "one\ntwo\nthree";
    commit(lineage, path, content, "S");
    for (let index = 1; index <= 11; index++) {
      commit(lineage, path, `one\ntwo ${index}\nthree`, `V${index}`);
    }
    // Same snapshot_hash, different path: the `fu.path = fs.path` clause must reject it.
    db.prepare(
      "INSERT INTO file_undo (path, content, bom, ending, hashes, result_content, " +
        "snapshot_hash, updated_at) VALUES ('/other.ts', 'x', '', '\\n', '[]', 'x', ?, ?)",
    ).run(snapshotHashFor(content), Date.now());

    const result = vacuumSnapshots(db);

    expect(result.evicted).toBe(2);
    expect(result.pinnedBytes).toBe(0);
    expect(snapshotHashes(db, path)).not.toContain(snapshotHashFor(content));
  });
  it("cell 29 the report ledger cap evicts the oldest context, which is then reported again", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const overBudget: VacuumResult = {
      evicted: 0,
      totalBytes: 120_000_000,
      pinnedBytes: 120_000_000,
      deferredBytes: 120_000_000 - VACUUM_GLOBAL_BUDGET_BYTES,
      overSoftOverflow: true,
      skippedInTransaction: false,
    };
    // The ledgers are process-global module state, so every context in this cell carries a per-run
    // prefix: an earlier cell's entry with the same text would suppress a warn this cell asserts.
    reportRun += 1;
    const prefix = `cell 29 run ${reportRun}`;
    // Match the parenthesised context exactly: prefix matching would confuse `b 1` with `b 10`.
    const warned = (context: string): number =>
      warn.mock.calls.filter((call) => String(call[0]).includes(`(${context})`)).length;
    // A small K brackets the boundary: the cap is never asserted as a value (that would be a
    // tautology — one referent that cannot fail). What is asserted is the OBSERVABLE consequence:
    // of `cap + K` fresh contexts, the K oldest were evicted and the K newest were retained.
    const K = 3;
    try {
      const target = `${prefix} target`;
      reportVacuum(overBudget, target);
      expect(warned(target)).toBe(1);
      reportVacuum(overBudget, target);
      expect(warned(target)).toBe(1); // throttled while the context is in the ledger

      // Enough fresh contexts to trip the cap: each insert drops the oldest entry, the target.
      for (let index = 0; index < REPORT_CONTEXT_CAP; index++) {
        reportVacuum(overBudget, `${prefix} fill ${index}`);
      }
      // Eviction re-armed the context: the same result reports again, 1 -> 2.
      reportVacuum(overBudget, target);
      expect(warned(target)).toBe(2);

      // Bracket the boundary: `cap + K` inserts leave the retained set exactly the `cap` most
      // recent (`b_0..b_{K-1}` evicted, `b_cap..b_{cap+K-1}` retained).
      const oldest = Array.from({ length: K }, (_, index) => `${prefix} b ${index}`);
      const newest = Array.from(
        { length: K },
        (_, index) => `${prefix} b ${REPORT_CONTEXT_CAP + index}`,
      );
      for (let index = 0; index < REPORT_CONTEXT_CAP + K; index++) {
        reportVacuum(overBudget, `${prefix} b ${index}`);
      }
      for (const context of oldest) {
        // Each fill insert warned once; an evicted context warns a second time on the re-report.
        expect(warned(context)).toBe(1);
        reportVacuum(overBudget, context);
        expect(warned(context)).toBe(2);
      }
      // Re-reporting an evicted context re-inserts it and drops the oldest *retained* entry
      // (`b_K..b_{K+2}`), which with `cap >> 2K` can never reach the newest K.
      for (const context of newest) {
        expect(warned(context)).toBe(1);
        reportVacuum(overBudget, context);
        expect(warned(context)).toBe(1); // retained: still throttled
      }
    } finally {
      warn.mockRestore();
    }
  });
});
