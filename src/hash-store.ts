/**
 * The hash store — ONE deep persistence module for the hashline domain.
 *
 * Owns the sqlite db, the schema and migrations, corruption quarantine,
 * Owns the sqlite db, the schema and migrations, corruption quarantine, WAL,
 * the legacy-JSON migration, and the undo/served row APIs. Hash snapshots
 * live in snapshot-store (shared busy-retry policy in store-retry), adapted
 * here so the HashStore surface stays stable for its duck-typed callers.
 * use domain methods, never SQL.
 *
 * Corrupt-row handling (parse the JSON column → validate against the hash
 * alphabet → delete the corrupt row) lives here, once, for every row family.
 * Cross-table cleanup (pruneMissing) lives here too — a sibling module never
 * reaches into another family's rows.
 * @module dsh-better-edit/hash-store
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { readdir, rename, rm, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath } from "./store-tenancy.js";
import { onStoreOpen, setStoresGetter } from "./store-lifecycle.js";
import { workspaceCwd } from "./workspace-context.js";
import { errCode } from "./utils.js";
import { initHasher, HASH_RE } from "./hashline/hash-assign.js";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT, SERVED_TTL_MS } from "./constants.js";
import { DomainError } from "./domain-errors.js";
import {
  createSnapshotStore,
  isValidHashList,
  type SnapshotStore,
} from "./snapshot-store/index.js";
import { withBusyRetry } from "./store-retry.js";
import { migrateLegacyStore } from "./snapshot-store/migrate.js";

// ---- validators (owned here; the store's corruption handling uses them) ----

/** A served-row array: per-position hash, or null for never-served slots. */
export function isValidCanonsList(value: unknown): value is (string | null)[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (entry === null) continue;
    if (typeof entry !== "string") return false;
  }
  return true;
}

export function isValidServedList(value: unknown): value is (string | null)[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (entry === null) continue;
    if (typeof entry !== "string" || !HASH_RE.test(entry)) return false;
  }
  return true;
}

/** The undo row contract shared by undo-edit and the store. */
export interface UndoRecord {
  content: string;
  bom: string;
  ending: string;
  hashes: string[];
  resultContent: string;
}

// ---- the domain interface --------------------------------------------------

type SqlParams = (string | number)[];

interface Prepared {
  allPaths: (...params: SqlParams) => Record<string, unknown>[];
  undoUpsert: (...params: SqlParams) => void;
  undoGet: (...params: SqlParams) => Record<string, unknown> | undefined;
  undoDelete: (...params: SqlParams) => void;
  undoPruneOlderThan: (...params: SqlParams) => void;
  servedGet: (...params: SqlParams) => Record<string, unknown> | undefined;
  servedAllForPath: (...params: SqlParams) => Record<string, unknown>[];
  servedUpsert: (...params: SqlParams) => void;
  servedReportedUpsert: (...params: SqlParams) => void;
  servedReportedClear: (...params: SqlParams) => void;
  servedRetiredUpsert: (...params: SqlParams) => void;
  servedRetiredClear: (...params: SqlParams) => void;
  servedCanonsUpsert: (...params: SqlParams) => void;
  servedCanonsClear: (...params: SqlParams) => void;
  servedSnapshotUpsert: (...params: SqlParams) => void;
  servedSnapshotClear: (...params: SqlParams) => void;
  servedCardsUpsert: (...params: SqlParams) => void;
  servedCardsClear: (...params: SqlParams) => void;
  servedDelete: (...params: SqlParams) => void;
  servedDeletePath: (...params: SqlParams) => void;
  servedWipe: (...params: SqlParams) => void;
  servedPruneOlderThan: (...params: SqlParams) => void;
}

/**
 * The domain face of the hash store. Each row family gets a narrow API;
 * corruption healing (parse → validate → delete) happens inside the getters.
 */
export interface HashStore {
  readonly engine: "node:sqlite";

  // ---- hash snapshots (stable anchors keyed by path+checksum+line count) ----
  /** The stored hashes for a path+content, or undefined on a miss; a corrupt row is deleted (when deleteCorrupt) and treated as a miss. */
  getSnapshot(path: string, content: string, deleteCorrupt?: boolean): string[] | undefined;
  upsertSnapshot(path: string, checksum: string, lineCount: number, hashes: string[]): void;
  /** Every path referenced by any row family (snapshots ∪ undo ∪ served). */
  allKnownPaths(): { path: string }[];
  /** Every snapshot's path and raw hashes JSON (for path-by-hash scans). */
  allSnapshotHashes(): { path: string; hashes: string }[];
  deleteSnapshot(path: string): void;
  /** Paths whose stored snapshot hashes contain every given anchor. */
  findSnapshotPaths(hashes: string[]): string[];

