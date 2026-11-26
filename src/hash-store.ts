/**
 * The hash store — ONE deep persistence module for the hashline domain.
 *
 * Owns the sqlite db, the schema and migrations, corruption quarantine, WAL,
 * and the undo/served row APIs. Hash snapshots and lineage live in
 * snapshot-store (shared busy-retry policy in store-retry), adapted here so
 * the HashStore surface stays stable for its duck-typed callers; callers use
 * domain methods, never SQL.
 *
 * Corrupt-row handling (parse the JSON column → validate against the hash
 * alphabet → delete the corrupt row) lives here, once, for every row family.
 */

import { rename, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath } from "./store-tenancy.js";
import { onStoreOpen, setStoresGetter } from "./store-lifecycle.js";
import { workspaceCwd } from "./workspace-context.js";
import { errCode, splitLines } from "./utils.js";
import { initHasher, HASH_CLASS, HASH_RE } from "./hashline/hash-assign.js";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT } from "./constants.js";
import { DomainError } from "./domain-errors.js";
import {
  isValidHashList,
  reportVacuum,
  vacuumSnapshots as runVacuumSnapshots,
  type VacuumResult,
} from "./snapshot-store/index.js";
import { withBusyRetry } from "./store-retry.js";
import {
  createLineageStore,
  ensureLineageTables,
  snapshotHashFor,
  type LineageRow,
  type LineageStore,
} from "./snapshot-store/lineage-store.js";
import { snapshotEpochKey } from "./snapshot-store/epoch.js";
import { withTransaction } from "./snapshot-store/txn.js";

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
  /**
   * The one terminator the edit WROTE (#171), or null/absent on a pre-#171 row. The revert restores
   * at this ending, not at `ending` (`detectEnding`'s pre-image answer), or a mixed pre-image would
   * come back re-spelled.
   */
  effectiveEnding?: string | null;
  /** 1 when the pre-image spelled more than one terminator kind; null/absent means "not recorded". */
  preImageMixed?: number | null;
  /**
   * The codec the migrating write abandoned (#191), or null/absent on a pre-#191 row and on any
   * row whose write migrated nothing. Null means "not recorded" — never a claim.
   */
  migratedFrom?: string | null;
  /** 1 when the abandoned codec carried a BOM the UTF-8 revert cannot restore; null = not recorded. */
  migratedFromBOM?: number | null;
}

/** The v7 undo row contract: legacy state plus the snapshot pin. */
export interface FileUndoRecord {
  content: string;
  bom: string;
  ending: string;
  hashes: string[];
  resultContent: string;
  snapshotHash: string | null;
  updatedAt: number;
  /** Same pair property as `UndoRecord.effectiveEnding` — both rows carry it or neither does. */
  effectiveEnding?: string | null;
  /** Same pair property as `UndoRecord.preImageMixed`. */
  preImageMixed?: number | null;
  /** Same pair property as `UndoRecord.migratedFrom`. */
  migratedFrom?: string | null;
  /** Same pair property as `UndoRecord.migratedFromBOM`. */
  migratedFromBOM?: number | null;
}

/**
 * The v7 undo WRITE input: everything `writeUndo` stores except `updatedAt`.
 * The row's stamp is owned by the store clock (`writeUndoImpl`), so a caller-supplied
 * timestamp would be a required field that is never read.
 */
export type FileUndoWrite = Omit<FileUndoRecord, "updatedAt">;

/** A `file_undo` row exactly as selected (all columns non-nullable except the pin and the #171 pair). */
interface FileUndoRow {
  content: string;
  bom: string;
  ending: string;
  hashes: string;
  result_content: string;
  snapshot_hash: string | null;
  updated_at: number;
  effective_ending: string | null;
  pre_image_mixed: number | null;
  migrated_from: string | null;
  migrated_from_bom: number | null;
}

/**
 * Map a raw `file_undo` SELECT row to `FileUndoRow`, validating every column at the
 * boundary. Replaces an `as unknown as FileUndoRow` double cast that the compiler cannot
 * check (node:sqlite returns `Record<string, unknown>`): a SELECT/mapper drift used to
 * surface as a silently `undefined` field instead of an error.
 */
