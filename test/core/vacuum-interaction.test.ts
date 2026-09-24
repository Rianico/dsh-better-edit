import { readFile, writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";
import { initHasher, lineHashes } from "../../src/hashline/index.js";
import { codeOf } from "../../src/utils.js";
import { SERVED_TTL_MS } from "../../src/constants.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

const DISK_CONTENT = "alpha\nbravo\ncharlie";

/** Distinct 3-char anchors for synthetic versions (the store validates nothing on that path). */
let anchorCounter = 0;
function syntheticAnchors(count: number): string[] {
  return Array.from({ length: count }, () => {
    anchorCounter += 1;
    return anchorCounter.toString(36).padStart(3, "0");
  });
}

async function storeFace(cwd: string): Promise<InternalHashStore> {
  return (await loadHashStore(cwd)) as InternalHashStore;
}

/**
 * Commit `count` versions whose canons share nothing with the served content, so the sweep has
 * candidates and every line of a re-materialization takes a fresh counter id.
 */
async function seedVersions(cwd: string, path: string, count: number, tag: string): Promise<void> {
  const store = await storeFace(cwd);
  for (let index = 0; index < count; index++) {
    const content = `${tag} ${index}\nsecond line ${index}\nthird line ${index}`;
    store.commitSnapshot({ path, content, hashes: syntheticAnchors(3) });
  }
}

/** Retire-and-age every lease for a path so no anchor of the served snapshot still pins it. */
function ageLeases(db: DatabaseSync, path: string): void {
  db.prepare("UPDATE served_leases SET retired_at = NULL, updated_at = ? WHERE file_path = ?").run(
    Date.now() - SERVED_TTL_MS - 60_000,
    path,
  );
}

function count(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}

function leaseLineIds(db: DatabaseSync, path: string): number[] {
  return (
    db.prepare("SELECT line_id FROM served_leases WHERE file_path = ?").all(path) as {
      line_id: number;
    }[]
  ).map((row) => row.line_id);
}

function hasLineageRowFor(db: DatabaseSync, lineId: number): boolean {
  return (
    (
      db.prepare("SELECT COUNT(*) AS count FROM line_lineage WHERE line_id = ?").get(lineId) as {
        count: number;
      }
    ).count > 0
  );
}

/** The hashline rows a read text carries: 3-char anchor, box-drawing separator. */
const ROW = /^[A-Za-z0-9]{3}\u2502/;

function readRowHashes(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => ROW.test(line))
    .map((line) => extractHash(line));
}

function hashlineBodies(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => ROW.test(line))
    .map((line) => line.slice(line.indexOf("\u2502") + 1));
}