  // ---- undo entries (one per path) ----------------------------------------
  /** The undo row for a path, healing a corrupt row (parse → validate → delete). */
  getUndo(path: string): UndoRecord | undefined;
  upsertUndo(path: string, entry: UndoRecord): void;
  deleteUndo(path: string): void;
  pruneUndoOlderThan(ts: number): void;

  // ---- maintenance ---------------------------------------------------------
  /** Delete every row family's entries for paths that no longer exist on disk. */
  pruneMissing(): Promise<void>;
}

/**
 * Served persistence — internal, owned by SessionView. Not part of the public HashStore API.
 * SessionView is the sole owner of the served merge invariant; HashStore is the persistence adapter.
 */
export interface ServedPersistence {
  getServed(sessionKey: string, path: string): (string | null)[];
  getServedReported(sessionKey: string, path: string): Set<string>;
  getAnchorReservations(sessionKey: string, path: string): AnchorReservations;
  getRetiredAnchors(sessionKey: string, path: string): Set<string>;
  getRetiredEntries(sessionKey: string, path: string): RetiredEntry[];
  getServedCanons(sessionKey: string, path: string): (string | null)[];
  getEpochSnapshotId(sessionKey: string, path: string): string | undefined;
  getCards(sessionKey: string, path: string): Set<number>;
  upsertCards(sessionKey: string, path: string, cardsJson: string): void;
  clearCards(sessionKey: string, path: string): void;
  upsertServed(sessionKey: string, path: string, hashesJson: string): void;
  upsertServedReported(sessionKey: string, path: string, reportedJson: string): void;
  clearServedReported(sessionKey: string, path: string): void;
  upsertRetiredAnchors(sessionKey: string, path: string, hashesJson: string): void;
  clearRetiredAnchors(sessionKey: string, path: string): void;
  upsertServedCanons(sessionKey: string, path: string, canonsJson: string): void;
  clearServedCanons(sessionKey: string, path: string): void;
  upsertEpochSnapshotId(sessionKey: string, path: string, snapshotId: string): void;
  clearEpochSnapshotId(sessionKey: string, path: string): void;
  deleteServed(sessionKey: string, path: string): void;
  deleteServedByPath(path: string): void;
  wipeServed(sessionKey: string): void;
  pruneServedOlderThan(ts: number): void;
}

export interface AnchorReservations {
  reservedHashes: Set<string>;
  retiredHashes: Set<string>;
}

export type DeathPos = number | null;

export interface RetiredEntry {
  hash: string;
  deathPos: DeathPos;
}

export function isValidRetiredEntry(value: unknown): value is RetiredEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.hash === "string" &&
    (v.deathPos === null || typeof v.deathPos === "number") &&
    HASH_RE.test(v.hash)
  );
}

export function isValidRetiredEntries(value: unknown): value is RetiredEntry[] {
  if (!Array.isArray(value)) return false;
  for (const e of value) if (!isValidRetiredEntry(e)) return false;
  return true;
}

function coerceRetiredEntry(e: unknown): RetiredEntry | null {
  if (typeof e === "string" && HASH_RE.test(e)) return { hash: e, deathPos: null };
  if (typeof e !== "object" || e === null || !("hash" in (e as Record<string, unknown>)))
    return null;
  const ee = e as Record<string, unknown>;
  if (typeof ee.hash !== "string" || !HASH_RE.test(ee.hash)) return null;
  const rawPos = ee.deathPos;
  const deathPos: DeathPos =
    typeof rawPos === "number" && rawPos !== -1 ? (rawPos as number) : null;
  return { hash: ee.hash, deathPos };
}

function parseRetiredJson(raw: string | null | undefined): RetiredEntry[] {
  if (raw === null || raw === undefined || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return [];
    if (isValidRetiredEntries(parsed)) {
      return (parsed as RetiredEntry[]).map((e) =>
        e.deathPos === -1 ? { hash: e.hash, deathPos: null } : e,
      );
    }
    const out: RetiredEntry[] = [];
    for (const e of parsed as unknown[]) {
      const coerced = coerceRetiredEntry(e);
      if (coerced) out.push(coerced);
    }
    if (out.length > 0) return out;
    if (isValidHashList(parsed))
      return (parsed as string[]).map((h) => ({ hash: h, deathPos: null }));
    return [];
  } catch {
    return [];
  }
}