function mapFileUndoRow(row: Record<string, unknown>): FileUndoRow {
  const content = row["content"];
  const bom = row["bom"];
  const ending = row["ending"];
  const hashes = row["hashes"];
  const resultContent = row["result_content"];
  const snapshotHash = row["snapshot_hash"];
  const updatedAt = row["updated_at"];
  const effectiveEnding = row["effective_ending"];
  const preImageMixed = row["pre_image_mixed"];
  const migratedFrom = row["migrated_from"];
  const migratedFromBOM = row["migrated_from_bom"];
  if (
    typeof content !== "string" ||
    typeof bom !== "string" ||
    typeof ending !== "string" ||
    typeof hashes !== "string" ||
    typeof resultContent !== "string" ||
    !(snapshotHash === null || typeof snapshotHash === "string") ||
    typeof updatedAt !== "number" ||
    !(effectiveEnding === null || typeof effectiveEnding === "string") ||
    !(preImageMixed === null || typeof preImageMixed === "number") ||
    !(migratedFrom === null || typeof migratedFrom === "string") ||
    !(migratedFromBOM === null || typeof migratedFromBOM === "number")
  ) {
    throw new TypeError("invalid file_undo row shape");
  }
  return {
    content,
    bom,
    ending,
    hashes,
    result_content: resultContent,
    snapshot_hash: snapshotHash,
    updated_at: updatedAt,
    effective_ending: effectiveEnding,
    pre_image_mixed: preImageMixed,
    migrated_from: migratedFrom,
    migrated_from_bom: migratedFromBOM,
  };
}

type SqlParams = (string | number)[];

interface Prepared {
  allPaths: (...params: SqlParams) => Record<string, unknown>[];
  fileUndoPruneOlderThan: (...params: SqlParams) => void;
  fileUndoUpsert: (...params: (string | number | null)[]) => void;
  fileUndoGet: (...params: SqlParams) => FileUndoRow | undefined;
  fileUndoDelete: (...params: SqlParams) => void;
  servedMetaGet: (...params: SqlParams) => Record<string, unknown> | undefined;
  servedMetaUpsert: (...params: SqlParams) => void;
  servedMetaReportedUpsert: (...params: SqlParams) => void;
  servedMetaReportedClear: (...params: SqlParams) => void;
  servedMetaRetiredUpsert: (...params: SqlParams) => void;
  servedMetaRetiredClear: (...params: SqlParams) => void;
  servedMetaCanonsUpsert: (...params: SqlParams) => void;
  servedMetaCanonsClear: (...params: SqlParams) => void;
  servedMetaCardsUpsert: (...params: SqlParams) => void;
  servedMetaCardsClear: (...params: SqlParams) => void;
  servedMetaDelete: (...params: SqlParams) => void;
  servedMetaDeletePath: (...params: SqlParams) => void;
  servedMetaWipe: (...params: SqlParams) => void;
  servedMetaPruneOlderThan: (...params: SqlParams) => void;
}

/**
 * The domain face of the hash store. Each row family gets a narrow API;
 * corruption healing (parse → validate → delete) happens inside the getters.
 */
export interface HashStore {
  readonly engine: "node:sqlite";

  /**
   * The stored anchors for a path+content, or undefined on a miss. Lineage is the ONLY source:
   * a row family that does not tile the content exactly is a miss (the v7 repair-at-detection
   * path heals it on the next materialization). `deleteCorrupt` is accepted for the read path's
   * historical call shape and no longer changes this method.
   */
  getSnapshot(path: string, content: string, deleteCorrupt?: boolean): string[] | undefined;
  /**
   * Materialize the v7 snapshot family for a path. `content` is REQUIRED: the legacy `snapshots`
   * shell is a v6 shell and is never written by v7, so a contentless write has nothing to store.
   * `checksum`/`lineCount` stay in the signature for call-site compatibility; the epoch key is
   * derived from `content`.
   */
  upsertSnapshot(
    path: string,
    checksum: string,
    lineCount: number,
    hashes: string[],
    content?: string,
  ): void;
  /**
   * The newest committed lineage for a path, in line order — the evidence a checksum-miss read
   * pairs drifted content against. `undefined` when the path has no committed snapshot, its
   * lineage is empty, or its rows are unusable, so the read falls back to fresh allocation.
   * READ-ONLY: no snapshot row, no lease write.
   */
  latestLineageFor(path: string): LineageRow[] | undefined;
  /** Every path referenced by any v7 row family (`file_snapshots` ∪ `file_undo` ∪ served). */
  allKnownPaths(): { path: string }[];

