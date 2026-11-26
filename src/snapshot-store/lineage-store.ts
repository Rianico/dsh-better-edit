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
 */
import { DatabaseSync } from "node:sqlite";
import { canonDigest, rawDigest, contentChecksum, HASH_RE } from "../hashline/hash-assign.js";
import { snapshotEpochPrefix } from "./epoch.js";
import { splitLines } from "../utils.js";
import { withBusyRetry } from "../store-retry.js";
import { pairLineage } from "./pairing.js";
import { withTransaction } from "./txn.js";

/**
 * The snapshot key `(path, snapshotHash)`: the current epoch's prefix plus the content checksum —
 * the same shape `snapshot-store`'s legacy `snapshots.checksum` row carries. The shape itself is
 * owned by `./epoch.js`, so the key and its two predicates can never drift apart.
 *
 * The epoch carries BOTH axes: a canon-only change misses the exact key (a plain cache miss for
 * raw anchors), while the stored canon evidence is fenced by the full epoch at every reuse seam
 * (ADR-0054).
 */
export function snapshotHashFor(content: string): string {
  return snapshotEpochPrefix() + contentChecksum(content);
}

/**
 * A snapshot row whose lineage is missing or malformed. The adopt arm *diagnoses* with this
 * (CP2): an unusable family is discarded and re-materialized fresh, observably, instead of
 * throwing — a permanent throw is what pinned a path into a lease-less state.
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
  /** `xxh32` of the raw line; `undefined` on a legacy row, where the carry fails closed. */
  rawHash?: string | undefined;
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
  /**
   * The newest committed lineage for `path`, in line order — the evidence a checksum-miss alignment
   * pairs drifted content against. `undefined` when the path has no committed snapshot, its lineage
   * is empty, or the rows are unusable (non-contiguous numbering, an anchor outside the hash
   * alphabet, or a repeated anchor): alignment then loses its evidence and the caller falls back to
   * fresh allocation, never to damaged coordinates. READ-ONLY.
   */
  latestLineageFor(path: string): LineageRow[] | undefined;
  /**
   * `line_id` -> current line number for `content` — the identity map the edit path resolves a
   * leased line through (CP2-r1). Prefers the committed lineage of `content`; otherwise pairs the
   * latest committed snapshot against `content` with the pairing engine, in memory. READ-ONLY: no
   * snapshot row, no `served_leases` write, no retirement stamp — retirement belongs to
   * materialization, never to resolution.
   */
  positionsByIdentity(path: string, content: string): Map<number, number>;
  leaseFor(sessionKey: string, path: string, anchor: string): LeaseRow | undefined;
  /**
   * Other files this session has served one anchor for, excluding `excludePath` (the file being
   * edited) — the `(session_id, anchor)` lookup behind `E_FOREIGN_ANCHOR`. Failure-path only:
   * the edit path calls it exactly when a boundary lease misses. READ-ONLY.
   */
  leaseHomes(sessionKey: string, excludePath: string, anchor: string): string[];
  /**
   * The committed `file_snapshots.snapshot_id` for `(path, snapshotHash)`, or undefined when no
   * such row exists. The vacuum trigger resolves its in-flight protection id through this, since
   * the materialization path never learns the inserted id itself.
   */
  snapshotIdFor(path: string, snapshotHash: string): number | undefined;
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
  rawHash?: string | undefined;
}

interface CounterRow {
  next_id: number;
}

interface LineageRecord {
  line_number: number;
  line_id: number;
  canon_hash: string;
  raw_hash: string | null;
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
      "raw_hash TEXT, " +
      "anchor TEXT NOT NULL, " +
      "PRIMARY KEY (snapshot_id, line_number), " +
      "FOREIGN KEY (snapshot_id) REFERENCES file_snapshots(snapshot_id) ON DELETE CASCADE" +
      ")",
  );
  const lineageColumns = db
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all("line_lineage") as { name: string }[];
  if (!lineageColumns.some((column) => column.name === "raw_hash")) {
    db.exec("ALTER TABLE line_lineage ADD COLUMN raw_hash TEXT");
  }
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
 * Adapter: the ONE pairing owner (`pairLineage` — the pin-bounded engine plus the homogeneous-run
 * carry) in the shape `commitSnapshot` needs. Returns the inherited `line_id` per current line, or
 * null for a fresh id. A current line the pairing left unpaired takes a fresh id, which is what
 * retires the identity of a line it could not prove moved — the fail-closed direction.
 *
 * WHY the same owner as the read path: a `line_id` and the anchor served for the same line must
 * never be decided by different rules, or one line keeps its anchor while its identity retires.
 */
function pairLineIds(prev: PrevLine[], curLines: string[]): (number | null)[] {
  const prevById = new Map<number, number>();
  for (const line of prev) prevById.set(line.lineNumber, line.lineId);
  const pairing = pairLineage(
    prev.map((line) => ({
      lineNumber: line.lineNumber,
      canonHash: line.canonHash,
      rawHash: line.rawHash,
    })),
    curLines.map((line, index) => ({
      lineNumber: index + 1,
      canonHash: canonDigest(line),
      rawHash: rawDigest(line),
    })),
  );
  const prevByCurr = new Map<number, number>();
  for (const [prevLine, currLine] of pairing) prevByCurr.set(currLine, prevLine);
  return curLines.map((_, index) => {
    const prevLine = prevByCurr.get(index + 1);
    if (prevLine === undefined) return null;
    return prevById.get(prevLine) ?? null;
  });
}