export type InternalHashStore = HashStore & ServedPersistence;

/** Load the store as served persistence — internal, for SessionView only. */
// SAFETY: loadHashStore returns InternalHashStore (HashStore & ServedPersistence) — cast narrows to served view, validated via ServedPersistence interface; safe because InternalHashStore extends both.
export function loadServedStore(cwd?: string): Promise<ServedPersistence> {
  return loadHashStore(cwd) as unknown as Promise<ServedPersistence>;
}

// ---- db plumbing (private) --------------------------------------------------

export function isCorruptionError(error: unknown): boolean {
  if (error instanceof DomainError) return false;
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") {
      return errcode === 11 || errcode === 24 || errcode === 26;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /NOTADB|CORRUPT/.test(code)) return true;
  }
  return (
    error instanceof Error &&
    /corrupt|not a database|malformed|database disk image/i.test(error.message)
  );
}

function openDbWithBusyRetry(storePath: string): {
  db: DatabaseSync;
  stmts: Prepared;
} {
  return withBusyRetry(() => openDb(storePath));
}

/** One open store per store path (per workspace); parallel sessions share per-workspace dbs. */
const stores = new Map<
  string,
  { path: string; db: DatabaseSync; stmts: Prepared; store: InternalHashStore }
>();
const openings = new Map<string, Promise<HashStore>>();
setStoresGetter(
  () => stores as Map<string, { path: string }>,
  () => openings as Map<string, Promise<any>>,
);

function openDb(storePath: string): { db: DatabaseSync; stmts: Prepared } {
  const db = new DatabaseSync(storePath, {
    timeout: HASH_STORE_BUSY_TIMEOUT,
  });
  try {
    return buildStore(db, storePath);
  } catch (error) {
    try {
      db.close();
    } catch (error) {
      console.warn(error); // best-effort close when the store build fails
    }
    throw error;
  }
}

/**
 * Read-only probe of the store's schema stamp. Safe on a store whose schema
 * we do not own: two SELECTs, no DDL, no PRAGMA, no run(). Returns undefined
 * when the meta table or the version row is absent, or when the value does
 * not parse as a base-10 integer. Probe errors propagate — a malformed meta
 * is genuine corruption and must keep flowing to the corruption path.
 */
