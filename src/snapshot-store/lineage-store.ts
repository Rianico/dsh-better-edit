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
 * Pairing rule (deterministic): a new snapshot's lines inherit `line_id`s from the path's
 * latest committed snapshot via the scaled recursive patience engine in `./pairing.js` —
 * locally unique canons pin, the minimal-displacement LIS backbone pairs, pinless rigid
 * runs zip positionally, and a bounded leaf interval pairs only on a UNIQUE optimal LCS
 * embedding. Anything the engine cannot prove moved — a duplicate canon, a contested
 * reorder, an over-budget interval — pairs nothing and takes a fresh id. That is
 * fail-closed on purpose: a guessed inheritance would rebind a lease onto a look-alike
 * line. No previous snapshot for the path → every line fresh.
 *
 * @module dsh-better-edit/snapshot-store/lineage-store
 */
import { DatabaseSync } from "node:sqlite";
import { CANON_VERSION, canonDigest, contentChecksum } from "../hashline/hash-assign.js";
import { splitLines } from "../utils.js";
import { withBusyRetry } from "../store-retry.js";
import { pairSnapshots } from "./pairing.js";
import { withTransaction } from "./txn.js";

export function snapshotHashFor(content: string): string {
  return `${CANON_VERSION}:${contentChecksum(content)}`;
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
 * Adapter: the patience/LIS engine (`./pairing.js`) in the shape `commitSnapshot` needs.
 * Returns the inherited `line_id` per current line, or null for a fresh id. A current line
 * the engine left unpaired takes a fresh id, which is what retires the identity of a line
 * it could not prove moved — the fail-closed direction.
 */
function pairLineIds(prev: PrevLine[], curCanons: string[]): (number | null)[] {
  const prevById = new Map<number, number>();
  for (const line of prev) prevById.set(line.lineNumber, line.lineId);
  const pairing = pairSnapshots(
    prev.map((line) => ({ lineNumber: line.lineNumber, canonHash: line.canonHash })),
    curCanons.map((canonHash, index) => ({ lineNumber: index + 1, canonHash })),
  );
  const prevByCurr = new Map<number, number>();
  for (const [prevLine, currLine] of pairing) prevByCurr.set(currLine, prevLine);
  return curCanons.map((_, index) => {
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
 * The canon arm cannot be version skew: `snapshotHashFor` embeds `CANON_VERSION` in the key that
 * found this row, and `canonDigest` is deterministic for a given line, so within the adopt arm a
 * mismatch can only be corruption. Excluding it would silently inherit the corrupt row's
 * `line_id` into every future `pairLineIds` pairing.
 *
 * Unusable is no longer thrown: the adopt arm repairs it (see the `unusable` branch below).
 * The diagnosis is still built so the repair warning carries the precise arm, and so a future
 * caller that must refuse has one place to ask.
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
  // Repair-at-detection (CP2): a targeted discard of ONE unusable snapshot, never its siblings.
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
        let snapshotId: number | undefined;
        if (existing !== undefined) {
          // SAFETY: SELECT list matches LineageRecord field-for-field (same statement shape
          // as grantLeases/lineageFor).
          const stored = snapshotLineageStmt.all(
            existing.snapshot_id,
          ) as unknown as LineageRecord[];
          const unusable = diagnoseUnusableLineage(stored, lines.length, input.path, curCanons);
          if (unusable === undefined) {
            // Adopt-if-exists: allocate nothing — but refresh the anchor column to the live
            // assignment (compare-then-update, diffs only). Anchor assignment is not
            // content-determined (retire/reservation-dependent), so stored anchors go
            // archaeological without this; identity (line_id, canon_hash) stays first-wins.
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
            // Repair-at-detection (CP2): the (path, snapshot_hash) row exists but its lineage
            // is unusable, so the stored identity is unrecoverable by definition. Discard THIS
            // snapshot's lineage family and re-materialize it fresh below, inside the caller's
            // unit so a failure rolls the repair back with everything else. Siblings are
            // untouched and `line_id_counters` is not reset — fresh ids stay globally unique —
            // and the leases bound to the discarded identities retire at the end of this unit
            // (fail closed). Observable by construction: never a silent repair.
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
          const latest = latestSnapshotStmt.get(input.path) as SnapshotRow | undefined;
          const prev: PrevLine[] = [];
          if (latest !== undefined) {
            // SAFETY: prevLineageStmt's SELECT list (line_number, line_id, canon_hash) matches
            // this inline shape field-for-field; node:sqlite returns one record per row with
            // exactly those columns.
            const stored = prevLineageStmt.all(latest.snapshot_id) as unknown as {
              line_number: number;
              line_id: number;
              canon_hash: string;
            }[];
            for (const row of stored) {
              prev.push({
                lineNumber: row.line_number,
                lineId: row.line_id,
                canonHash: row.canon_hash,
              });
            }
          }
          const inherited = pairLineIds(prev, curCanons);
          // ONE counter upsert for the whole fresh block.
          const counter = getCounterStmt.get(input.path) as CounterRow | undefined;
          let fresh = counter === undefined ? 1 : counter.next_id;
          const freshCount = inherited.filter((id) => id === null).length;
          withBusyRetry(() => {
            upsertCounterStmt.run(input.path, fresh + freshCount);
          });
          // node:sqlite run() returns StatementResultingChanges, which declares
          // lastInsertRowid — no cast is needed to read it.
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
      const latest = latestSnapshotStmt.get(path) as SnapshotRow | undefined;
      if (latest === undefined) return new Map();
      // SAFETY: prevLineageStmt's SELECT list (line_number, line_id, canon_hash) matches this
      // inline shape field-for-field; node:sqlite returns one record per row with those columns.
      const previous = (
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
      if (previous.length === 0) return new Map();
      const inherited = pairLineIds(
        previous,
        splitLines(content).map((line) => canonDigest(line)),
      );
      const map = new Map<number, number>();
      for (let index = 0; index < inherited.length; index++) {
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
      // One unit: these four statements are one logical mutation, so an interrupted delete
      // must never leave a `file_snapshots` row whose lineage family is already gone (the
      // empty arm this module's adopt path repairs). Nested inside `pruneMissing`'s
      // `withStore` unit this joins the outer transaction instead of raising
      // "cannot start a transaction within a transaction".
      withTransaction(db, () => {
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
      });
    },
  };
}
