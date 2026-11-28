/**
 * Issue #221: stored canon evidence is scoped to its full snapshot epoch,
 * `CANON_VERSION:ANCHOR_GENERATION` (ADR-0054).
 *
 * Each arm plants one benign two-line snapshot through raw SQL, because no write path can mint a
 * foreign key: `commitSnapshot` always recomputes `snapshotHashFor(content)`. Line 1's stored canon
 * digest is the CURRENT digest of an externally rewritten line — the evidence a canon that folded
 * interior whitespace would have stored. Planted under a prior canon that evidence must neither carry
 * a `line_id`, nor resolve a lease, nor pair into the next snapshot; planted under the current epoch
 * the same rows do all three. Downstream has no stat-adoption seam, so the upstream stat arm has no
 * carrier here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { InternalHashStore } from "../../src/hash-store.js";
import { loadHashStore } from "../../src/hash-store.js";
import { makeLeaseSource } from "../../src/mutation/engine.js";
import {
  ANCHOR_GENERATION,
  CANON_VERSION,
  contentChecksum,
  initHasher,
} from "../../src/hashline/index.js";
import { canonDigest, rawDigest } from "../../src/hashline/hash-assign.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { withTempDir } from "../support/fixtures.js";

const PATH = "/snapshot-epoch-221/a.ts";
const SESSION = "session-221";
const SERVED = 'value="a b"\nconst plain=1;\n';
const REWRITTEN_LINE = 'value="ab"';
const REWRITTEN = `${REWRITTEN_LINE}\nconst plain=1;\n`;
const SERVED_LINES = SERVED.split("\n");
const REWRITTEN_HASHES = ["CCC", "DDD"];
const PLANTED_LINE_ID = 7;
const PLANTED_ANCHOR = "AAA";
const PLANTED_ANCHOR_2 = "BBB";

const PRIOR_CANON = CANON_VERSION - 1;

beforeAll(async () => {
  await initHasher();
});

interface Planted {
  snapshotHash: string;
  anchor: string;
  lineId: number;
}

/**
 * Runs `read` against its own handle on the workspace store — the same shape the write path leaves
 * on disk, read without reaching into the store's private `db`.
 */
function rawQuery<T>(read: (db: DatabaseSync) => T): T {
  const raw = new DatabaseSync(hashStorePath());
  try {
    return read(raw);
  } finally {
    raw.close();
  }
}

/**
 * Plants one committed snapshot for `PATH` under `canonVersion`, with line 1 leased and line 1's
 * stored canon digest equal to the current digest of the rewritten line. Raw SQL because every
 * write path would mint a current-epoch key.
 */
function plantSnapshot(canonVersion: number): Planted {
  const snapshotHash = `${canonVersion}:${ANCHOR_GENERATION}:${contentChecksum(SERVED)}`;
  const now = Date.now();
  const raw = new DatabaseSync(hashStorePath());
  try {
    const inserted = raw
      .prepare(
        "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) " +
          "VALUES (?, ?, ?, ?, 1)",
      )
      .run(PATH, snapshotHash, SERVED_LINES.length, now);
    const snapshotId = Number(inserted.lastInsertRowid);
    const insertLine = raw.prepare(
      "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, raw_hash, anchor) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertLine.run(
      snapshotId,
      1,
      PLANTED_LINE_ID,
      canonDigest(REWRITTEN_LINE),
      rawDigest(SERVED_LINES[0]!),
      PLANTED_ANCHOR,
    );
    insertLine.run(
      snapshotId,
      2,
      PLANTED_LINE_ID + 1,
      canonDigest(SERVED_LINES[1]!),
      rawDigest(SERVED_LINES[1]!),
      PLANTED_ANCHOR_2,
    );
    raw
      .prepare(
        "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, " +
          "served_snapshot_hash, served_line_number, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
      )
      .run(
        SESSION,
        PATH,
        PLANTED_ANCHOR,
        PLANTED_LINE_ID,
        canonDigest(REWRITTEN_LINE),
        snapshotHash,
        now,
      );
  } finally {
    raw.close();
  }
  return { snapshotHash, anchor: PLANTED_ANCHOR, lineId: PLANTED_LINE_ID };
}

