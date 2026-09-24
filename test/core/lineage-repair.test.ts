import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { canonDigest } from "../../src/hashline/hash-assign.js";
import {
  createLineageStore,
  snapshotHashFor,
  type LineageStore,
} from "../../src/snapshot-store/lineage-store.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { codeOf, splitLines } from "../../src/utils.js";

/**
 * CP2 — a corrupt lineage must not trap the file.
 *
 * The corrupt state is the `:338` arm of `commitSnapshot`'s adopt-if-exists path: a
 * `file_snapshots` row exists for `(path, snapshot_hash)` but its `line_lineage` family is
 * empty. `LineageCorruptError` is not a `DomainError` and matches none of
 * `isCorruptionError`'s regexes, so nothing quarantines it — once such a row exists for
 * content the file still has, `commitSnapshot` throws for that content forever.
 *
 * `grantServeLeases` calls `commitSnapshot` INSIDE the `withStore` unit that wrote the
 * `served` row, so the throw rolls the whole served+lease unit back; `recordServed` catches
 * it with `console.error` and returns. The read therefore reports success while nothing was
 * persisted, no lease is granted, and the next edit rejects. A re-read repeats identically.
 *
 * Test files are not typechecked (measured R1); row shapes are proved at runtime, and the
 * store handle is narrowed to `InternalHashStore` at the seam (same narrowing as
 * test/core/serve-leases.test.ts) — no other casts.
 */

type Harness = ReturnType<typeof setupIntegrationTest>;

/** Raw connection to the store file the cached store holds for this workspace. */
function withRawStore<T>(cwd: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(hashStorePath(cwd), { timeout: 2000 });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function countRows(db: DatabaseSync, sql: string, ...params: string[]): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  if (row === undefined) throw new Error("count query returned no row");
  return row.n;
}

/** The anchor the tool served for the first line whose text is `needle`. */
/** The anchor the tool served for the first row whose text is one of `needles`. */
function anchorFor(text: string, ...needles: string[]): string {
  for (const needle of needles) {
    const row = text.split("\n").find((line) => line.includes(`│${needle}`));
    if (row !== undefined) {
      const hash = row.split("│")[0];
      if (hash === undefined) throw new Error("served row carried no anchor");
      return hash;
    }
  }
  throw new Error(`no served row for ${needles.join(" or ")}`);
}

function codeFromText(text: string): string | undefined {
  const match = /\[(E_[A-Z_]+)\]/.exec(text);
  return match?.[1];
}

interface EditAttempt {
  outcome: "applied" | "rejected";
  code: string | undefined;
  text: string;
}

/** Drive the real edit tool and capture whether it applied, and the exact refusal. */
async function attemptEdit(
  harness: Harness,
  anchor: string,
  replacement: string,
): Promise<EditAttempt> {
  try {
    const text = getText(
      await harness.editTool.execute("edit", {
        path: "t.txt",
        edits: [[anchor, anchor, replacement]],
      }),
    );
    const code = codeFromText(text);
    return { outcome: code === undefined ? "applied" : "rejected", code, text };
  } catch (error) {
    return {
      outcome: "rejected",
      code: codeOf(error) ?? codeFromText(String(error)),
      text: String(error),
    };
  }
}

/** Create the `:338` arm for `abs`'s current content, directly. See the generator cell. */
function corruptLineage(cwd: string, abs: string): number {
  return withRawStore(cwd, (db) =>
    Number(
      db
        .prepare(
          "DELETE FROM line_lineage WHERE snapshot_id IN " +
            "(SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
        )
        .run(abs).changes,
    ),
  );
}

function lineageRows(store: InternalHashStore, abs: string, content: string): number {
  return store.lineageFor(abs, snapshotHashFor(content)).length;
}