function storedVersion(db: DatabaseSync): number | undefined {
  const metaRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get() as { name?: string } | undefined;
  if (metaRow === undefined) return undefined;
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
    | { value?: string }
    | undefined;
  if (versionRow?.value === undefined) return undefined;
  const parsed = Number.parseInt(versionRow.value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Idempotent column backfill: ALTER TABLE only when the column is missing.
 * Table/column/type ride an identifier allowlist (SQLite has no bind
 * parameters for DDL identifiers); every current caller passes constants.
 */
const SCHEMA_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  for (const identifier of [table, column, type]) {
    if (!SCHEMA_IDENTIFIER_RE.test(identifier)) {
      throw new Error(`Refused schema backfill for non-identifier: ${identifier}`);
    }
  }
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * v7 state tables. All additive (IF NOT EXISTS), owned by this build: a v6
 * process never names them, so a version flap cannot cost v7 anything.
 */
function ensureV7Tables(db: DatabaseSync): void {
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
    "CREATE TABLE IF NOT EXISTS file_undo (" +
      "path TEXT PRIMARY KEY, " +
      "content TEXT NOT NULL, " +
      "bom TEXT NOT NULL, " +
      "ending TEXT NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "result_content TEXT NOT NULL, " +
      "snapshot_hash TEXT, " +
      "updated_at INTEGER NOT NULL" +
      ")",
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
  db.exec(
    "CREATE TABLE IF NOT EXISTS served_session_meta (" +
      "session_id TEXT NOT NULL, " +
      "file_path TEXT NOT NULL, " +
      "reported TEXT, " +
      "updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY (session_id, file_path)" +
      ")",
  );
}

/**
 * Non-destructive, idempotent schema build. Runs on every open: CREATE TABLE
 * IF NOT EXISTS for the current shapes, backfill of the newer served columns,
 * and DROP TABLE served only for the pre-session-keyed shell (no session_id —
 * unusable by either version). No DELETE FROM anywhere on this path.
 */
function ensureSchema(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (" + "key TEXT PRIMARY KEY, " + "value TEXT NOT NULL" + ")",
  );
  ensureV7Tables(db);
  // WHY the v6 shells stay whole: an un-restarted v6 session — or a v6
  // process in a concurrent worktree — prepares statements against these
  // exact tables, so they are created complete on every open and never
  // dropped or reshaped here. v7 state stays isolated in the v7 tables
  // above. `cards` is kept because the released v6 build names it at store
  // open; porting upstream's column list would break it.
  db.exec(
    "CREATE TABLE IF NOT EXISTS snapshots (" +
      "path TEXT PRIMARY KEY, " +
      "checksum TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
      ")",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS undo (" +
      "path TEXT PRIMARY KEY, " +
      "content TEXT NOT NULL, " +
      "bom TEXT NOT NULL, " +
      "ending TEXT NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "result_content TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
      ")",
  );
  const servedColumns = db.prepare("PRAGMA table_info(served)").all() as {
    name: string;
  }[];
  if (!servedColumns.some((column) => column.name === "session_id")) {
    db.exec("DROP TABLE IF EXISTS served");
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS served (" +
      "session_id TEXT NOT NULL, " +
      "path TEXT NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "reported TEXT, " +
      "retired TEXT, " +
      "canons TEXT, " +
      "snapshotId TEXT, " +
      "cards TEXT, " +
      "updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY (session_id, path)" +
      ")",
  );
  addColumnIfMissing(db, "served", "canons", "TEXT");
  addColumnIfMissing(db, "served", "snapshotId", "TEXT");
  addColumnIfMissing(db, "served", "cards", "TEXT");
}

/**
 * Fail-closed refusal shared by the pre-write fast path and the
 * in-transaction re-check: a stamp newer than this build is never touched.
 */
function assertNotNewer(stored: number | undefined, storePath: string): void {
  if (stored !== undefined && stored > HASH_STORE_VERSION) {
    throw new DomainError("E_STORE_NEWER_VERSION", {
      path: storePath,
      storedVersion: stored,
      supportedVersion: HASH_STORE_VERSION,
    });
  }
}

/**
 * The single atomic forward migration. Called only when the stamp differs
 * from HASH_STORE_VERSION (including an absent or non-integer stamp on a
 * pre-versioning store). The sole writer of meta.version. CP1 has no data
 * steps — later tickets add ordered, guarded data statements beside the stamp
 * write inside the same transaction. The stamp is re-checked under the
 * RESERVED lock: a newer writer that committed between the probe and
 * BEGIN IMMEDIATE is refused here, so the stamp write can never silently
 * downgrade a newer store.
 */
function migrateForward(db: DatabaseSync, storePath: string): void {
  let migrationOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    migrationOpen = true;
    assertNotNewer(storedVersion(db), storePath);
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('version', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(HASH_STORE_VERSION));
    db.exec("COMMIT");
    migrationOpen = false;
  } catch (error) {
    if (migrationOpen) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        console.warn(rollbackError);
      }
    }
    throw error;
  }
}