async function withStore(run: (store: InternalHashStore) => void): Promise<void> {
  await withTempDir("snapshot-epoch-221-", async () => {
    const store = (await loadHashStore()) as unknown as InternalHashStore;
    run(store);
  });
}

/** Commits `REWRITTEN` and returns the `line_id` its first line was given. */
function materializeRewritten(store: InternalHashStore): number {
  store.commitSnapshot({ path: PATH, content: REWRITTEN, hashes: REWRITTEN_HASHES });
  const row = rawQuery(
    (db) =>
      db
        .prepare(
          "SELECT ll.line_id FROM file_snapshots fs " +
            "JOIN line_lineage ll ON ll.snapshot_id = fs.snapshot_id " +
            "WHERE fs.path = ? AND fs.snapshot_hash = ? AND ll.line_number = 1",
        )
        .get(PATH, snapshotHashFor(REWRITTEN)) as { line_id: number } | undefined,
  );
  expect(row).toBeDefined();
  return row!.line_id;
}

describe("issue #221 — prior-canon evidence is fenced at every reuse seam", () => {
  it("latestLineageFor does not serve a prior-canon snapshot", async () => {
    await withStore((store) => {
      plantSnapshot(PRIOR_CANON);
      expect(store.latestLineageFor(PATH)).toBeUndefined();
    });
  });

  it("latestLineageFor serves a current-epoch snapshot", async () => {
    await withStore((store) => {
      const planted = plantSnapshot(CANON_VERSION);
      expect(planted.snapshotHash).toBe(snapshotHashFor(SERVED));
      expect(store.latestLineageFor(PATH)?.map((row) => row.lineId)).toEqual([
        PLANTED_LINE_ID,
        PLANTED_LINE_ID + 1,
      ]);
    });
  });

  it("positionsByIdentity does not pair a prior-canon line_id into rewritten content", async () => {
    await withStore((store) => {
      const planted = plantSnapshot(PRIOR_CANON);
      expect(store.positionsByIdentity(PATH, REWRITTEN).get(planted.lineId)).toBeUndefined();
    });
  });

  it("positionsByIdentity pairs a current-epoch line_id into rewritten content", async () => {
    await withStore((store) => {
      const planted = plantSnapshot(CANON_VERSION);
      expect(store.positionsByIdentity(PATH, REWRITTEN).get(planted.lineId)).toBe(1);
    });
  });

  it("the lease source does not resolve a prior-canon lease", async () => {
    await withStore((store) => {
      const planted = plantSnapshot(PRIOR_CANON);
      const source = makeLeaseSource(store, SESSION, PATH, REWRITTEN);
      expect(source).toBeDefined();
      expect(source!.leaseFor(planted.anchor)).toBeUndefined();
      expect(source!.rebasedLineOf(planted.lineId)).toBeUndefined();
    });
  });

  it("the lease source resolves a current-epoch lease", async () => {
    await withStore((store) => {
      const planted = plantSnapshot(CANON_VERSION);
      const source = makeLeaseSource(store, SESSION, PATH, REWRITTEN);
      expect(source!.leaseFor(planted.anchor)).toMatchObject({
        lineId: planted.lineId,
        servedSnapshotHash: planted.snapshotHash,
        retiredAt: null,
      });
      expect(source!.rebasedLineOf(planted.lineId)).toBe(1);
    });
  });

  it("commitSnapshot pairs nothing against a prior-canon-only snapshot", async () => {
    await withStore((store) => {
      const planted = plantSnapshot(PRIOR_CANON);
      expect(materializeRewritten(store)).not.toBe(planted.lineId);
    });
  });

  it("commitSnapshot inherits the line_id from a current-epoch previous snapshot", async () => {
    await withStore((store) => {
      const planted = plantSnapshot(CANON_VERSION);
      expect(materializeRewritten(store)).toBe(planted.lineId);
    });
  });
});