describe("CP2 — corrupt lineage", () => {
  it("does not trap the file: read → edit terminates instead of looping", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const abs = await harness.io.resolve("t.txt", cwd, new AbortController().signal);
      const store = (await loadHashStore(cwd)) as InternalHashStore;
      const content = "a\nb\nc\n";

      // 1. A normal read: lineage committed, served rows and leases exist.
      getText(await harness.readTool.execute("read", { path: "t.txt" }));
      expect(lineageRows(store, abs, content)).toBe(3);

      // 2. The `:338` arm: keep the snapshot row, drop its lineage family.
      expect(corruptLineage(cwd, abs)).toBe(3);
      expect(lineageRows(store, abs, content)).toBe(0);

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      // 3. Read #1 — what it reports vs what it persisted.
      const readOne = getText(await harness.readTool.execute("read", { path: "t.txt" }));
      const anchorOne = anchorFor(readOne, "b");
      const afterReadOne = {
        reportedSuccess: readOne.includes("│b"),
        lineageRows: lineageRows(store, abs, content),
        servedRows: store.getServed(harness.sessionKey, abs).length,
        leaseForAnchor: store.leaseFor(harness.sessionKey, abs, anchorOne) !== undefined,
      };

      // 4. Edit with the anchor the read just handed the model.
      const attemptOne = await attemptEdit(harness, anchorOne, "Z");

      // 5. Read again, edit again: the same refusal, or an escape.
      const readTwo = getText(await harness.readTool.execute("read", { path: "t.txt" }));
      const attemptTwo = await attemptEdit(harness, anchorFor(readTwo, "Z", "b"), "Y");

      const repairWarned = warn.mock.calls.some((call) => String(call[0]).includes("lineage"));
      warn.mockRestore();

      expect({
        reportedSuccess: afterReadOne.reportedSuccess,
        lineageRows: afterReadOne.lineageRows,
        servedRows: afterReadOne.servedRows,
        leaseForAnchor: afterReadOne.leaseForAnchor,
        editOne: attemptOne.outcome,
        editTwo: attemptTwo.outcome,
        refusalCode: attemptOne.code,
        refusal: attemptOne.outcome === "rejected" ? attemptOne.text : "n/a",
        sameRefusal: attemptOne.outcome === "rejected" && attemptOne.text === attemptTwo.text,
        repairWarned,
        fileAfter: await readFile(path, "utf-8"),
      }).toEqual({
        reportedSuccess: true,
        lineageRows: 3,
        servedRows: 3,
        leaseForAnchor: true,
        editOne: "applied",
        editTwo: "applied",
        refusalCode: undefined,
        refusal: "n/a",
        sameRefusal: false,
        repairWarned: true,
        fileAfter: "a\nY\nc\n",
      });
    });
  });
  /** The four row families `deleteByPath` owns, counted for one path. */
  function familyCounts(
    db: DatabaseSync,
    lineage: LineageStore,
    path: string,
    content: string,
  ): { snapshotRows: number; lineageRows: number; counterRows: number; leaseRows: number } {
    return {
      snapshotRows: countRows(db, "SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?", path),
      lineageRows: lineage.lineageFor(path, snapshotHashFor(content)).length,
      counterRows: countRows(db, "SELECT COUNT(*) AS n FROM line_id_counters WHERE path = ?", path),
      leaseRows: countRows(db, "SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ?", path),
    };
  }

  it("deleteByPath is one unit: an interrupted delete cannot split the family", () => {
    const db = new DatabaseSync(":memory:");
    const lineage: LineageStore = createLineageStore(db);
    const content = "a\nb\nc\n";

    // Seed ALL FOUR families: the snapshot + its lineage, the per-path id counter, and two
    // `served_leases` rows (two, so a partial delete of the lease family is observable).
    lineage.commitSnapshot({
      path: "t.txt",
      content,
      hashes: ["aaa", "bbb", "ccc"],
      leases: {
        sessionKey: "cp3",
        rows: [
          { position: 0, hash: "aaa" },
          { position: 1, hash: "bbb" },
        ],
      },
    });

    // The seed is confirmed at runtime, never assumed.
    const seeded = familyCounts(db, lineage, "t.txt", content);

    // Deterministic fault BETWEEN the four statements: the first (lineage delete) runs,
    // the second (snapshot delete) aborts. `withBusyRetry` rethrows non-busy errors.
    db.exec(
      "CREATE TRIGGER block_snapshot_delete BEFORE DELETE ON file_snapshots " +
        "BEGIN SELECT RAISE(ABORT, 'injected: delete interrupted'); END",
    );
    let faulted = false;
    try {
      lineage.deleteByPath("t.txt");
    } catch {
      faulted = true;
    }
    db.exec("DROP TRIGGER block_snapshot_delete");

    const interrupted = familyCounts(db, lineage, "t.txt", content);

    // With the trigger gone the same delete runs to completion on the family the rollback
    // restored. This is the only way to observe the counters and leases statements at all:
    // the interrupted path rolls them back, so it cannot tell whether they ever ran.
    lineage.deleteByPath("t.txt");
    const successful = familyCounts(db, lineage, "t.txt", content);

    // One object compare: any single family diverging fails loudly.
    expect({ seeded, interrupted: { faulted, ...interrupted }, successful }).toEqual({
      seeded: { snapshotRows: 1, lineageRows: 3, counterRows: 1, leaseRows: 2 },
      interrupted: {
        faulted: true,
        snapshotRows: 1,
        lineageRows: 3,
        counterRows: 1,
        leaseRows: 2,
      },
      successful: { snapshotRows: 0, lineageRows: 0, counterRows: 0, leaseRows: 0 },
    });
  });
  it("repairs a canon-inconsistent lineage instead of reusing its ids", () => {
    const db = new DatabaseSync(":memory:");
    const lineage: LineageStore = createLineageStore(db);
    const content = "alpha\nbeta";
    const hash = snapshotHashFor(content);
    const trueCanons = splitLines(content).map((line) => canonDigest(line));

    // 1. Commit, so ids 1,2 exist and the stored canons are the true ones.
    lineage.commitSnapshot({ path: "/k.ts", content, hashes: ["A0", "A1"] });
    const before = lineage.lineageFor("/k.ts", hash);
    expect(before.map((row) => row.lineId)).toEqual([1, 2]);
    expect(before.map((row) => row.canonHash)).toEqual(trueCanons);

    // 2. Corrupt the stored canon out of band: count and numbering stay intact, so only a
    //    canon comparison can tell this family is unusable.
    db.exec("UPDATE line_lineage SET canon_hash = 'deadbeef'");

    // 3. Re-adopt the same (path, content).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lineage.commitSnapshot({ path: "/k.ts", content, hashes: ["A0", "A1"] });
    const warnCalls = warn.mock.calls.length;
    const warned = warn.mock.calls.map((call) => String(call[0])).join(" ");
    warn.mockRestore();

    const after = lineage.lineageFor("/k.ts", hash);
    expect({
      warnCalls,
      warnFired: /repairing corrupt lineage/.test(warned),
      namesCanonArm: /canon mismatch at line 1/.test(warned),
      // STILL_CORRUPT must be false: every stored canon is the true one again.
      canons: after.map((row) => row.canonHash),
      numbering: after.map((row) => row.lineNumber),
      // IDS_AFTER must not be 1,2: the corrupt rows' ids are never inherited.
      ids: after.map((row) => row.lineId),
      idsAreFresh: after.every((row) => before.every((old) => old.lineId !== row.lineId)),
      snapshotRows: countRows(
        db,
        "SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?",
        "/k.ts",
      ),
    }).toEqual({
      warnCalls: 1,
      warnFired: true,
      namesCanonArm: true,
      canons: trueCanons,
      numbering: [1, 2],
      idsAreFresh: true,
      ids: [3, 4],
      snapshotRows: 1,
    });
  });
});