describe("vacuum — interaction with lineage, leases and the tools", () => {
  it("cell 10 re-materializing an evicted version issues counter-fresh ids and never duplicates a line", async () => {
    await withTempFile("cell10.txt", DISK_CONTENT, async ({ cwd, path }) => {
      const it = setupIntegrationTest(cwd);
      const store = await storeFace(cwd);
      await it.readTool.execute("c", { path });
      const servedHashes = await lineHashes(DISK_CONTENT, path);
      const servedHash = snapshotHashFor(DISK_CONTENT);
      const db = new DatabaseSync(hashStorePath(cwd));
      try {
        const leaseIds = new Set(leaseLineIds(db, path));
        expect(leaseIds.size).toBeGreaterThan(0);

        // Ten versions whose canons share nothing with the served content, then unpin and sweep.
        await seedVersions(cwd, path, 10, "seed10");
        ageLeases(db, path);
        // A synthetic bulk row on another path makes the global arm fire: the oldest unpinned row
        // (the served version) is then the sweep's first candidate.
        db.prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) " +
            "VALUES ('/bulk.ts', '10:bulk', 2000000, ?, 1)",
        ).run(Date.now() + 60_000);
        const counterBefore = db
          .prepare("SELECT next_id FROM line_id_counters WHERE path = ?")
          .get(path) as { next_id: number };
        store.vacuumSnapshots();
        expect(count(db, "SELECT COUNT(*) AS count FROM file_snapshots WHERE path = ?", path)).toBe(
          0,
        );
        expect(
          count(
            db,
            "SELECT COUNT(*) AS count FROM file_snapshots WHERE snapshot_hash = ?",
            servedHash,
          ),
        ).toBe(0);

        // Re-materialize the evicted content: the counter is never reset, so the ids are fresh.
        store.commitSnapshot({ path, content: DISK_CONTENT, hashes: [...servedHashes] });
        const rows = store.lineageFor(path, servedHash);
        const newIds = rows.map((row) => row.lineId);
        const counterAfter = db
          .prepare("SELECT next_id FROM line_id_counters WHERE path = ?")
          .get(path) as { next_id: number };
        // Exactly one row per line, one distinct id per row (the unique alias guard holds).
        expect(rows.map((row) => row.lineNumber)).toEqual([1, 2, 3]);
        expect(new Set(newIds).size).toBe(3);
        // Monotone counter, never reset: every fresh id comes from `next_id`; none is re-issued,
        // and the ids the aged lease still names are not among them.
        expect(newIds.every((id) => id >= counterBefore.next_id)).toBe(true);
        expect(counterAfter.next_id).toBe(counterBefore.next_id + 3);
        for (const lineId of newIds) expect(leaseIds.has(lineId)).toBe(false);
        for (const lineId of leaseIds) expect(hasLineageRowFor(db, lineId)).toBe(false);
        const shape = db
          .prepare(
            "SELECT COUNT(*) AS count, COUNT(DISTINCT line_id) AS ids, COUNT(DISTINCT line_number) " +
              "AS lines FROM line_lineage WHERE snapshot_id = (SELECT snapshot_id FROM file_snapshots " +
              "WHERE path = ? AND snapshot_hash = ?)",
          )
          .get(path, servedHash) as { count: number; ids: number; lines: number };
        expect(shape).toEqual({ count: 3, ids: 3, lines: 3 });
      } finally {
        db.close();
      }
    });
  });

  it("cell 11 an evicted lease target fails loudly and writes nothing", async () => {
    await withTempFile("cell11.txt", DISK_CONTENT, async ({ cwd, path }) => {
      const it = setupIntegrationTest(cwd);
      const read = await it.readTool.execute("c", { path });
      const anchors = readRowHashes(getText(read));
      const store = await storeFace(cwd);
      const db = new DatabaseSync(hashStorePath(cwd));
      await seedVersions(cwd, path, 10, "seed11");
      ageLeases(db, path);
      db.prepare(
        "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) " +
          "VALUES ('/bulk.ts', '11:bulk', 2000000, ?, 1)",
      ).run(Date.now() + 60_000);
      store.vacuumSnapshots();
      try {
        // the store exists from the read above
        expect(anchors).toHaveLength(3);
        expect(
          count(
            db,
            "SELECT COUNT(*) AS count FROM file_snapshots WHERE snapshot_hash = ?",
            snapshotHashFor(DISK_CONTENT),
          ),
        ).toBe(0);
        const bytesBefore = await readFile(path, "utf-8");

        let failure = "";
        try {
          await it.editTool.execute("c", { path, edits: [[anchors[1]!, anchors[1]!, "CHANGED"]] });
        } catch (error) {
          failure = `${codeOf(error) ?? ""} :: ${error instanceof Error ? error.message : String(error)}`;
        }
        // Measured at HEAD: the fail-closed rejection is `E_STALE_RANGE` inside the batch
        // envelope. `E_TARGET_LOST` / `E_UNVERIFIED_RANGE` are upstream-only codes this tree
        // never produces (`rg -n 'E_TARGET_LOST' src/` → one comment in `DEFERRED_PRODUCERS`).
        expect(failure).toContain("[E_STALE_RANGE]");
        expect(failure).toContain("no longer resolves to the line identity it was served with");
        expect(failure).toContain("NOTHING was written");
        expect(failure).not.toContain("E_TARGET_LOST");
        expect(failure).not.toContain("E_UNVERIFIED_RANGE");
        expect(await readFile(path, "utf-8")).toBe(bytesBefore);
      } finally {
        db.close();
      }
    });
  });

  it("cell 12 reject-stays-a-no-op and a read after a vacuum still equals the on-disk bytes", async () => {
    await withTempFile("cell12.txt", DISK_CONTENT, async ({ cwd, path }) => {
      const it = setupIntegrationTest(cwd);
      const read = await it.readTool.execute("c", { path });
      const anchors = readRowHashes(getText(read));
      // An out-of-band change to a served line makes that line's anchor stale: the edit must reject.
      await writeFile(path, "ALPHA\nbravo\ncharlie");
      const diskBytes = await readFile(path, "utf-8");
      await expect(
        it.editTool.execute("c", { path, edits: [[anchors[0]!, anchors[0]!, "CHANGED"]] }),
      ).rejects.toThrow();
      expect(await readFile(path, "utf-8")).toBe(diskBytes);

      // Now sweep away the snapshot the rejected edit was resolved against, and read again.
      await seedVersions(cwd, path, 10, "seed12");
      const db = new DatabaseSync(hashStorePath(cwd));
      try {
        ageLeases(db, path);
        (await storeFace(cwd)).vacuumSnapshots();
        const after = await it.readTool.execute("c", { path });
        const text = getText(after);
        expect(await readFile(path, "utf-8")).toBe(diskBytes);
        expect(hashlineBodies(text)).toEqual(diskBytes.replace(/\n$/, "").split("\n"));
        expect(text).not.toContain("CHANGED");
      } finally {
        db.close();
      }
    });
  });

  it("cell 13 the undo pin survives a vacuum and the undo still restores", async () => {
    await withTempFile("cell13.txt", DISK_CONTENT, async ({ cwd, path }) => {
      const it = setupIntegrationTest(cwd);
      const read = await it.readTool.execute("c", { path });
      const anchors = readRowHashes(getText(read));
      await it.editTool.execute("c", { path, edits: [[anchors[1]!, anchors[1]!, "BRAVO"]] });
      const pinned = snapshotHashFor(DISK_CONTENT);
      await seedVersions(cwd, path, 10, "seed13");
      const db = new DatabaseSync(hashStorePath(cwd));
      try {
        const pin = db.prepare("SELECT snapshot_hash FROM file_undo WHERE path = ?").get(path) as
          | { snapshot_hash: string | null }
          | undefined;
        expect(pin?.snapshot_hash).toBe(pinned);

        // Over the per-path window and the global budget: only the undo pin protects the target.
        db.prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) " +
            "VALUES ('/bulk.ts', '13:bulk', 2000000, ?, 1)",
        ).run(Date.now() + 60_000);
        (await storeFace(cwd)).vacuumSnapshots();
        expect(
          count(db, "SELECT COUNT(*) AS count FROM file_snapshots WHERE snapshot_hash = ?", pinned),
        ).toBe(1);

        const undone = await it.undoTool.execute("c", { path });
        expect(getText(undone as never)).toContain("Undone last edit");
        expect(await readFile(path, "utf-8")).toBe(DISK_CONTENT);
      } finally {
        db.close();
      }
    });
  });

  it("cell 14 cross-table: a pruned v7 family re-materializes and the legacy row is not the source", async () => {
    await withTempFile("cell14.txt", DISK_CONTENT, async ({ cwd, path }) => {
      const it = setupIntegrationTest(cwd);
      await it.readTool.execute("c", { path });
      const db = new DatabaseSync(hashStorePath(cwd));
      try {
        expect(count(db, "SELECT COUNT(*) AS count FROM file_snapshots WHERE path = ?", path)).toBe(
          1,
        );
        expect(count(db, "SELECT COUNT(*) AS count FROM snapshots WHERE path = ?", path)).toBe(1);

        // Evict the v7 family entirely: the served row is oldest and the bulk row breaks the budget.
        ageLeases(db, path);
        db.prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) " +
            "VALUES ('/bulk.ts', '14:bulk', 2000000, ?, 1)",
        ).run(Date.now() + 60_000);
        (await storeFace(cwd)).vacuumSnapshots();
        expect(count(db, "SELECT COUNT(*) AS count FROM file_snapshots WHERE path = ?", path)).toBe(
          0,
        );
        // D2: the legacy `snapshots` row is a declared non-reclaim — one per path, upgrade fallback.
        expect(count(db, "SELECT COUNT(*) AS count FROM snapshots WHERE path = ?", path)).toBe(1);

        const after = await it.readTool.execute("c", { path });
        expect(count(db, "SELECT COUNT(*) AS count FROM file_snapshots WHERE path = ?", path)).toBe(
          1,
        );
        const expected = await lineHashes(DISK_CONTENT, path);
        expect(readRowHashes(getText(after))).toEqual(expected);
        expect(hashlineBodies(getText(after))).toEqual(DISK_CONTENT.split("\n"));
      } finally {
        db.close();
      }
    });
  });

  it("cell 15 the best-effort trigger reports its own failure and the read still succeeds", async () => {
    await withTempFile("cell15.txt", DISK_CONTENT, async ({ cwd, path }) => {
      const it = setupIntegrationTest(cwd);
      // Ten versions so the next materialization's sweep has an eviction candidate.
      await seedVersions(cwd, path, 10, "seed15");
      const db = new DatabaseSync(hashStorePath(cwd));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        // Inject a broken candidate: any lineage delete aborts, so the sweep throws.
        db.exec(
          "CREATE TRIGGER t5_break_vacuum BEFORE DELETE ON line_lineage BEGIN " +
            "SELECT RAISE(ABORT, 'injected vacuum fault'); END",
        );

        const read = await it.readTool.execute("c", { path });
        expect(readRowHashes(getText(read))).toHaveLength(3);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("vacuum failed"));
        // The read that triggered it still committed its materialization.
        expect(
          count(db, "SELECT COUNT(*) AS count FROM file_snapshots WHERE path = ?", path),
        ).toBeGreaterThan(0);
      } finally {
        db.exec("DROP TRIGGER IF EXISTS t5_break_vacuum");
        warn.mockRestore();
        db.close();
      }
    });
  });
});
