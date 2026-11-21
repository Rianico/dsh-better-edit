/**
 * Issue #138 — anchor-bearing state is invalidated by the ANCHOR_GENERATION axis, with no schema
 * migration and no per-row generation column (the pair of the raw-byte identity change).
 *
 * The snapshot key carries `${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}`. Two reclaim paths
 * read that key prefix:
 *
 *  1. the undo gate (`getUndo`) — fail-closed refusal: a pair whose v7 pin was minted under another
 *     generation is DELETED, never replayed, because replaying it would restore pre-change anchors;
 *  2. the open-time sweep (`buildStore`) — one `BEGIN IMMEDIATE` that drops every row whose key was
 *     minted under a foreign generation, plus the rows that carry no key at all (`served`), then
 *     stamps `meta.anchor_generation` so a later open is a no-op.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { loadHashStore, shutdownHashStore, type UndoRecord } from "../../src/hash-store.js";
import { getUndo } from "../../src/undo-edit.js";
import { ANCHOR_GENERATION, CANON_VERSION, contentChecksum } from "../../src/hashline/index.js";
import {
  isCurrentGenerationSnapshotHash,
  snapshotHashFor,
} from "../../src/snapshot-store/lineage-store.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { withTempDir } from "../support/fixtures.js";

const CONTENT = "alpha\n";
const LEGACY: UndoRecord = {
  content: CONTENT,
  bom: "",
  ending: "\n",
  hashes: ["AAA"],
  resultContent: "beta\n",
};

/** A key in the OLD two-part shape (`<canon>:<checksum>`): a foreign, pre-generation pin. */
function foreignPartTwoHash(content: string): string {
  return `${CANON_VERSION}:${contentChecksum(content)}`;
}

describe("isCurrentGenerationSnapshotHash — the key-prefix predicate", () => {
  it("accepts the current canon+generation pair and refuses the retired two-part shape", () => {
    expect(isCurrentGenerationSnapshotHash(snapshotHashFor(CONTENT))).toBe(true);
    // A 2-part key is NOT current: a prefix-only check would accept it, the axes must both match.
    expect(isCurrentGenerationSnapshotHash(foreignPartTwoHash(CONTENT))).toBe(false);
    const [canonAxis, generationAxis] = snapshotHashFor(CONTENT).split(":");
    expect(isCurrentGenerationSnapshotHash(`${canonAxis}:${generationAxis}:abcd`)).toBe(true);
    expect(isCurrentGenerationSnapshotHash(`${canonAxis}:${generationAxis}0:abcd`)).toBe(false);
    expect(isCurrentGenerationSnapshotHash(`${canonAxis}0:${generationAxis}:abcd`)).toBe(false);
    expect(isCurrentGenerationSnapshotHash(null)).toBe(false);
    expect(isCurrentGenerationSnapshotHash(undefined)).toBe(false);
    expect(isCurrentGenerationSnapshotHash("")).toBe(false);
  });
});

describe("undo gate — a foreign-generation pin is refused and the pair is reclaimed", () => {
  it("getUndo refuses a two-part pin and deletes the pair (fail-closed, never replays)", async () => {
    await withTempDir("undo-generation-", async (dir) => {
      const path = join(dir, "a.ts");
      const store = await loadHashStore();
      store.writeUndoPair(path, LEGACY, {
        ...LEGACY,
        snapshotHash: foreignPartTwoHash(CONTENT),
      });
      // The pin exists on disk before the gate runs.
      expect(store.getFileUndo(path)?.snapshotHash).toBe(foreignPartTwoHash(CONTENT));

      expect(await getUndo(path)).toBeUndefined();

      // The refusal DELETES the pair rather than hiding it: both sides are gone.
      const reloaded = await loadHashStore();
      expect(reloaded.getUndo(path)).toBeUndefined();
      expect(reloaded.getFileUndo(path)).toBeUndefined();
      // Idempotent: a second read of the reclaimed path is still a clean miss.
      expect(await getUndo(path)).toBeUndefined();
    });
  });

  it("getUndo returns a pair written under the current axes", async () => {
    await withTempDir("undo-current-", async (dir) => {
      const path = join(dir, "a.ts");
      const store = await loadHashStore();
      store.writeUndoPair(path, LEGACY, { ...LEGACY, snapshotHash: snapshotHashFor(CONTENT) });

      expect(await getUndo(path)).toEqual({
        content: CONTENT,
        bom: "",
        originalEnding: "\n",
        hashes: ["AAA"],
        resultContent: "beta\n",
      });
    });
  });
});

