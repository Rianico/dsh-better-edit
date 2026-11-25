/**
 * Issue #221: `undo_last_edit` restores a pin recorded under a prior canon and serves the restored
 * anchors under the CURRENT snapshot epoch, so the next edit needs no intermediate read (ADR-0054).
 *
 * Downstream has no pin-adoption seam: the revert always re-materializes through
 * `upsertSnapshot`/`commitSnapshot`, which recompute the snapshot key on the current epoch. The pin
 * is therefore only a validity gate — kept iff its raw anchors are still current-generation. A
 * canon-only-foreign pin is what the old full-epoch gate DELETED, which made the undo unavailable.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { loadHashStore } from "../../src/hash-store.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
import {
  ANCHOR_GENERATION,
  CANON_VERSION,
  initHasher,
  lineHashesPure,
} from "../../src/hashline/index.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { splitLines } from "../../src/utils.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

const PRE = "aaa\nbbb\nccc\n";
const POST = "aaa\nBBB\nccc\n";

beforeAll(async () => {
  await initHasher();
});

/**
 * The state an edit leaves behind: `POST` committed as the file's current snapshot and the
 * `POST` -> `PRE` undo pair pinned to `snapshotHash`. `materializePre` also commits `PRE` on the
 * current epoch — the case where the revert re-adopts instead of materializing.
 *
 * Planting goes through the workspace-scoped store handle (`cwd`), because the tool's own
 * `withWorkspace` call resolves the same per-workspace store path.
 */
async function plantPinnedUndo(
  cwd: string,
  abs: string,
  snapshotHash: string,
  options: { materializePre?: boolean } = {},
): Promise<void> {
  const store = await loadHashStore(cwd);
  const hashes = lineHashesPure(PRE);
  if (options.materializePre) {
    store.upsertSnapshot(abs, contentChecksum(PRE), splitLines(PRE).length, hashes, PRE);
  }
  store.upsertSnapshot(
    abs,
    contentChecksum(POST),
    splitLines(POST).length,
    lineHashesPure(POST),
    POST,
  );
  store.writeUndo(abs, {
    content: PRE,
    bom: "",
    ending: "\n",
    hashes,
    resultContent: POST,
    snapshotHash,
  });
}

interface ActiveLease {
  anchor: string;
  servedSnapshotHash: string;
  lineNumber: number;
}

function rawQuery<T>(cwd: string, read: (db: DatabaseSync) => T): T {
  const raw = new DatabaseSync(hashStorePath(cwd));
  try {
    return read(raw);
  } finally {
    raw.close();
  }
}

function activeLeases(cwd: string, abs: string): ActiveLease[] {
  return rawQuery(
    cwd,
    (db) =>
      db
        .prepare(
          "SELECT anchor, served_snapshot_hash AS servedSnapshotHash, " +
            "served_line_number AS lineNumber FROM served_leases " +
            "WHERE file_path = ? AND retired_at IS NULL",
        )
        .all(abs) as unknown as ActiveLease[],
  );
}

function counterOf(cwd: string, abs: string): number | undefined {
  return rawQuery(
    cwd,
    (db) =>
      (
        db.prepare("SELECT next_id FROM line_id_counters WHERE path = ?").get(abs) as
          | { next_id: number }
          | undefined
      )?.next_id,
  );
}

describe("issue #221 — the undo producer re-derives a prior-canon pin", () => {
  it("restores PRE from a prior-canon pin and serves anchors the next edit accepts", async () => {
    await withTempFile("u.txt", POST, async ({ cwd }) => {
      const abs = join(cwd, "u.txt");
      const priorEpochPin = `${CANON_VERSION - 1}:${ANCHOR_GENERATION}:${contentChecksum(PRE)}`;
      await plantPinnedUndo(cwd, abs, priorEpochPin);

      const { getTool, ctx } = setupIntegrationTest(cwd);
      const undoResult = await getTool("undo_last_edit").execute(
        "u1",
        { path: "u.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(undoResult)).not.toContain("No undo history");
      expect(await readFile(abs, "utf-8")).toBe(PRE);

      // The restore re-materialized PRE under the current epoch, so its lease names today's canon.
      const leases = activeLeases(cwd, abs);
      expect(leases.length).toBeGreaterThan(0);
      expect(leases.every((lease) => lease.servedSnapshotHash === snapshotHashFor(PRE))).toBe(true);
      const anchor = leases.find((lease) => lease.lineNumber === 2)?.anchor;
      expect(anchor).toBeDefined();

      await getTool("edit").execute(
        "e1",
        {
          file: "u.txt",
          edits: [{ anchor_from: anchor, anchor_to: anchor, replace_with: "bbbX" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(abs, "utf-8")).toBe("aaa\nbbbX\nccc\n");
    });
  });

  it("a same-epoch pin re-adopts the pre-image and allocates no line_id", async () => {
    await withTempFile("s.txt", POST, async ({ cwd }) => {
      const abs = join(cwd, "s.txt");
      await plantPinnedUndo(cwd, abs, snapshotHashFor(PRE), { materializePre: true });
      const allocatedBefore = counterOf(cwd, abs);
      expect(allocatedBefore).toBeDefined();

      const { getTool, ctx } = setupIntegrationTest(cwd);
      await getTool("undo_last_edit").execute("u1", { path: "s.txt" }, undefined, undefined, ctx);

      expect(await readFile(abs, "utf-8")).toBe(PRE);
      expect(counterOf(cwd, abs)).toBe(allocatedBefore);
    });
  });
});