function buildStore(db: DatabaseSync, storePath: string): { db: DatabaseSync; stmts: Prepared } {
  const stored = storedVersion(db);
  assertNotNewer(stored, storePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // Explicit intent: node:sqlite already enables FK constraints by default.
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  if (stored !== HASH_STORE_VERSION) migrateForward(db, storePath);
  const currentServedColumns = db.prepare("PRAGMA table_info(served)").all() as {
    name: string;
  }[];
  if (!currentServedColumns.some((column) => column.name === "retired")) {
    let migrationOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      migrationOpen = true;
      const migrationColumns = db.prepare("PRAGMA table_info(served)").all() as { name: string }[];
      if (!migrationColumns.some((column) => column.name === "retired")) {
        db.exec("ALTER TABLE served ADD COLUMN retired TEXT");
        // Pre-fix snapshots and undo entries may already bind a remembered
        // anchor to the wrong position. Preserve served rows, but rebuild
        // every source that could restore the rebound anchor.
        db.exec("DELETE FROM snapshots");
        db.exec("DELETE FROM undo");
      }
      db.exec("COMMIT");
      migrationOpen = false;
    } catch (error) {
      if (migrationOpen) {
        try {
          db.exec("ROLLBACK");
        } catch (rollbackError) {
          console.warn(rollbackError);
        }
      }
      throw error;
    }
  }
  const allStmt = db.prepare(
    "SELECT path FROM snapshots UNION SELECT path FROM undo UNION SELECT path FROM served",
  );
  const undoUpsertStmt = db.prepare(
    "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, hashes = excluded.hashes, result_content = excluded.result_content, updated_at = excluded.updated_at",
  );
  const undoGetStmt = db.prepare(
    "SELECT content, bom, ending, hashes, result_content FROM undo WHERE path = ?",
  );
  const undoDelStmt = db.prepare("DELETE FROM undo WHERE path = ?");
  const undoPruneOlderThanStmt = db.prepare("DELETE FROM undo WHERE updated_at < ?");
  const servedGetStmt = db.prepare(
    "SELECT hashes, reported, retired, canons, snapshotId, cards FROM served WHERE session_id = ? AND path = ?",
  );
  const servedAllForPathStmt = db.prepare(
    "SELECT session_id, hashes, retired FROM served WHERE path = ?",
  );
  const servedUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET hashes = excluded.hashes, updated_at = excluded.updated_at",
  );
  const servedReportedUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, reported, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET reported = excluded.reported, updated_at = excluded.updated_at",
  );
  const servedReportedClearStmt = db.prepare(
    "UPDATE served SET reported = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
  );
  const servedRetiredUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, retired, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET retired = excluded.retired, updated_at = excluded.updated_at",
  );
  const servedRetiredClearStmt = db.prepare(
    "UPDATE served SET retired = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
  );
  const servedCanonsUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, canons, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET canons = excluded.canons, updated_at = excluded.updated_at",
  );
  const servedCanonsClearStmt = db.prepare(
    "UPDATE served SET canons = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
  );
  const servedSnapshotUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, snapshotId, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET snapshotId = excluded.snapshotId, updated_at = excluded.updated_at",
  );
  const servedSnapshotClearStmt = db.prepare(
    "UPDATE served SET snapshotId = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
  );
  const servedCardsUpsertStmt = db.prepare(
    "INSERT INTO served (session_id, path, hashes, cards, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, path) DO UPDATE SET cards = excluded.cards, updated_at = excluded.updated_at",
  );
  const servedCardsClearStmt = db.prepare(
    "UPDATE served SET cards = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
  );
  const servedDeleteStmt = db.prepare("DELETE FROM served WHERE session_id = ? AND path = ?");
  const servedDeletePathStmt = db.prepare("DELETE FROM served WHERE path = ?");
  const servedWipeStmt = db.prepare("DELETE FROM served WHERE session_id = ?");
  const servedPruneOlderThanStmt = db.prepare("DELETE FROM served WHERE updated_at < ?");
  const stmts: Prepared = {
    allPaths: (...params) => allStmt.all(...params) as Record<string, unknown>[],
    undoUpsert: (...params) => {
      withBusyRetry(() => {
        undoUpsertStmt.run(...params);
      });
    },
    undoGet: (...params) => undoGetStmt.get(...params) as Record<string, unknown> | undefined,
    undoDelete: (...params) => {
      withBusyRetry(() => {
        undoDelStmt.run(...params);
      });
    },
    undoPruneOlderThan: (...params) => {
      withBusyRetry(() => {
        undoPruneOlderThanStmt.run(...params);
      });
    },
    servedGet: (...params) => servedGetStmt.get(...params) as Record<string, unknown> | undefined,
    servedAllForPath: (...params) =>
      servedAllForPathStmt.all(...params) as Record<string, unknown>[],
    servedUpsert: (...params) => {
      withBusyRetry(() => {
        servedUpsertStmt.run(...params);
      });
    },
    servedReportedUpsert: (...params) => {
      withBusyRetry(() => {
        servedReportedUpsertStmt.run(...params);
      });
    },
    servedReportedClear: (...params) => {
      withBusyRetry(() => {
        servedReportedClearStmt.run(params[1], params[0], params[2]);
      });
    },
    servedRetiredUpsert: (...params) => {
      withBusyRetry(() => {
        servedRetiredUpsertStmt.run(...params);
      });
    },
    servedRetiredClear: (...params) => {
      withBusyRetry(() => {
        servedRetiredClearStmt.run(params[1], params[0], params[2]);
      });
    },
    servedCanonsUpsert: (...params) => {
      withBusyRetry(() => {
        servedCanonsUpsertStmt.run(...params);
      });
    },
    servedCanonsClear: (...params) => {
      withBusyRetry(() => {
        servedCanonsClearStmt.run(params[1], params[0], params[2]);
      });
    },
    servedSnapshotUpsert: (...params) => {
      withBusyRetry(() => {
        servedSnapshotUpsertStmt.run(...params);
      });
    },
    servedSnapshotClear: (...params) => {
      withBusyRetry(() => {
        servedSnapshotClearStmt.run(params[1], params[0], params[2]);
      });
    },
    servedCardsUpsert: (...params) => {
      withBusyRetry(() => {
        servedCardsUpsertStmt.run(...params);
      });
    },
    servedCardsClear: (...params) => {
      withBusyRetry(() => {
        servedCardsClearStmt.run(params[1], params[0], params[2]);
      });
    },
    servedDelete: (...params) => {
      withBusyRetry(() => {
        servedDeleteStmt.run(...params);
      });
    },
    servedDeletePath: (...params) => {
      withBusyRetry(() => {
        servedDeletePathStmt.run(...params);
      });
    },
    servedWipe: (...params) => {
      withBusyRetry(() => {
        servedWipeStmt.run(...params);
      });
    },
    servedPruneOlderThan: (...params) => {
      withBusyRetry(() => {
        servedPruneOlderThanStmt.run(...params);
      });
    },
  };
  return { db, stmts };
}