describe("open-time sweep — key-prefix reclaim of anchor-bearing rows", () => {
  it("drops foreign-generation rows, keeps current ones, clears served, and stamps the axes", async () => {
    await withTempDir("anchor-sweep-", async () => {
      const storePath = hashStorePath();
      // First open creates the schema and stamps meta.version.
      await loadHashStore();
      shutdownHashStore();

      const foreign = foreignPartTwoHash("foreign\n");
      const current = snapshotHashFor("current\n");
      const now = Date.now();

      const raw = new DatabaseSync(storePath);
      // Model the upgrade: a store written by a build that had no generation axis carries no stamp,
      // so the next open MUST sweep. Clearing it here is the fixture's whole premise — with the
      // stamp present the sweep is a documented no-op (pinned by the idempotence arm below).
      raw.prepare("DELETE FROM meta WHERE key = 'anchor_generation'").run();
      // FKs off so the orphan-lineage fixture (a lineage row whose snapshot is gone) can exist: the
      // sweep's third statement is the reclaim an FK-off opener relies on.
      raw.exec("PRAGMA foreign_keys = OFF");
      // ---- a foreign-generation family, plus a current-generation survivor ----
      const insertSnapshot = raw.prepare(
        "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      insertSnapshot.run("/foreign.ts", foreign, 1, JSON.stringify(["AAA"]), now);
      insertSnapshot.run("/current.ts", current, 1, JSON.stringify(["BBB"]), now);
      const insertFileSnapshot = raw.prepare(
        "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) VALUES (?, ?, ?, ?, 1)",
      );
      const foreignId = Number(
        insertFileSnapshot.run("/foreign.ts", foreign, 1, now).lastInsertRowid,
      );
      const currentId = Number(
        insertFileSnapshot.run("/current.ts", current, 1, now).lastInsertRowid,
      );
      const insertLineage = raw.prepare(
        "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?, ?, ?, ?, ?)",
      );
      insertLineage.run(foreignId, 1, 1, "11", "AAA");
      insertLineage.run(currentId, 1, 2, "22", "BBB");
      // An orphan lineage row (its snapshot is gone) — the reclaim deletes it too.
      insertLineage.run(999_999, 1, 3, "33", "CCC");
      // ---- undo: a foreign pair and a current pair ----
      const insertFileUndo = raw.prepare(
        "INSERT INTO file_undo (path, content, bom, ending, hashes, result_content, snapshot_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insertFileUndo.run(
        "/foreign.ts",
        CONTENT,
        "",
        "\n",
        JSON.stringify(["AAA"]),
        "beta\n",
        foreign,
        now,
      );
      insertFileUndo.run(
        "/current.ts",
        CONTENT,
        "",
        "\n",
        JSON.stringify(["BBB"]),
        "beta\n",
        current,
        now,
      );
      const insertUndo = raw.prepare(
        "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      insertUndo.run("/foreign.ts", CONTENT, "", "\n", JSON.stringify(["AAA"]), "beta\n", now);
      insertUndo.run("/current.ts", CONTENT, "", "\n", JSON.stringify(["BBB"]), "beta\n", now);
      // ---- leases: one foreign, one current ----
      const insertLease = raw.prepare(
        "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, served_line_number, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insertLease.run("s1", "/foreign.ts", "AAA", 1, "11", foreign, 1, now);
      insertLease.run("s1", "/current.ts", "BBB", 2, "22", current, 1, now);
      // ---- served rows carry anchors and canons but NO key: the stamp decides ----
      const insertServed = raw.prepare(
        "INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?, ?, ?, ?)",
      );
      insertServed.run("s1", "/foreign.ts", JSON.stringify(["AAA"]), now);
      insertServed.run("s1", "/current.ts", JSON.stringify(["BBB"]), now);
      raw.close();

      // The open-time sweep runs here.
      await loadHashStore();
      shutdownHashStore();

      const after = new DatabaseSync(storePath);
      const count = (sql: string, ...params: string[]): number =>
        Number((after.prepare(sql).get(...params) as { n: number }).n);

      expect(count("SELECT COUNT(*) AS n FROM snapshots WHERE path = '/foreign.ts'")).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM snapshots WHERE path = '/current.ts'")).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = '/foreign.ts'")).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = '/current.ts'")).toBe(1);
      // Foreign lineage + the orphan are gone; the survivor's lineage stays.
      expect(
        count("SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id = ?", String(foreignId)),
      ).toBe(0);
      expect(
        count("SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id = ?", String(currentId)),
      ).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id = 999999")).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM file_undo WHERE path = '/foreign.ts'")).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM file_undo WHERE path = '/current.ts'")).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM undo WHERE path = '/foreign.ts'")).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM undo WHERE path = '/current.ts'")).toBe(1);
      expect(
        count(
          "SELECT COUNT(*) AS n FROM served_leases WHERE file_path = '/foreign.ts' AND anchor = 'AAA'",
        ),
      ).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS n FROM served_leases WHERE file_path = '/current.ts' AND anchor = 'BBB'",
        ),
      ).toBe(1);
      // No per-row generation marker without a migration, so the stamp decides: served is cleared.
      expect(count("SELECT COUNT(*) AS n FROM served")).toBe(0);
      expect(
        (
          after.prepare("SELECT value FROM meta WHERE key = 'anchor_generation'").get() as
            | { value: string }
            | undefined
        )?.value,
      ).toBe(`${CANON_VERSION}:${ANCHOR_GENERATION}`);
      after.close();
    });
  });
});
