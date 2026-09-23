/**
 * v7 identity substrate: the single owner of `file_snapshots`, `line_lineage`,
 * `line_id_counters` and the `served_leases` write path. Co-location is
 * deliberate: a snapshot, its lineage and the leases bound to it commit as one
 * unit, so a crash can never leave leases pointing at a snapshot that was
 * never recorded (or lineage without its snapshot row).
 *
 * Transaction semantics: `commitSnapshot` runs adopt-or-insert plus the lease
 * grant inside the store's single re-entrant transaction owner
 * (`snapshot-store/txn.ts`). Outermost it opens ONE `BEGIN IMMEDIATE`; nested it
 * joins the caller's unit, so a failure rolls the whole unit back and propagates.
 * Retry policy: the owner retries only the BEGIN/COMMIT acquisitions, so every
 * `.run` below carries its own `withBusyRetry` — matching `hash-store`'s `stmts`
 * wrappers and `snapshot-store/index.ts`. A transient SQLITE_BUSY on any lineage
 * statement retries instead of aborting the unit.
 *
 * Pairing rule (deterministic): a new snapshot's lines inherit `line_id`s from
 * the path's latest committed snapshot —
 * 1. same line number AND same `canon_hash` → inherit that `line_id`;
 * 2. then, for remaining new lines, if a `canon_hash` matches still-unclaimed
 *    previous lines → inherit one (a moved line keeps its identity);
 * 3. ambiguous/duplicate matches: lowest unclaimed previous line number wins
 *    (rules 2+3 unify: each canon holds a line-number-ordered queue of the
 *    still-unclaimed previous lines; take the head);
 * 4. everything else (inserted lines) → fresh ids, assigned in line order;
 * 5. no previous snapshot for the path → every line fresh.
 *
 * Divergence from upstream: this rule is canonical-form keyed (compares
 * `canonDigest` values), while upstream pairs by patience LCS (see
 * `upstream/main:src/hashline/patience-pairing.ts`). T7 reconciles
 * numbering/parity work; the patience engine is deliberately not ported here.
 *
 * @module dsh-better-edit/snapshot-store/lineage-store
 */
import { DatabaseSync } from "node:sqlite";
import { CANON_VERSION, canonDigest, contentChecksum } from "../hashline/hash-assign.js";
import { splitLines } from "../utils.js";
import { withBusyRetry } from "../store-retry.js";
import { withTransaction } from "./txn.js";

export function snapshotHashFor(content: string): string {
  return `${CANON_VERSION}:${contentChecksum(content)}`;
}

/**
 * A snapshot row whose lineage is missing or malformed. Thrown (never silently
 * repaired) so a corrupt snapshot can never pin a path into a lease-less state.
 */
export class LineageCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineageCorruptError";
  }
}

export interface CommitLeases {
  sessionKey: string;
  rows: ReadonlyArray<{ position: number; hash: string | null }>;
}

export interface CommitSnapshotInput {
  /** Canonical content actually served/hashed. */
  path: string;
  content: string;
  /** Anchors, parallel to splitLines(content). */
  hashes: string[];
  leases?: CommitLeases;
}

export interface LineageRow {
  lineNumber: number;
  lineId: number;
  canonHash: string;
  anchor: string;
}

export interface LeaseRow {
  lineId: number;
  canonHash: string;
  snapshotHash: string;
  lineNumber: number;
  retiredAt: number | null;
}

export interface LineageStore {
  /** Create-or-adopt (path, snapshotHash) and grant leases in ONE BEGIN IMMEDIATE. */
  commitSnapshot(input: CommitSnapshotInput): void;
  lineageFor(path: string, snapshotHash: string): LineageRow[];
  leaseFor(sessionKey: string, path: string, anchor: string): LeaseRow | undefined;
  /** Delete a path's whole lineage family (snapshots, lineage, counters, leases). */
  deleteByPath(path: string): void;
}

interface SnapshotRow {
  snapshot_id: number;
  snapshot_hash: string;
}

interface PrevLine {
  lineNumber: number;
  lineId: number;
  canonHash: string;
}

interface CounterRow {
  next_id: number;
}

interface LineageRecord {
  line_number: number;
  line_id: number;
  canon_hash: string;
  anchor: string;
}

interface LeaseRecord {
  line_id: number;
  canon_hash: string;
  served_snapshot_hash: string;
  served_line_number: number;
  retired_at: number | null;
}