/**
 * Classify a stored lineage family against the content being adopted. Returns the diagnosis
 * when the family is unusable — empty, wrong row count, numbering that is not contiguous from
 * line 1, or a `canon_hash` that disagrees with the line being adopted — or undefined when it
 * can be adopted as-is.
 *
 * The canon arm cannot be version skew: the S_latest lookup below is epoch-filtered, so the row
 * this key found was minted by the current canon, and `canonDigest` is deterministic for a given
 * line. Within the adopt arm a canon mismatch can therefore only be corruption. Excluding it would
 * silently inherit the corrupt row's `line_id` into every future `pairLineIds` pairing.
 */
function diagnoseUnusableLineage(
  stored: readonly LineageRecord[],
  lineCount: number,
  path: string,
  curCanons: readonly string[],
): LineageCorruptError | undefined {
  if (stored.length === 0) {
    return new LineageCorruptError(`commitSnapshot(${path}): snapshot row has no lineage`);
  }
  if (stored.length !== lineCount) {
    return new LineageCorruptError(
      `commitSnapshot(${path}): stored lineage has ${stored.length} rows for ${lineCount} lines`,
    );
  }
  for (let index = 0; index < lineCount; index++) {
    const row = stored[index];
    if (row === undefined || row.line_number !== index + 1) {
      return new LineageCorruptError(
        `commitSnapshot(${path}): lineage row out of order at index ${index}`,
      );
    }
    const expected = curCanons[index];
    if (expected === undefined || row.canon_hash !== expected) {
      return new LineageCorruptError(
        `commitSnapshot(${path}): canon mismatch at line ${index + 1}: ` +
          `stored ${row.canon_hash} expected ${expected ?? "<missing>"}`,
      );
    }
  }
  return undefined;
}

