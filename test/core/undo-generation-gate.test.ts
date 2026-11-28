/**
 * Issue #138 — anchor-bearing state is invalidated by the ANCHOR_GENERATION axis, with no schema
 * migration and no per-row generation column (the pair of the raw-byte identity change).
 *
 * The snapshot key carries `${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}`. Three paths read
 * that key, and #221 split their questions along the two axes (ADR-0054):
 *
 *  1. the undo gate (`getUndo`) — fail-closed refusal on the RAW-ANCHOR axis: a pin from another
 *     generation is DELETED, never replayed, because replaying it would restore pre-change anchors.
 *     A canon-only change leaves the stored anchors valid, so its pin is KEPT and the restore
 *     re-derives the snapshot key on the current epoch;
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { loadHashStore, shutdownHashStore, type UndoRecord } from "../../src/hash-store.js";
import { getUndo } from "../../src/undo-edit.js";
import { ANCHOR_GENERATION, CANON_VERSION, contentChecksum } from "../../src/hashline/index.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";
import {
  isCurrentRawAnchorGeneration,
  isCurrentSnapshotEpoch,
  parseSnapshotEpoch,
} from "../../src/snapshot-store/epoch.js";
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

describe("isCurrentSnapshotEpoch — the two-axis evidence predicate", () => {
  it("accepts the current canon+generation pair and refuses a canon-only drift", () => {
    expect(isCurrentSnapshotEpoch(snapshotHashFor(CONTENT))).toBe(true);
    expect(isCurrentSnapshotEpoch(foreignPartTwoHash(CONTENT))).toBe(false);
    const [canonAxis, generationAxis] = snapshotHashFor(CONTENT).split(":");
    expect(isCurrentSnapshotEpoch(`${canonAxis}:${generationAxis}:abcd`)).toBe(true);
    expect(isCurrentSnapshotEpoch(`${canonAxis}:${generationAxis}0:abcd`)).toBe(false);
    expect(isCurrentSnapshotEpoch(`${canonAxis}0:${generationAxis}:abcd`)).toBe(false);
    expect(isCurrentSnapshotEpoch(null)).toBe(false);
    expect(isCurrentSnapshotEpoch(undefined)).toBe(false);
    expect(isCurrentSnapshotEpoch("")).toBe(false);
  });

  it("keeps the raw-anchor axis for anchors, which no canon change can move", () => {
    const [canonAxis, generationAxis] = snapshotHashFor(CONTENT).split(":");
    expect(isCurrentRawAnchorGeneration(ANCHOR_GENERATION)).toBe(true);
    expect(isCurrentRawAnchorGeneration(Number(generationAxis))).toBe(true);
    expect(isCurrentRawAnchorGeneration(999)).toBe(false);
    expect(isCurrentRawAnchorGeneration(null)).toBe(false);
    expect(isCurrentRawAnchorGeneration(undefined)).toBe(false);
    expect(parseSnapshotEpoch(`${canonAxis}0:${generationAxis}:abcd`)?.anchorGeneration).toBe(
      ANCHOR_GENERATION,
    );
    expect(parseSnapshotEpoch(foreignPartTwoHash(CONTENT))).toBeUndefined();
  });
});

describe("undo gate — a foreign-generation pin is refused and the row is reclaimed", () => {
  it("getUndo refuses a two-part pin and deletes the row (fail-closed, never replays)", async () => {
    await withTempDir("undo-generation-", async (dir) => {
      const path = join(dir, "a.ts");
      const store = await loadHashStore();
      store.writeUndo(path, {
        ...LEGACY,
        snapshotHash: foreignPartTwoHash(CONTENT),
      });
      expect(store.getFileUndo(path)?.snapshotHash).toBe(foreignPartTwoHash(CONTENT));

      expect(await getUndo(path)).toBeUndefined();

      const reloaded = await loadHashStore();
      expect(reloaded.getUndo(path)).toBeUndefined();
      expect(reloaded.getFileUndo(path)).toBeUndefined();
      expect(await getUndo(path)).toBeUndefined();
    });
  });

  it("getUndo returns a pair written under the current axes", async () => {
    await withTempDir("undo-current-", async (dir) => {
      const path = join(dir, "a.ts");
      const store = await loadHashStore();
      store.writeUndo(path, { ...LEGACY, snapshotHash: snapshotHashFor(CONTENT) });

      expect(await getUndo(path)).toEqual({
        content: CONTENT,
        bom: "",
        originalEnding: "\n",
        effectiveEnding: "\n",
        preImageMixed: false,
        hashes: ["AAA"],
        resultContent: "beta\n",
      });
    });
  });
});

describe("undo gate — stored canon evidence is fenced by the epoch, raw anchors by the generation", () => {
  it("getUndo KEEPS a canon-only-foreign pin: its raw anchors are still current-generation", async () => {
    await withTempDir("undo-canon-keep-", async (dir) => {
      const path = join(dir, "a.ts");
      const store = await loadHashStore();
      const [canonAxis, generationAxis] = snapshotHashFor(CONTENT).split(":");
      const canonDriftPin = `${Number(canonAxis) - 1}:${generationAxis}:${contentChecksum(CONTENT)}`;
      store.writeUndo(path, { ...LEGACY, snapshotHash: canonDriftPin });

      expect(await getUndo(path)).toMatchObject({ content: CONTENT, hashes: ["AAA"] });
      const reloaded = await loadHashStore();
      expect(reloaded.getUndo(path)).toBeDefined();
      expect(reloaded.getFileUndo(path)?.snapshotHash).toBe(canonDriftPin);
    });
  });

  it("getUndo deletes a foreign-generation pin even when its canon matches", async () => {
    await withTempDir("undo-generation-drift-", async (dir) => {
      const path = join(dir, "a.ts");
      const store = await loadHashStore();
      const generationDriftPin = `${CANON_VERSION}:${ANCHOR_GENERATION + 1}:${contentChecksum(CONTENT)}`;
      store.writeUndo(path, { ...LEGACY, snapshotHash: generationDriftPin });

      expect(await getUndo(path)).toBeUndefined();
      const reloaded = await loadHashStore();
      expect(reloaded.getUndo(path)).toBeUndefined();
      expect(reloaded.getFileUndo(path)).toBeUndefined();
    });
  });
});

describe("open-time sweep — key-prefix reclaim of anchor-bearing rows", () => {
  it("drops foreign-generation v7 rows, keeps current ones, clears the served meta family, and stamps the axes", async () => {
    await withTempDir("anchor-sweep-", async () => {
      const storePath = hashStorePath();
      await loadHashStore();
      shutdownHashStore();

      const foreign = foreignPartTwoHash("foreign\n");
      const current = snapshotHashFor("current\n");
      const now = Date.now();

      const raw = new DatabaseSync(storePath);
      raw.prepare("DELETE FROM meta WHERE key = 'anchor_generation'").run();
      raw.exec("PRAGMA foreign_keys = OFF");
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
      insertLineage.run(999_999, 1, 3, "33", "CCC");
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
      const insertLease = raw.prepare(
        "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, served_line_number, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insertLease.run("s1", "/foreign.ts", "AAA", 1, "11", foreign, 1, now);
      insertLease.run("s1", "/current.ts", "BBB", 2, "22", current, 1, now);
      const insertServedMeta = raw.prepare(
        "INSERT INTO served_session_meta (session_id, file_path, hashes, updated_at) VALUES (?, ?, ?, ?)",
      );
      insertServedMeta.run("s1", "/foreign.ts", JSON.stringify(["AAA"]), now);
      insertServedMeta.run("s1", "/current.ts", JSON.stringify(["BBB"]), now);
      raw
        .prepare("INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?, ?, ?, ?)")
        .run("v6-session", "/v6.ts", JSON.stringify(["V6A"]), now);
      raw.close();

      await loadHashStore();
      shutdownHashStore();

      const after = new DatabaseSync(storePath);
      const count = (sql: string, ...params: string[]): number =>
        Number((after.prepare(sql).get(...params) as { n: number }).n);

      expect(count("SELECT COUNT(*) AS n FROM snapshots WHERE path = '/foreign.ts'")).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM snapshots WHERE path = '/current.ts'")).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM undo WHERE path = '/foreign.ts'")).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM undo WHERE path = '/current.ts'")).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM served")).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = '/foreign.ts'")).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = '/current.ts'")).toBe(1);
      expect(
        count("SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id = ?", String(foreignId)),
      ).toBe(0);
      expect(
        count("SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id = ?", String(currentId)),
      ).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id = 999999")).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM file_undo WHERE path = '/foreign.ts'")).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM file_undo WHERE path = '/current.ts'")).toBe(1);
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
      expect(count("SELECT COUNT(*) AS n FROM served_session_meta")).toBe(0);
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

  it("a prior-canon row written after the open survives the sweep and is still refused at reuse", async () => {
    await withTempDir("anchor-sweep-retention-", async () => {
      const storePath = hashStorePath();
      await loadHashStore();
      shutdownHashStore();

      const priorCanon = `${CANON_VERSION - 1}:${ANCHOR_GENERATION}:${contentChecksum("prior\n")}`;
      const raw = new DatabaseSync(storePath);
      const priorId = Number(
        raw
          .prepare(
            "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) VALUES (?, ?, 1, ?, 1)",
          )
          .run("/prior.ts", priorCanon, Date.now()).lastInsertRowid,
      );
      raw
        .prepare(
          "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?, 1, 1, '11', 'AAA')",
        )
        .run(priorId);
      raw
        .prepare(
          "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, served_line_number, updated_at) VALUES ('s1', '/prior.ts', 'AAA', 1, '11', ?, 1, ?)",
        )
        .run(priorCanon, Date.now());
      raw.close();

      const store = await loadHashStore();
      const after = new DatabaseSync(storePath);
      const count = (sql: string): number => Number((after.prepare(sql).get() as { n: number }).n);
      expect(count("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = '/prior.ts'")).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM served_leases WHERE file_path = '/prior.ts'")).toBe(
        1,
      );
      after.close();

      expect(store.latestLineageFor("/prior.ts")).toBeUndefined();
      expect(
        (
          store as unknown as { positionsByIdentity(p: string, c: string): Map<number, number> }
        ).positionsByIdentity("/prior.ts", "prior\n").size,
      ).toBe(0);
    });
  });
});