/** Canonical DDL for the four lineage-owned tables (IF NOT EXISTS, additive). */
export function ensureLineageTables(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS file_snapshots (" +
      "snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "path TEXT NOT NULL, " +
      "snapshot_hash TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "created_at INTEGER NOT NULL, " +
      "committed INTEGER NOT NULL DEFAULT 1, " +
      "UNIQUE (path, snapshot_hash)" +
      ")",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_snapshots_created ON file_snapshots (created_at)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS line_id_counters (" +
      "path TEXT PRIMARY KEY, " +
      "next_id INTEGER NOT NULL" +
      ")",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS line_lineage (" +
      "snapshot_id INTEGER NOT NULL, " +
      "line_number INTEGER NOT NULL, " +
      "line_id INTEGER NOT NULL, " +
      "canon_hash TEXT NOT NULL, " +
      "anchor TEXT NOT NULL, " +
      "PRIMARY KEY (snapshot_id, line_number), " +
      "FOREIGN KEY (snapshot_id) REFERENCES file_snapshots(snapshot_id) ON DELETE CASCADE" +
      ")",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_lineage_snapshot_line_id " +
      "ON line_lineage (snapshot_id, line_id)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS served_leases (" +
      "session_id TEXT NOT NULL, " +
      "file_path TEXT NOT NULL, " +
      "anchor TEXT NOT NULL, " +
      "line_id INTEGER NOT NULL, " +
      "canon_hash TEXT NOT NULL, " +
      "served_snapshot_hash TEXT NOT NULL, " +
      "served_line_number INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL, " +
      "retired_at INTEGER, " +
      "PRIMARY KEY (session_id, file_path, anchor)" +
      ")",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_line " +
      "ON served_leases (session_id, file_path, line_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_line_num " +
      "ON served_leases (session_id, file_path, served_line_number)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_file_retired " +
      "ON served_leases (file_path, retired_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_session_anchor " +
      "ON served_leases (session_id, anchor)",
  );
}

/**
 * Pair current canon digests against the previous snapshot's lineage.
 * Returns the inherited line_id per current line, or null for fresh ids.
 * Pure: no I/O, deterministic (no iteration-order dependence — queues are
 * line-number ordered).
 */
function pairLineIds(prev: PrevLine[], curCanons: string[]): (number | null)[] {
  const assigned: (number | null)[] = curCanons.map(() => null);
  const claimed = new Set<number>();
  const prevByNumber = new Map<number, number>();
  prev.forEach((line, index) => {
    if (!prevByNumber.has(line.lineNumber)) prevByNumber.set(line.lineNumber, index);
  });
  // Rule 1: same line number and same canon.
  curCanons.forEach((canonHash, index) => {
    const prevIndex = prevByNumber.get(index + 1);
    if (
      prevIndex !== undefined &&
      !claimed.has(prevIndex) &&
      prev[prevIndex]!.canonHash === canonHash
    ) {
      assigned[index] = prev[prevIndex]!.lineId;
      claimed.add(prevIndex);
    }
  });
  // Rules 2+3: per-canon queues of still-unclaimed previous lines, ordered by
  // previous line number; take the head (exactly-one matches and ambiguous
  // matches resolve identically: lowest unclaimed previous line wins).
  const byCanon = new Map<string, number[]>();
  prev.forEach((line, index) => {
    if (claimed.has(index)) return;
    const queue = byCanon.get(line.canonHash);
    if (queue) queue.push(index);
    else byCanon.set(line.canonHash, [index]);
  });
  for (const queue of byCanon.values()) {
    queue.sort((a, b) => prev[a]!.lineNumber - prev[b]!.lineNumber);
  }
  curCanons.forEach((canonHash, index) => {
    if (assigned[index] !== null) return;
    const queue = byCanon.get(canonHash);
    if (!queue || queue.length === 0) return;
    const prevIndex = queue.shift()!;
    assigned[index] = prev[prevIndex]!.lineId;
  });
  return assigned;
}

export function createLineageStore(db: DatabaseSync): LineageStore {
  ensureLineageTables(db);
  const getSnapshotStmt = db.prepare(
    "SELECT snapshot_id FROM file_snapshots WHERE path = ? AND snapshot_hash = ?",
  );
  const latestSnapshotStmt = db.prepare(
    "SELECT snapshot_id, snapshot_hash FROM file_snapshots WHERE path = ? ORDER BY snapshot_id DESC LIMIT 1",
  );
  const prevLineageStmt = db.prepare(
    "SELECT line_number, line_id, canon_hash FROM line_lineage WHERE snapshot_id = ? ORDER BY line_number ASC",
  );
  const getCounterStmt = db.prepare("SELECT next_id FROM line_id_counters WHERE path = ?");
  const upsertCounterStmt = db.prepare(
    "INSERT INTO line_id_counters (path, next_id) VALUES (?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET next_id = excluded.next_id",
  );
  const insertSnapshotStmt = db.prepare(
    "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) " +
      "VALUES (?, ?, ?, ?, 1)",
  );
  const insertLineageStmt = db.prepare(
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) " +
      "VALUES (?, ?, ?, ?, ?)",
  );
  const snapshotLineageStmt = db.prepare(
    "SELECT line_number, line_id, canon_hash, anchor FROM line_lineage " +
      "WHERE snapshot_id = ? ORDER BY line_number ASC",
  );
  const upsertLeaseStmt = db.prepare(
    "INSERT INTO served_leases (session_id, file_path, anchor, line_id, canon_hash, " +
      "served_snapshot_hash, served_line_number, updated_at, retired_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL) " +
      "ON CONFLICT(session_id, file_path, anchor) DO UPDATE SET line_id = excluded.line_id, " +
      "canon_hash = excluded.canon_hash, served_snapshot_hash = excluded.served_snapshot_hash, " +
      "served_line_number = excluded.served_line_number, updated_at = excluded.updated_at, " +
      "retired_at = NULL",
  );
  const getLeaseStmt = db.prepare(
    "SELECT line_id, canon_hash, served_snapshot_hash, served_line_number, retired_at " +
      "FROM served_leases WHERE session_id = ? AND file_path = ? AND anchor = ?",
  );
  const updateLineageAnchorStmt = db.prepare(
    "UPDATE line_lineage SET anchor = ? WHERE snapshot_id = ? AND line_number = ?",
  );

  const retireAbsentLeasesStmt = db.prepare(
    "UPDATE served_leases SET retired_at = ? WHERE file_path = ? AND retired_at IS NULL " +
      "AND line_id NOT IN (SELECT line_id FROM line_lineage WHERE snapshot_id = ?)",
  );
  const deleteSnapshotsByPathStmt = db.prepare("DELETE FROM file_snapshots WHERE path = ?");
  const deleteLineageByPathStmt = db.prepare(
    "DELETE FROM line_lineage WHERE snapshot_id IN (SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
  );
  const deleteCountersByPathStmt = db.prepare("DELETE FROM line_id_counters WHERE path = ?");
  const deleteLeasesByPathStmt = db.prepare("DELETE FROM served_leases WHERE file_path = ?");
  function retireAbsentLeases(snapshotId: number, path: string, now: number): void {
    withBusyRetry(() => {
      retireAbsentLeasesStmt.run(now, path, snapshotId);
    });
  }

  function grantLeases(
    snapshotId: number,
    snapshotHash: string,
    path: string,
    leases: CommitLeases,
    now: number,
  ): void {
    // SAFETY: SELECT list (line_number, line_id, canon_hash, anchor) matches LineageRecord
    // field-for-field; node:sqlite returns one record per row with exactly those columns.
    const records = snapshotLineageStmt.all(snapshotId) as unknown as LineageRecord[];
    const byAnchor = new Map<string, { lineId: number; canonHash: string }>();
    for (const record of records) {
      if (!byAnchor.has(record.anchor)) {
        byAnchor.set(record.anchor, { lineId: record.line_id, canonHash: record.canon_hash });
      }
    }
    // Sequential upserts: a repeated anchor inside one batch keeps the last serve.
    for (const row of leases.rows) {
      if (row.hash === null) continue;
      const hit = byAnchor.get(row.hash);
      if (!hit) continue;
      withBusyRetry(() => {
        upsertLeaseStmt.run(
          leases.sessionKey,
          path,
          row.hash,
          hit.lineId,
          hit.canonHash,
          snapshotHash,
          row.position + 1,
          now,
        );
      });
    }
  }

  return {
    commitSnapshot(input) {
      const lines = splitLines(input.content);
      if (input.hashes.length !== lines.length) {
        throw new Error(
          `commitSnapshot(${input.path}): ${input.hashes.length} hashes for ${lines.length} lines`,
        );
      }
      const snapshotHash = snapshotHashFor(input.content);
      const curCanons = lines.map((line) => canonDigest(line));
      const now = Date.now();
      withTransaction(db, () => {
        const existing = getSnapshotStmt.get(input.path, snapshotHash) as
          | { snapshot_id: number }
          | undefined;
        let snapshotId: number;
        if (existing !== undefined) {
          // Adopt-if-exists: allocate nothing — but refresh the anchor column to the live
          // assignment (compare-then-update, diffs only). Anchor assignment is not
          // content-determined (retire/reservation-dependent), so stored anchors go
          // archaeological without this; identity (line_id, canon_hash) stays first-wins.
          snapshotId = existing.snapshot_id;
          // SAFETY: SELECT list matches LineageRecord field-for-field (same statement shape
          // as grantLeases/lineageFor).
          const stored = snapshotLineageStmt.all(snapshotId) as unknown as LineageRecord[];
          if (stored.length === 0) {
            throw new LineageCorruptError(
              `commitSnapshot(${input.path}): snapshot row has no lineage`,
            );
          }
          if (stored.length !== lines.length) {
            throw new LineageCorruptError(
              `commitSnapshot(${input.path}): stored lineage has ${stored.length} rows ` +
                `for ${lines.length} lines`,
            );
          }
          for (let index = 0; index < lines.length; index++) {
            if (stored[index]!.line_number !== index + 1) {
              throw new LineageCorruptError(
                `commitSnapshot(${input.path}): lineage row out of order at index ${index}`,
              );
            }
            if (stored[index]!.anchor !== input.hashes[index]) {
              withBusyRetry(() => {
                updateLineageAnchorStmt.run(input.hashes[index], snapshotId, index + 1);
              });
            }
          }
        } else {
          const latest = latestSnapshotStmt.get(input.path) as SnapshotRow | undefined;
          const prev: PrevLine[] =
            latest === undefined
              ? []
              : // SAFETY: SELECT list (line_number, line_id, canon_hash) matches the inline
                // record shape; node:sqlite returns one record per row with exactly those columns.
                (
                  prevLineageStmt.all(latest.snapshot_id) as unknown as {
                    line_number: number;
                    line_id: number;
                    canon_hash: string;
                  }[]
                ).map((row) => ({
                  lineNumber: row.line_number,
                  lineId: row.line_id,
                  canonHash: row.canon_hash,
                }));
          const inherited = pairLineIds(prev, curCanons);
          // ONE counter upsert for the whole fresh block.
          const counter = getCounterStmt.get(input.path) as CounterRow | undefined;
          let fresh = counter === undefined ? 1 : counter.next_id;
          const freshCount = inherited.filter((id) => id === null).length;
          withBusyRetry(() => {
            upsertCounterStmt.run(input.path, fresh + freshCount);
          });
          // SAFETY: node:sqlite run() always returns { changes, lastInsertRowid };
          // the unknown hop only satisfies the overlap check for lastInsertRowid's bigint union.
          const info = withBusyRetry(() =>
            insertSnapshotStmt.run(input.path, snapshotHash, lines.length, now),
          ) as unknown as { lastInsertRowid: number | bigint };
          snapshotId = Number(info.lastInsertRowid);
          for (let index = 0; index < lines.length; index++) {
            let lineId = inherited[index];
            if (lineId === null) {
              lineId = fresh;
              fresh += 1;
            }
            withBusyRetry(() => {
              insertLineageStmt.run(
                snapshotId,
                index + 1,
                lineId,
                curCanons[index]!,
                input.hashes[index]!,
              );
            });
          }
        }
        if (input.leases !== undefined) {
          grantLeases(snapshotId, snapshotHash, input.path, input.leases, now);
        }
        // Both paths, same transaction: leases whose line left the resolved snapshot retire;
        // revival stays the grant path's retired_at = NULL.
        retireAbsentLeases(snapshotId, input.path, now);
      });
    },

    lineageFor(path, snapshotHash) {
      const existing = getSnapshotStmt.get(path, snapshotHash) as
        | { snapshot_id: number }
        | undefined;
      if (existing === undefined) return [];
      // SAFETY: SELECT list matches LineageRecord field-for-field (same statement as grantLeases).
      return (snapshotLineageStmt.all(existing.snapshot_id) as unknown as LineageRecord[]).map(
        (row) => ({
          lineNumber: row.line_number,
          lineId: row.line_id,
          canonHash: row.canon_hash,
          anchor: row.anchor,
        }),
      );
    },

    leaseFor(sessionKey, path, anchor) {
      const row = getLeaseStmt.get(sessionKey, path, anchor) as LeaseRecord | undefined;
      if (row === undefined) return undefined;
      return {
        lineId: row.line_id,
        canonHash: row.canon_hash,
        snapshotHash: row.served_snapshot_hash,
        lineNumber: row.served_line_number,
        retiredAt: row.retired_at,
      };
    },
    deleteByPath(path) {
      // Explicit lineage delete first: the FK cascade covers FK-on openers, but
      // deleteByPath must hold for any opener (e.g. :memory: test DBs).
      withBusyRetry(() => {
        deleteLineageByPathStmt.run(path);
      });
      withBusyRetry(() => {
        deleteSnapshotsByPathStmt.run(path);
      });
      withBusyRetry(() => {
        deleteCountersByPathStmt.run(path);
      });
      withBusyRetry(() => {
        deleteLeasesByPathStmt.run(path);
      });
    },
  };
}