export function createLineageStore(db: DatabaseSync): LineageStore {
  ensureLineageTables(db);
  const getSnapshotStmt = db.prepare(
    "SELECT snapshot_id FROM file_snapshots WHERE path = ? AND snapshot_hash = ?",
  );
  const latestSnapshotStmt = db.prepare(
    "SELECT snapshot_id, snapshot_hash FROM file_snapshots WHERE path = ? AND snapshot_hash LIKE ? " +
      "ORDER BY snapshot_id DESC LIMIT 1",
  );
  const currentEpochLike = `${snapshotEpochPrefix()}%`;
  const prevLineageStmt = db.prepare(
    "SELECT line_number, line_id, canon_hash, raw_hash FROM line_lineage WHERE snapshot_id = ? ORDER BY line_number ASC",
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
    "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, raw_hash, anchor) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  );
  const snapshotLineageStmt = db.prepare(
    "SELECT line_number, line_id, canon_hash, raw_hash, anchor FROM line_lineage " +
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
  const getLeaseHomesStmt = db.prepare(
    "SELECT DISTINCT file_path FROM served_leases WHERE session_id = ? AND anchor = ? AND file_path != ?",
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
  const deleteLineageBySnapshotStmt = db.prepare("DELETE FROM line_lineage WHERE snapshot_id = ?");
  const deleteSnapshotByIdStmt = db.prepare("DELETE FROM file_snapshots WHERE snapshot_id = ?");
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
    const records = snapshotLineageStmt.all(snapshotId) as unknown as LineageRecord[];
    const byAnchor = new Map<string, { lineId: number; canonHash: string }>();
    for (const record of records) {
      if (!byAnchor.has(record.anchor)) {
        byAnchor.set(record.anchor, { lineId: record.line_id, canonHash: record.canon_hash });
      }
    }
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
        let snapshotId: number | undefined;
        if (existing !== undefined) {
          // SAFETY: SELECT list matches LineageRecord field-for-field (same statement shape
          const stored = snapshotLineageStmt.all(
            existing.snapshot_id,
          ) as unknown as LineageRecord[];
          const unusable = diagnoseUnusableLineage(stored, lines.length, input.path, curCanons);
          if (unusable === undefined) {
            const adoptedId = existing.snapshot_id;
            snapshotId = adoptedId;
            for (let index = 0; index < lines.length; index++) {
              if (stored[index]!.anchor !== input.hashes[index]) {
                withBusyRetry(() => {
                  updateLineageAnchorStmt.run(input.hashes[index], adoptedId, index + 1);
                });
              }
            }
          } else {
            console.warn(
              `dsh-better-edit: repairing corrupt lineage for ${input.path} ` +
                `(snapshot ${snapshotHash}): ${unusable.message} — discarded the unusable ` +
                `family and re-materialized it fresh; leases on discarded identities retire.`,
            );
            withBusyRetry(() => {
              deleteLineageBySnapshotStmt.run(existing.snapshot_id);
            });
            withBusyRetry(() => {
              deleteSnapshotByIdStmt.run(existing.snapshot_id);
            });
          }
        }
        if (snapshotId === undefined) {
          const latest = latestSnapshotStmt.get(input.path, currentEpochLike) as
            | SnapshotRow
            | undefined;
          const prev: PrevLine[] = [];
          if (latest !== undefined) {
            // SAFETY: prevLineageStmt's SELECT list (line_number, line_id, canon_hash, raw_hash)
            const stored = prevLineageStmt.all(latest.snapshot_id) as unknown as {
              line_number: number;
              line_id: number;
              canon_hash: string;
              raw_hash: string | null;
            }[];
            for (const row of stored) {
              prev.push({
                lineNumber: row.line_number,
                lineId: row.line_id,
                canonHash: row.canon_hash,
                rawHash: row.raw_hash ?? undefined,
              });
            }
          }
          const inherited = pairLineIds(prev, lines);
          const counter = getCounterStmt.get(input.path) as CounterRow | undefined;
          let fresh = counter === undefined ? 1 : counter.next_id;
          const freshCount = inherited.filter((id) => id === null).length;
          withBusyRetry(() => {
            upsertCounterStmt.run(input.path, fresh + freshCount);
          });
          const info = withBusyRetry(() =>
            insertSnapshotStmt.run(input.path, snapshotHash, lines.length, now),
          );
          const insertedId = Number(info.lastInsertRowid);
          snapshotId = insertedId;
          for (let index = 0; index < lines.length; index++) {
            let lineId = inherited[index];
            if (lineId === null) {
              lineId = fresh;
              fresh += 1;
            }
            withBusyRetry(() => {
              insertLineageStmt.run(
                insertedId,
                index + 1,
                lineId,
                curCanons[index]!,
                rawDigest(lines[index] ?? ""),
                input.hashes[index]!,
              );
            });
          }
        }
        if (input.leases !== undefined) {
          grantLeases(snapshotId, snapshotHash, input.path, input.leases, now);
        }
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
          rawHash: row.raw_hash ?? undefined,
          anchor: row.anchor,
        }),
      );
    },
    latestLineageFor(path) {
      const latest = latestSnapshotStmt.get(path, currentEpochLike) as SnapshotRow | undefined;
      if (latest === undefined) return undefined;
      // SAFETY: SELECT list matches LineageRecord field-for-field (same statement as grantLeases).
      const records = snapshotLineageStmt.all(latest.snapshot_id) as unknown as LineageRecord[];
      if (records.length === 0) return undefined;
      const rows: LineageRow[] = [];
      const anchors = new Set<string>();
      for (let index = 0; index < records.length; index++) {
        const row = records[index]!;
        if (row.line_number !== index + 1) return undefined;
        if (!HASH_RE.test(row.anchor) || anchors.has(row.anchor)) return undefined;
        anchors.add(row.anchor);
        rows.push({
          lineNumber: row.line_number,
          lineId: row.line_id,
          canonHash: row.canon_hash,
          rawHash: row.raw_hash ?? undefined,
          anchor: row.anchor,
        });
      }
      return rows;
    },

    positionsByIdentity(path, content) {
      const current = getSnapshotStmt.get(path, snapshotHashFor(content)) as
        | { snapshot_id: number }
        | undefined;
      if (current !== undefined) {
        const map = new Map<number, number>();
        // SAFETY: SELECT list matches LineageRecord field-for-field (same statement as grantLeases).
        const records = snapshotLineageStmt.all(current.snapshot_id) as unknown as LineageRecord[];
        for (const row of records) {
          map.set(row.line_id, row.line_number);
        }
        return map;
      }
      const latest = latestSnapshotStmt.get(path, currentEpochLike) as SnapshotRow | undefined;
      if (latest === undefined) return new Map();
      // SAFETY: prevLineageStmt's SELECT list (line_number, line_id, canon_hash, raw_hash) matches
      const previous = (
        prevLineageStmt.all(latest.snapshot_id) as unknown as {
          line_number: number;
          line_id: number;
          canon_hash: string;
          raw_hash: string | null;
        }[]
      ).map((row) => ({
        lineNumber: row.line_number,
        lineId: row.line_id,
        canonHash: row.canon_hash,
        rawHash: row.raw_hash ?? undefined,
      }));
      if (previous.length === 0) return new Map();
      const currentLines = splitLines(content);
      const inherited = pairLineIds(previous, currentLines);
      const map = new Map<number, number>();
      for (let index = 0; index < currentLines.length; index++) {
        const lineId = inherited[index];
        if (lineId !== null) map.set(lineId, index + 1);
      }
      return map;
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
    leaseHomes(sessionKey, excludePath, anchor) {
      const rows = getLeaseHomesStmt.all(sessionKey, anchor, excludePath) as {
        file_path: string;
      }[];
      return rows.map((row) => row.file_path);
    },
    snapshotIdFor(path, snapshotHash) {
      return (getSnapshotStmt.get(path, snapshotHash) as { snapshot_id: number } | undefined)
        ?.snapshot_id;
    },
    deleteByPath(path) {
      withTransaction(db, () => {
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
      });
    },
  };
}