/** Wire the domain methods over the prepared statements. */
function makeDomainStore(stmts: Prepared, snapshotStore: SnapshotStore): InternalHashStore {
  return {
    engine: "node:sqlite",

    getSnapshot(path, content, deleteCorrupt = true) {
      return snapshotStore.get(path, content, deleteCorrupt);
    },
    upsertSnapshot(path, checksum, lineCount, hashes) {
      snapshotStore.upsert(path, checksum, lineCount, hashes);
    },
    allKnownPaths() {
      return stmts.allPaths() as { path: string }[];
    },
    allSnapshotHashes() {
      return snapshotStore.allHashes();
    },
    deleteSnapshot(path) {
      snapshotStore.deleteByPath(path);
    },
    findSnapshotPaths(hashes) {
      return snapshotStore.findPathsContaining(hashes);
    },

    getUndo(path) {
      const row = stmts.undoGet(path);
      if (!row) return undefined;
      try {
        const parsed = JSON.parse(row.hashes as string);
        if (!isValidHashList(parsed)) {
          stmts.undoDelete(path);
          return undefined;
        }
        return {
          content: row.content as string,
          bom: row.bom as string,
          ending: row.ending as string,
          hashes: parsed as string[],
          resultContent: row.result_content as string,
        };
      } catch (error) {
        stmts.undoDelete(path);
        return undefined;
      }
    },
    upsertUndo(path, entry) {
      stmts.undoUpsert(
        path,
        entry.content,
        entry.bom,
        entry.ending,
        JSON.stringify(entry.hashes),
        entry.resultContent,
        Date.now(),
      );
    },
    deleteUndo(path) {
      stmts.undoDelete(path);
    },

    getServed(sessionKey, path) {
      const row = stmts.servedGet(sessionKey, path);
      if (!row) return [];
      try {
        const parsed = JSON.parse(row.hashes as string);
        if (isValidServedList(parsed)) return parsed;
        stmts.servedDelete(sessionKey, path);
        return [];
      } catch (error) {
        stmts.servedDelete(sessionKey, path);
        return [];
      }
    },
    getServedReported(sessionKey, path) {
      const row = stmts.servedGet(sessionKey, path);
      if (!row) return new Set();
      const raw = row.reported;
      if (typeof raw !== "string" || raw.length === 0) return new Set();
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((h): h is string => typeof h === "string" && HASH_RE.test(h)));
      } catch (error) {
        return new Set();
      }
    },
    getAnchorReservations(sessionKey, path) {
      const reservedHashes = new Set<string>();
      const retiredHashes = new Set<string>();
      const row = stmts.servedGet(sessionKey, path);
      if (!row) return { reservedHashes, retiredHashes };
      try {
        const served = JSON.parse(row.hashes as string) as unknown;
        if (!isValidServedList(served)) {
          throw new TypeError("invalid stored anchor reservations");
        }
        for (const hash of served) {
          if (hash !== null) reservedHashes.add(hash);
        }
        const retiredEntries = parseRetiredJson(row.retired as string | null);
        for (const e of retiredEntries) {
          reservedHashes.add(e.hash);
          retiredHashes.add(e.hash);
        }
      } catch (error) {
        stmts.servedDelete(sessionKey, path);
      }
      return { reservedHashes, retiredHashes };
    },
    getRetiredAnchors(sessionKey, path) {
      const row = stmts.servedGet(sessionKey, path);
      if (!row || row.retired === null || row.retired === undefined) {
        return new Set();
      }
      try {
        const entries = parseRetiredJson(row.retired as string);
        return new Set(entries.map((e) => e.hash));
      } catch (error) {
        stmts.servedDelete(sessionKey, path);
        return new Set();
      }
    },
    getRetiredEntries(sessionKey, path): RetiredEntry[] {
      const row = stmts.servedGet(sessionKey, path);
      if (!row || row.retired === null || row.retired === undefined) return [];
      try {
        return parseRetiredJson(row.retired as string);
      } catch {
        stmts.servedDelete(sessionKey, path);
        return [];
      }
    },
    upsertServed(sessionKey, path, hashesJson) {
      stmts.servedUpsert(sessionKey, path, hashesJson, Date.now());
    },
    upsertServedReported(sessionKey, path, reportedJson) {
      stmts.servedReportedUpsert(sessionKey, path, reportedJson, Date.now());
    },
    clearServedReported(sessionKey, path) {
      stmts.servedReportedClear(sessionKey, Date.now(), path);
    },
    upsertRetiredAnchors(sessionKey, path, hashesJson) {
      stmts.servedRetiredUpsert(sessionKey, path, hashesJson, Date.now());
    },
    clearRetiredAnchors(sessionKey, path) {
      stmts.servedRetiredClear(sessionKey, Date.now(), path);
    },
    getServedCanons(sessionKey, path) {
      const row = stmts.servedGet(sessionKey, path);
      if (!row || row.canons === null || row.canons === undefined) return [];
      try {
        const parsed = JSON.parse(row.canons as string) as unknown;
        if (!isValidCanonsList(parsed)) throw new TypeError("invalid canons");
        return parsed;
      } catch {
        stmts.servedDelete(sessionKey, path);
        return [];
      }
    },
    getEpochSnapshotId(sessionKey, path) {
      const row = stmts.servedGet(sessionKey, path);
      if (!row || row.snapshotId === null || row.snapshotId === undefined) return undefined;
      return row.snapshotId as string;
    },
    upsertServedCanons(sessionKey, path, canonsJson) {
      stmts.servedCanonsUpsert(sessionKey, path, canonsJson, Date.now());
    },
    clearServedCanons(sessionKey, path) {
      stmts.servedCanonsClear(sessionKey, Date.now(), path);
    },
    upsertEpochSnapshotId(sessionKey, path, snapshotId) {
      stmts.servedSnapshotUpsert(sessionKey, path, snapshotId, Date.now());
    },
    clearEpochSnapshotId(sessionKey, path) {
      stmts.servedSnapshotClear(sessionKey, Date.now(), path);
    },
    getCards(sessionKey, path) {
      const row = stmts.servedGet(sessionKey, path);
      if (!row || row.cards === null || row.cards === undefined) return new Set<number>();
      try {
        const parsed = JSON.parse(row.cards as string) as unknown;
        if (!Array.isArray(parsed)) return new Set<number>();
        return new Set(
          parsed.filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0),
        );
      } catch {
        return new Set<number>();
      }
    },
    upsertCards(sessionKey, path, cardsJson) {
      stmts.servedCardsUpsert(sessionKey, path, cardsJson, Date.now());
    },
    clearCards(sessionKey, path) {
      stmts.servedCardsClear(sessionKey, Date.now(), path);
    },
    deleteServed(sessionKey, path) {
      stmts.servedDelete(sessionKey, path);
    },
    deleteServedByPath(path) {
      stmts.servedDeletePath(path);
    },
    wipeServed(sessionKey) {
      stmts.servedWipe(sessionKey);
    },
    pruneServedOlderThan(ts) {
      stmts.servedPruneOlderThan(ts);
    },
    pruneUndoOlderThan(ts) {
      stmts.undoPruneOlderThan(ts);
    },

    async pruneMissing() {
      const rows = stmts.allPaths() as { path: string }[];
      const missing = await statMissing(rows);
      if (missing.length === 0) return;
      withStore(() => {
        for (const path of missing) {
          snapshotStore.deleteByPath(path);
          stmts.undoDelete(path);
          stmts.servedDeletePath(path);
        }
      });
    },
  };
}