  /** The undo row for a path, healing a corrupt row (parse → validate → delete). */
  getUndo(path: string): UndoRecord | undefined;
  pruneUndoOlderThan(ts: number): void;
  /** The single undo writer: write-back-or-delete the one row in one transaction. */
  writeUndo(path: string, record: FileUndoWrite): void;
  /** Remove the undo row for a path. */
  deleteUndoPair(path: string): void;
  /** The v7 undo row for a path (same healing contract as `getUndo`, plus the pin/stamp). */
  getFileUndo(path: string): FileUndoRecord | undefined;
  /** Delete every row family's entries for paths that no longer exist on disk. */
  pruneMissing(): Promise<void>;
  /**
   * Run the snapshot retention pass and return its result. The caller (a trigger) owns the report:
   * it calls `reportVacuum(result, context)` so exactly one site decides what an operator sees.
   */
  vacuumSnapshots(): VacuumResult;
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

export type InternalHashStore = HashStore & ServedPersistence & LineageStore;

/** Load the store as served persistence — internal, for SessionView only. */
// SAFETY: loadHashStore returns InternalHashStore (HashStore & ServedPersistence & LineageStore) — cast narrows to served view, validated via ServedPersistence interface; safe because InternalHashStore extends all three.
export function loadServedStore(cwd?: string): Promise<ServedPersistence> {
  return loadHashStore(cwd) as unknown as Promise<ServedPersistence>;
}

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
      console.warn(error);
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
 *
 * pi-lens's `sql-injection` rule (`inline_tier: blocking`) flags any `db.exec`/`db.prepare`
 * that receives a template literal with a substitution, including the two DDL statements
 * below. That finding is a false positive here: SCHEMA_IDENTIFIER_RE rejects anything that
 * is not `[A-Za-z_][A-Za-z0-9_]*` before the SQL text is built, and the rule cannot see
 * that guard. Trigger: re-open if a caller stops passing a literal, SCHEMA_IDENTIFIER_RE is
 * relaxed or removed, or a non-constant reaches table/column/type.
 */
const SCHEMA_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  for (const identifier of [table, column, type]) {
    if (!SCHEMA_IDENTIFIER_RE.test(identifier)) {
      throw new Error(`Refused schema backfill for non-identifier: ${identifier}`);
    }
  }
  const columns = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as {
    name: string;
  }[];
  if (!columns.some((entry) => entry.name === column)) {
    // HACK: DDL identifiers cannot be bind parameters; every value below already passed
    db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + type);
  }
}

/**
 * v7 state tables. All additive (IF NOT EXISTS), owned by this build: a v6
 * process never names them, so a version flap cannot cost v7 anything.
 */
function ensureV7Tables(db: DatabaseSync): void {
  ensureLineageTables(db);
  db.exec(
    "CREATE TABLE IF NOT EXISTS file_undo (" +
      "path TEXT PRIMARY KEY, " +
      "content TEXT NOT NULL, " +
      "bom TEXT NOT NULL, " +
      "ending TEXT NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "result_content TEXT NOT NULL, " +
      "snapshot_hash TEXT, " +
      "effective_ending TEXT, " +
      "pre_image_mixed INTEGER, " +
      "migrated_from TEXT, " +
      "migrated_from_bom INTEGER, " +
      "updated_at INTEGER NOT NULL" +
      ")",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS served_session_meta (" +
      "session_id TEXT NOT NULL, " +
      "file_path TEXT NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "reported TEXT, " +
      "retired TEXT, " +
      "canons TEXT, " +
      "cards TEXT, " +
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
      "effective_ending TEXT, " +
      "pre_image_mixed INTEGER, " +
      "migrated_from TEXT, " +
      "migrated_from_bom INTEGER, " +
      "updated_at INTEGER NOT NULL" +
      ")",
  );
  addColumnIfMissing(db, "undo", "effective_ending", "TEXT");
  addColumnIfMissing(db, "undo", "pre_image_mixed", "INTEGER");
  addColumnIfMissing(db, "undo", "migrated_from", "TEXT");
  addColumnIfMissing(db, "undo", "migrated_from_bom", "INTEGER");
  addColumnIfMissing(db, "file_undo", "effective_ending", "TEXT");
  addColumnIfMissing(db, "file_undo", "pre_image_mixed", "INTEGER");
  addColumnIfMissing(db, "file_undo", "migrated_from", "TEXT");
  addColumnIfMissing(db, "file_undo", "migrated_from_bom", "INTEGER");
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
      "cards TEXT, " +
      "updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY (session_id, path)" +
      ")",
  );
  addColumnIfMissing(db, "served", "canons", "TEXT");
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
 * The v9 step: move the warm served mirror from the v6 `served` shell onto `served_session_meta`.
 * `ensureSchema` ran first, so the table exists and the shell columns (`retired`, `canons`,
 * `cards`) are backfilled; the anchor-generation sweep runs AFTER this migration, so a copied
 * family minted under a foreign epoch is still reclaimed wholesale.
 *
 * `DO NOTHING`, never `DO UPDATE`: a re-migration (stamp back to 8 after a downgrade) must keep
 * the live v7 row when a concurrent v6 writer has since rewritten the shell row for the same key.
 */
function copyServedShellIntoMeta(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO served_session_meta " +
      "(session_id, file_path, hashes, reported, retired, canons, cards, updated_at) " +
      "SELECT session_id, path, hashes, reported, retired, canons, cards, updated_at FROM served WHERE true " +
      "ON CONFLICT(session_id, file_path) DO NOTHING",
  ).run();
}

