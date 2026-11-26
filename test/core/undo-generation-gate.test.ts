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
 *  2. the open-time sweep (`buildStore`) — one `BEGIN IMMEDIATE` that drops every row whose key was
 *     minted under a foreign epoch, plus the rows that carry no key at all (`served`), then stamps
 *     `meta.anchor_generation` so a later open is a no-op. Retention only, never validity: a row
 *     that outlives the sweep is still refused at every reuse seam;
 *  3. the reuse seams — `latestSnapshotStmt`, the lease source and undo's pin — ask the full epoch
 *     for stored canon evidence and the generation alone for raw anchors.
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
    // A 2-part key is NOT an epoch: the axes must both be present and match.
    expect(isCurrentSnapshotEpoch(foreignPartTwoHash(CONTENT))).toBe(false);
    const [canonAxis, generationAxis] = snapshotHashFor(CONTENT).split(":");
    expect(isCurrentSnapshotEpoch(`${canonAxis}:${generationAxis}:abcd`)).toBe(true);
    expect(isCurrentSnapshotEpoch(`${canonAxis}:${generationAxis}0:abcd`)).toBe(false);
    // A canon-only change still moves the epoch: stored canon evidence is not reusable across it.
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
    // The canon-only pin parses, and its generation component is what the undo gate asks.
    expect(parseSnapshotEpoch(`${canonAxis}0:${generationAxis}:abcd`)?.anchorGeneration).toBe(
      ANCHOR_GENERATION,
    );
    expect(parseSnapshotEpoch(foreignPartTwoHash(CONTENT))).toBeUndefined();
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
        // #171: the reader always names the ending the revert writes and the mixture flag; a pair
        // written without them falls back to `ending` and reports no mixture.
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
      store.writeUndoPair(path, LEGACY, { ...LEGACY, snapshotHash: canonDriftPin });

      // The pair survives the gate: the restore re-derives the snapshot key on the current epoch.
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
      store.writeUndoPair(path, LEGACY, { ...LEGACY, snapshotHash: generationDriftPin });

      expect(await getUndo(path)).toBeUndefined();
      const reloaded = await loadHashStore();
      expect(reloaded.getUndo(path)).toBeUndefined();
      expect(reloaded.getFileUndo(path)).toBeUndefined();
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

  it("a prior-canon row written after the open survives the sweep and is still refused at reuse", async () => {
    await withTempDir("anchor-sweep-retention-", async () => {
      const storePath = hashStorePath();
      // The first open creates the schema and stamps the CURRENT epoch, so later opens are no-ops.
      await loadHashStore();
      shutdownHashStore();

      // A concurrent mixed-version writer mints a prior-canon family AFTER the sweep ran. Nothing
      // reclaims it until a future open whose stamp differs, so it is retained — and must still be
      // refused as evidence: retention is not validity (ADR-0054).
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

      // Retained, never evidence: the read-path alignment and the identity map both decline it.
      expect(store.latestLineageFor("/prior.ts")).toBeUndefined();
      expect(
        (
          store as unknown as { positionsByIdentity(p: string, c: string): Map<number, number> }
        ).positionsByIdentity("/prior.ts", "prior\n").size,
      ).toBe(0);
    });
  });
});