function isHealthy(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return row?.quick_check === "ok";
  } catch (error) {
    if (isCorruptionError(error)) return false;
    return true;
  }
}

async function quarantineStore(storePath: string): Promise<void> {
  const suffix = `.corrupt-${Date.now()}`;
  for (const candidate of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
    try {
      await rename(candidate, `${candidate}${suffix}`);
    } catch (error) {
      if (errCode(error) !== "ENOENT") {
        console.error("Failed to quarantine corrupt hash store file:", error);
      }
    }
  }
}

function shutdownDb(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    console.warn(
      `dsh-better-edit: wal_checkpoint failed on shutdown: ${error instanceof Error ? error.message : String(error)}`,
    ); // best-effort checkpoint before close
  }
  db.close();
}

const STAT_BATCH = 64;

async function statMissing(rows: { path: string }[]): Promise<string[]> {
  const missing: string[] = [];
  for (let i = 0; i < rows.length; i += STAT_BATCH) {
    const batch = rows.slice(i, i + STAT_BATCH);
    const results = await Promise.all(
      batch.map(async (row) => {
        try {
          await stat(row.path);
          return undefined;
        } catch {
          return row.path;
        }
      }),
    );
    for (const path of results) {
      if (path !== undefined) missing.push(path);
    }
  }
  return missing;
}