/**
 * The single atomic forward migration. Called only when the stamp differs
 * from HASH_STORE_VERSION (including an absent or non-integer stamp on a
 * pre-versioning store). The sole writer of meta.version. Its data steps run
 * in order beside the stamp write, inside the same transaction; `ensureSchema`
 * has already created the target tables and backfilled the shell columns. The
 * stamp is re-checked under the RESERVED lock: a newer writer that committed
 * between the probe and BEGIN IMMEDIATE is refused here, so the stamp write can
 * never silently downgrade a newer store.
 */
function migrateForward(db: DatabaseSync, storePath: string): void {
  let migrationOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    migrationOpen = true;
    assertNotNewer(storedVersion(db), storePath);
    copyServedShellIntoMeta(db);
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

/**
 * `meta` key carrying the snapshot epoch the store's anchor-bearing rows were minted under.
 * Value shape: `snapshotEpochKey()` — `${CANON_VERSION}:${ANCHOR_GENERATION}`, without the trailing
 * separator. The epoch shape and both of its predicates are owned by `./snapshot-store/epoch.js`.
 */
const ANCHOR_STAMP_KEY = "anchor_generation";

/** The current snapshot epoch as the stamp value (also the prefix of every snapshot key). */
function anchorStamp(): string {
  return snapshotEpochKey();
}

/**
 * The open-time reclaim of anchor-bearing state minted under a foreign identity generation (#138).
 *
 * Runs AFTER `migrateForward`, and never inside the migration transaction: this is key-prefix
 * housekeeping, not a schema step, and it must stay idempotent on every open. There is NO schema
 * change and NO per-row generation column — every v7 row family that carries anchors is keyed by a
 * snapshot key, so "not under the current prefix" IS the marker.
 *
 * Retention only, never validity: the sweep keeps the FULL-epoch prefix (`${CANON_VERSION}:${ANCHOR_GENERATION}:`),
 * and a row that outlives it — one a concurrent mixed-version writer mints after this open — is still
 * refused as evidence by every reuse seam (`src/snapshot-store/epoch.ts`, ADR-0054).
 */
function sweepForeignAnchorGeneration(db: DatabaseSync): void {
  const stamp = anchorStamp();
  const stamped = db.prepare("SELECT value FROM meta WHERE key = ?").get(ANCHOR_STAMP_KEY) as
    | { value?: string }
    | undefined;
  if (stamped?.value === stamp) return;
  const prefix = `${stamp}:%`;
  let sweepOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    sweepOpen = true;
    db.prepare("DELETE FROM file_snapshots WHERE snapshot_hash NOT LIKE ?").run(prefix);
    db.prepare(
      "DELETE FROM line_lineage WHERE snapshot_id NOT IN (SELECT snapshot_id FROM file_snapshots)",
    ).run();
    db.prepare("DELETE FROM served_leases WHERE served_snapshot_hash NOT LIKE ?").run(prefix);
    db.prepare("DELETE FROM served_session_meta").run();
    db.prepare("DELETE FROM file_undo WHERE snapshot_hash IS NULL OR snapshot_hash NOT LIKE ?").run(
      prefix,
    );
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(ANCHOR_STAMP_KEY, stamp);
    db.exec("COMMIT");
    sweepOpen = false;
  } catch (error) {
    if (sweepOpen) {
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
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  const currentServedColumns = db.prepare("PRAGMA table_info(served)").all() as {
    name: string;
  }[];
  if (!currentServedColumns.some((column) => column.name === "retired")) {
    db.exec("ALTER TABLE served ADD COLUMN retired TEXT");
  }
  if (stored !== HASH_STORE_VERSION) migrateForward(db, storePath);
  sweepForeignAnchorGeneration(db);
  const allStmt = db.prepare(
    "SELECT path FROM file_undo UNION SELECT path FROM file_snapshots UNION SELECT path FROM line_id_counters UNION SELECT file_path FROM served_leases UNION SELECT file_path AS path FROM served_session_meta",
  );
  const fileUndoPruneOlderThanStmt = db.prepare("DELETE FROM file_undo WHERE updated_at < ?");
  const fileUndoUpsertStmt = db.prepare(
    "INSERT INTO file_undo (path, content, bom, ending, hashes, result_content, effective_ending, pre_image_mixed, migrated_from, migrated_from_bom, snapshot_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, hashes = excluded.hashes, result_content = excluded.result_content, effective_ending = excluded.effective_ending, pre_image_mixed = excluded.pre_image_mixed, migrated_from = excluded.migrated_from, migrated_from_bom = excluded.migrated_from_bom, snapshot_hash = excluded.snapshot_hash, updated_at = excluded.updated_at",
  );
  const fileUndoGetStmt = db.prepare(
    "SELECT content, bom, ending, hashes, result_content, snapshot_hash, updated_at, effective_ending, pre_image_mixed, migrated_from, migrated_from_bom FROM file_undo WHERE path = ?",
  );
  const fileUndoDelStmt = db.prepare("DELETE FROM file_undo WHERE path = ?");
  const servedMetaGetStmt = db.prepare(
    "SELECT hashes, reported, retired, canons, cards FROM served_session_meta WHERE session_id = ? AND file_path = ?",
  );
  const servedMetaUpsertStmt = db.prepare(
    "INSERT INTO served_session_meta (session_id, file_path, hashes, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(session_id, file_path) DO UPDATE SET hashes = excluded.hashes, updated_at = excluded.updated_at",
  );
  const servedMetaReportedUpsertStmt = db.prepare(
    "INSERT INTO served_session_meta (session_id, file_path, hashes, reported, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, file_path) DO UPDATE SET reported = excluded.reported, updated_at = excluded.updated_at",
  );
  const servedMetaReportedClearStmt = db.prepare(
    "UPDATE served_session_meta SET reported = NULL, updated_at = ? WHERE session_id = ? AND file_path = ?",
  );
  const servedMetaRetiredUpsertStmt = db.prepare(
    "INSERT INTO served_session_meta (session_id, file_path, hashes, retired, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, file_path) DO UPDATE SET retired = excluded.retired, updated_at = excluded.updated_at",
  );
  const servedMetaRetiredClearStmt = db.prepare(
    "UPDATE served_session_meta SET retired = NULL, updated_at = ? WHERE session_id = ? AND file_path = ?",
  );
  const servedMetaCanonsUpsertStmt = db.prepare(
    "INSERT INTO served_session_meta (session_id, file_path, hashes, canons, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, file_path) DO UPDATE SET canons = excluded.canons, updated_at = excluded.updated_at",
  );
  const servedMetaCanonsClearStmt = db.prepare(
    "UPDATE served_session_meta SET canons = NULL, updated_at = ? WHERE session_id = ? AND file_path = ?",
  );
  const servedMetaCardsUpsertStmt = db.prepare(
    "INSERT INTO served_session_meta (session_id, file_path, hashes, cards, updated_at) VALUES (?, ?, '[]', ?, ?) " +
      "ON CONFLICT(session_id, file_path) DO UPDATE SET cards = excluded.cards, updated_at = excluded.updated_at",
  );
  const servedMetaCardsClearStmt = db.prepare(
    "UPDATE served_session_meta SET cards = NULL, updated_at = ? WHERE session_id = ? AND file_path = ?",
  );
  const servedMetaDeleteStmt = db.prepare(
    "DELETE FROM served_session_meta WHERE session_id = ? AND file_path = ?",
  );
  const servedMetaDeletePathStmt = db.prepare(
    "DELETE FROM served_session_meta WHERE file_path = ?",
  );
  const servedMetaWipeStmt = db.prepare("DELETE FROM served_session_meta WHERE session_id = ?");
  const servedMetaPruneOlderThanStmt = db.prepare(
    "DELETE FROM served_session_meta WHERE updated_at < ?",
  );
  const stmts: Prepared = {
    allPaths: (...params) => allStmt.all(...params) as Record<string, unknown>[],
    fileUndoPruneOlderThan: (...params) => {
      withBusyRetry(() => {
        fileUndoPruneOlderThanStmt.run(...params);
      });
    },
    fileUndoUpsert: (...params: (string | number | null)[]) => {
      withBusyRetry(() => {
        fileUndoUpsertStmt.run(...params);
      });
    },
    fileUndoGet: (...params) => {
      const row = fileUndoGetStmt.get(...params);
      return row === undefined ? undefined : mapFileUndoRow(row);
    },
    fileUndoDelete: (...params) => {
      withBusyRetry(() => {
        fileUndoDelStmt.run(...params);
      });
    },
    servedMetaGet: (...params) =>
      servedMetaGetStmt.get(...params) as Record<string, unknown> | undefined,
    servedMetaUpsert: (...params) => {
      withBusyRetry(() => {
        servedMetaUpsertStmt.run(...params);
      });
    },
    servedMetaReportedUpsert: (...params) => {
      withBusyRetry(() => {
        servedMetaReportedUpsertStmt.run(...params);
      });
    },
    servedMetaReportedClear: (...params) => {
      withBusyRetry(() => {
        servedMetaReportedClearStmt.run(params[1], params[0], params[2]);
      });
    },
    servedMetaRetiredUpsert: (...params) => {
      withBusyRetry(() => {
        servedMetaRetiredUpsertStmt.run(...params);
      });
    },
    servedMetaRetiredClear: (...params) => {
      withBusyRetry(() => {
        servedMetaRetiredClearStmt.run(params[1], params[0], params[2]);
      });
    },
    servedMetaCanonsUpsert: (...params) => {
      withBusyRetry(() => {
        servedMetaCanonsUpsertStmt.run(...params);
      });
    },
    servedMetaCanonsClear: (...params) => {
      withBusyRetry(() => {
        servedMetaCanonsClearStmt.run(params[1], params[0], params[2]);
      });
    },
    servedMetaCardsUpsert: (...params) => {
      withBusyRetry(() => {
        servedMetaCardsUpsertStmt.run(...params);
      });
    },
    servedMetaCardsClear: (...params) => {
      withBusyRetry(() => {
        servedMetaCardsClearStmt.run(params[1], params[0], params[2]);
      });
    },
    servedMetaDelete: (...params) => {
      withBusyRetry(() => {
        servedMetaDeleteStmt.run(...params);
      });
    },
    servedMetaDeletePath: (...params) => {
      withBusyRetry(() => {
        servedMetaDeletePathStmt.run(...params);
      });
    },
    servedMetaWipe: (...params) => {
      withBusyRetry(() => {
        servedMetaWipeStmt.run(...params);
      });
    },
    servedMetaPruneOlderThan: (...params) => {
      withBusyRetry(() => {
        servedMetaPruneOlderThanStmt.run(...params);
      });
    },
  };
  return { db, stmts };
}

/**
 * Namespace for drift-episode keys in a served-reported set. The set historically stored bare
 * anchor hashes (`HASH_RE`); a position-encoded episode key shares the hash alphabet, so it
 * carries a prefix outside ALPH to keep the two domains disjoint. `driftEpisodeKey`
 * (session-view) is the sole encoder; the reader below accepts both grammars so a namespaced
 * mark survives the store round-trip instead of being dropped on load.
 */
export const DRIFT_EPISODE_PREFIX = "#";
export const DRIFT_EPISODE_RE = new RegExp(`^${DRIFT_EPISODE_PREFIX}${HASH_CLASS}$`);

/** Wire the domain methods over the prepared statements. */
function makeDomainStore(
  stmts: Prepared,
  lineageStore: LineageStore,
  db: DatabaseSync,
): InternalHashStore {
  function vacuumAfterMaterialization(path: string, content: string | undefined): void {
    if (content === undefined) return;
    try {
      const protectId = lineageStore.snapshotIdFor(path, snapshotHashFor(content));
      const result = runVacuumSnapshots(
        db,
        protectId === undefined ? {} : { protectSnapshotIds: [protectId] },
      );
      reportVacuum(result, `materialize ${path}`);
    } catch (error) {
      console.warn(
        `dsh-better-edit: snapshot vacuum failed after materializing ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  function withUndoTxn(fn: () => void): void {
    withTransaction(db, fn);
  }

  function writeUndoImpl(path: string, record: FileUndoWrite): void {
    const stamp = Date.now();
    withUndoTxn(() => {
      stmts.fileUndoUpsert(
        path,
        record.content,
        record.bom,
        record.ending,
        JSON.stringify(record.hashes),
        record.resultContent,
        record.effectiveEnding ?? record.ending,
        record.preImageMixed === 1 ? 1 : 0,
        record.migratedFrom ?? null,
        record.migratedFromBOM ?? null,
        record.snapshotHash,
        stamp,
      );
    });
  }

  function deleteUndoImpl(path: string): void {
    withUndoTxn(() => {
      stmts.fileUndoDelete(path);
    });
  }

  function loadFileUndo(path: string): FileUndoRecord | undefined {
    try {
      const row = stmts.fileUndoGet(path);
      if (!row) return undefined;
      const parsed = JSON.parse(row.hashes as string);
      if (!isValidHashList(parsed)) {
        deleteUndoImpl(path);
        return undefined;
      }
      return {
        content: row.content,
        bom: row.bom,
        ending: row.ending,
        hashes: parsed as string[],
        resultContent: row.result_content,
        snapshotHash: row.snapshot_hash ?? null,
        updatedAt: row.updated_at,
        effectiveEnding: row.effective_ending,
        preImageMixed: row.pre_image_mixed,
        migratedFrom: row.migrated_from,
        migratedFromBOM: row.migrated_from_bom,
      };
    } catch (error) {
      const healable = error instanceof TypeError || error instanceof SyntaxError;
      if (!healable) throw error;
      deleteUndoImpl(path);
      return undefined;
    }
  }

  return {
    engine: "node:sqlite",

    getSnapshot(path, content) {
      const lineage = lineageStore.lineageFor(path, snapshotHashFor(content));
      if (
        lineage.length === splitLines(content).length &&
        lineage.every((row, index) => row.lineNumber === index + 1 && HASH_RE.test(row.anchor))
      ) {
        return lineage.map((row) => row.anchor);
      }
      return undefined;
    },
    upsertSnapshot(path, _checksum, _lineCount, hashes, content) {
      if (content === undefined) {
        throw new Error(
          "upsertSnapshot requires content: the legacy snapshots shell is not written by v7",
        );
      }
      lineageStore.commitSnapshot({ path, content, hashes });
      vacuumAfterMaterialization(path, content);
    },
    commitSnapshot(input) {
      lineageStore.commitSnapshot(input);
      vacuumAfterMaterialization(input.path, input.content);
    },
    lineageFor(path, snapshotHash) {
      return lineageStore.lineageFor(path, snapshotHash);
    },
    latestLineageFor(path) {
      return lineageStore.latestLineageFor(path);
    },
    positionsByIdentity(path, content) {
      return lineageStore.positionsByIdentity(path, content);
    },
    leaseFor(sessionKey, path, anchor) {
      return lineageStore.leaseFor(sessionKey, path, anchor);
    },
    leaseHomes(sessionKey, excludePath, anchor) {
      return lineageStore.leaseHomes(sessionKey, excludePath, anchor);
    },
    snapshotIdFor(path, snapshotHash) {
      return lineageStore.snapshotIdFor(path, snapshotHash);
    },
    deleteByPath(path) {
      lineageStore.deleteByPath(path);
    },
    allKnownPaths() {
      return stmts.allPaths() as { path: string }[];
    },

    getUndo(path) {
      const record = loadFileUndo(path);
      if (record === undefined) return undefined;
      return {
        content: record.content,
        bom: record.bom,
        ending: record.ending,
        hashes: record.hashes,
        resultContent: record.resultContent,
        effectiveEnding: record.effectiveEnding ?? null,
        preImageMixed: record.preImageMixed ?? null,
        migratedFrom: record.migratedFrom ?? null,
        migratedFromBOM: record.migratedFromBOM ?? null,
      };
    },
    getFileUndo(path) {
      return loadFileUndo(path);
    },
    writeUndo(path, record) {
      writeUndoImpl(path, record);
    },
    deleteUndoPair(path) {
      deleteUndoImpl(path);
    },

    getServed(sessionKey, path) {
      const row = stmts.servedMetaGet(sessionKey, path);
      if (!row) return [];
      try {
        const parsed = JSON.parse(row.hashes as string);
        if (isValidServedList(parsed)) return parsed;
        stmts.servedMetaDelete(sessionKey, path);
        return [];
      } catch {
        stmts.servedMetaDelete(sessionKey, path);
        return [];
      }
    },
    getServedReported(sessionKey, path) {
      const row = stmts.servedMetaGet(sessionKey, path);
      if (!row) return new Set();
      const raw = row.reported;
      if (typeof raw !== "string" || raw.length === 0) return new Set();
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return new Set();
        return new Set(
          parsed.filter(
            (h): h is string =>
              typeof h === "string" && (HASH_RE.test(h) || DRIFT_EPISODE_RE.test(h)),
          ),
        );
      } catch {
        return new Set();
      }
    },
    getAnchorReservations(sessionKey, path) {
      const reservedHashes = new Set<string>();
      const retiredHashes = new Set<string>();
      const row = stmts.servedMetaGet(sessionKey, path);
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
      } catch {
        stmts.servedMetaDelete(sessionKey, path);
      }
      return { reservedHashes, retiredHashes };
    },
    getRetiredAnchors(sessionKey, path) {
      const row = stmts.servedMetaGet(sessionKey, path);
      if (!row || row.retired === null || row.retired === undefined) {
        return new Set();
      }
      try {
        const entries = parseRetiredJson(row.retired as string);
        return new Set(entries.map((e) => e.hash));
      } catch {
        stmts.servedMetaDelete(sessionKey, path);
        return new Set();
      }
    },
    getRetiredEntries(sessionKey, path): RetiredEntry[] {
      const row = stmts.servedMetaGet(sessionKey, path);
      if (!row || row.retired === null || row.retired === undefined) return [];
      try {
        return parseRetiredJson(row.retired as string);
      } catch {
        stmts.servedMetaDelete(sessionKey, path);
        return [];
      }
    },
    upsertServed(sessionKey, path, hashesJson) {
      stmts.servedMetaUpsert(sessionKey, path, hashesJson, Date.now());
    },
    upsertServedReported(sessionKey, path, reportedJson) {
      stmts.servedMetaReportedUpsert(sessionKey, path, reportedJson, Date.now());
    },
    clearServedReported(sessionKey, path) {
      stmts.servedMetaReportedClear(sessionKey, Date.now(), path);
    },
    upsertRetiredAnchors(sessionKey, path, hashesJson) {
      stmts.servedMetaRetiredUpsert(sessionKey, path, hashesJson, Date.now());
    },
    clearRetiredAnchors(sessionKey, path) {
      stmts.servedMetaRetiredClear(sessionKey, Date.now(), path);
    },
    getServedCanons(sessionKey, path) {
      const row = stmts.servedMetaGet(sessionKey, path);
      if (!row || row.canons === null || row.canons === undefined) return [];
      try {
        const parsed = JSON.parse(row.canons as string) as unknown;
        if (!isValidCanonsList(parsed)) throw new TypeError("invalid canons");
        return parsed;
      } catch {
        stmts.servedMetaDelete(sessionKey, path);
        return [];
      }
    },
    upsertServedCanons(sessionKey, path, canonsJson) {
      stmts.servedMetaCanonsUpsert(sessionKey, path, canonsJson, Date.now());
    },
    clearServedCanons(sessionKey, path) {
      stmts.servedMetaCanonsClear(sessionKey, Date.now(), path);
    },
    getCards(sessionKey, path) {
      const row = stmts.servedMetaGet(sessionKey, path);
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
      stmts.servedMetaCardsUpsert(sessionKey, path, cardsJson, Date.now());
    },
    clearCards(sessionKey, path) {
      stmts.servedMetaCardsClear(sessionKey, Date.now(), path);
    },
    deleteServed(sessionKey, path) {
      stmts.servedMetaDelete(sessionKey, path);
    },
    deleteServedByPath(path) {
      stmts.servedMetaDeletePath(path);
    },
    wipeServed(sessionKey) {
      stmts.servedMetaWipe(sessionKey);
    },
    pruneServedOlderThan(ts) {
      stmts.servedMetaPruneOlderThan(ts);
    },
    pruneUndoOlderThan(ts) {
      stmts.fileUndoPruneOlderThan(ts);
    },

    async pruneMissing() {
      const rows = stmts.allPaths() as { path: string }[];
      const missing = await statMissing(rows);
      if (missing.length === 0) return;
      withStore(() => {
        for (const path of missing) {
          lineageStore.deleteByPath(path);
          stmts.fileUndoDelete(path);
          stmts.servedMetaDeletePath(path);
        }
      });
    },
    vacuumSnapshots() {
      return runVacuumSnapshots(db);
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
    );
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
  await initHasher();
  await mkdir(dirname(storePath), { recursive: true });
  let opened: { db: DatabaseSync; stmts: Prepared };
  try {
    opened = openDbWithBusyRetry(storePath);
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    console.error("Hash store failed to open, rebuilding:", error);
    await quarantineStore(storePath);
    opened = openDbWithBusyRetry(storePath);
  }
  if (!isHealthy(opened.db)) {
    shutdownDb(opened.db);
    await quarantineStore(storePath);
    opened = openDbWithBusyRetry(storePath);
  }
  const { db, stmts } = opened;

  const lineageStore = createLineageStore(db);
  const store = makeDomainStore(stmts, lineageStore, db);
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
 * caller has already loaded the store in every in-process path). Re-entrant:
 * when a store already has a transaction open, `fn` joins it.
 */
export function withStore(fn: () => void): void {
  const store = currentStore();
  if (store) {
    withTransaction(store.db, fn);
  } else {
    fn();
  }
}

/** Persist a hash snapshot for one path (async over the active store). */
export async function upsertSnapshotFor(
  path: string,
  checksum: string,
  lineCount: number,
  hashes: string[],
  content?: string,
): Promise<void> {
  const store = await loadHashStore();
  store.upsertSnapshot(path, checksum, lineCount, hashes, content);
}