async function openStore(storePath: string): Promise<HashStore> {
  // Multi-store: never close another workspace's store when opening this one.

  await initHasher();
  await mkdir(dirname(storePath), { recursive: true });
  let existed = existsSync(storePath);
  let opened: { db: DatabaseSync; stmts: Prepared };
  try {
    opened = openDbWithBusyRetry(storePath);
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    console.error("Hash store failed to open, rebuilding:", error);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath);
  }
  if (!isHealthy(opened.db)) {
    shutdownDb(opened.db);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath);
  }
  const { db, stmts } = opened;

  if (!existed) {
    await migrateLegacyStore(db, join(dirname(storePath), "hash-store.json"));
  }
  const snapshotStore = createSnapshotStore(db);
  const store = makeDomainStore(stmts, snapshotStore);
  stores.set(storePath, { path: storePath, db, stmts, store });
  await onStoreOpen(storePath, stmts, store);

  return store;
}

/** Resolve the store path for this call: explicit cwd, the active workspace, or the shared-home fallback. */
function storePathFor(cwd?: string): string {
  return hashStorePath(cwd ?? workspaceCwd());
}

/**
 * Load (and cache) the hash store for the given cwd — or, when omitted, the
 * workspace active for this async execution (`withWorkspace`), falling back to
 * the shared `$DSH_HOME` store outside a tool call.
 * @param cwd - optional explicit workspace root; defaults to the active workspace.
 */
export function loadHashStore(cwd?: string): Promise<HashStore> {
  const storePath = storePathFor(cwd);
  const cached = stores.get(storePath);
  if (cached && cached.db.isOpen) {
    return Promise.resolve(cached.store);
  }
  const existing = openings.get(storePath);
  if (existing) return existing;
  const promise = openStore(storePath).finally(() => {
    openings.delete(storePath);
  });
  openings.set(storePath, promise);
  return promise;
}

/** The cached store entry for the active workspace (or the shared-home fallback), if open. */
function currentStore():
  | { db: DatabaseSync; stmts: Prepared; store: InternalHashStore }
  | undefined {
  const entry = stores.get(storePathFor());
  return entry?.db.isOpen ? entry : undefined;
}

/** Close every open store (process exit, HMR, tests). */
export function shutdownHashStore(): void {
  for (const [, entry] of stores) {
    shutdownDb(entry.db);
  }
  stores.clear();
  openings.clear();
}

/**
 * Run `fn` inside one BEGIN IMMEDIATE transaction on the active workspace's
 * store. Without an open store for this context the call runs bare (the
 * caller has already loaded the store in every in-process path).
 */
export function withStore(fn: () => void): void {
  const store = currentStore();
  if (store) {
    withBusyRetry(() => {
      store.db.exec("BEGIN IMMEDIATE");
      try {
        fn();
        store.db.exec("COMMIT");
      } catch (e) {
        try {
          store.db.exec("ROLLBACK");
        } catch (error) {
          console.warn(error); // best-effort rollback; the original error propagates
        }
        throw e;
      }
    });
  } else {
    fn();
  }
}

// ---- async convenience helpers (load the active store, then delegate) ------

/** Find files whose stored snapshot hashes contain every given anchor. */
export async function findSnapshotPathsByHashes(hashes: string[]): Promise<string[]> {
  const store = await loadHashStore();
  return store.findSnapshotPaths(hashes);
}

/** Persist a hash snapshot for one path (async over the active store). */
export async function upsertSnapshotFor(
  path: string,
  checksum: string,
  lineCount: number,
  hashes: string[],
): Promise<void> {
  const store = await loadHashStore();
  store.upsertSnapshot(path, checksum, lineCount, hashes);
}
