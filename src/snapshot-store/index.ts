/**
 * The `snapshots` table's sole owner: storage detail (SQL, row encoding,
 * hash validation, busy-retry) hides behind a narrow domain interface.
 *
 * Read-order contract: `get` returns hashes in line order (index *i* ↔ line
 * *i* + 1). Storage is a line-ordered JSON array by construction; this module
 * never sorts, reverses or otherwise reorders it — a normalized read must
 * preserve the same contract (e.g. `ORDER BY line_number ASC`).
 * @module dsh-better-edit/snapshot-store
 */
import { DatabaseSync } from "node:sqlite";
import { contentChecksum, HASH_RE, CANON_VERSION } from "../hashline/hash-assign.js";
import { splitLines } from "../utils.js";
import { withBusyRetry } from "../store-retry.js";

export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  return true;
}

function cacheKey(checksum: string): string {
  return `${CANON_VERSION}:${checksum}`;
}

export interface SnapshotStore {
  get(path: string, content: string, deleteCorrupt?: boolean): string[] | undefined;
  upsert(path: string, checksum: string, lineCount: number, hashes: string[]): void;
  allHashes(): { path: string; hashes: string }[];
  deleteByPath(path: string): void;
  findPathsContaining(hashes: string[]): string[];
}

export function createSnapshotStore(db: DatabaseSync): SnapshotStore {
  const getStmt = db.prepare(
    "SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?",
  );
  const allHashesStmt = db.prepare("SELECT path, hashes FROM snapshots");
  const delStmt = db.prepare("DELETE FROM snapshots WHERE path = ?");
  const upsertStmt = db.prepare(
    "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at",
  );
  return {
    get(path, content, deleteCorrupt = true) {
      const checksum = cacheKey(contentChecksum(content));
      const lineCount = splitLines(content).length;
      const row = getStmt.get(path, checksum, lineCount) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      try {
        const parsed = JSON.parse(row.hashes as string);
        if (isValidHashList(parsed)) return parsed;
        if (deleteCorrupt) {
          withBusyRetry(() => {
            delStmt.run(path);
          });
        }
        return undefined;
      } catch (error) {
        if (deleteCorrupt) {
          withBusyRetry(() => {
            delStmt.run(path);
          });
        }
        return undefined;
      }
    },
    upsert(path, checksum, lineCount, hashes) {
      withBusyRetry(() => {
        upsertStmt.run(path, cacheKey(checksum), lineCount, JSON.stringify(hashes), Date.now());
      });
    },
    allHashes() {
      return allHashesStmt.all() as { path: string; hashes: string }[];
    },
    deleteByPath(path) {
      withBusyRetry(() => {
        delStmt.run(path);
      });
    },
    findPathsContaining(hashes) {
      const rows = allHashesStmt.all() as { path: string; hashes: string }[];
      const matches: string[] = [];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.hashes) as unknown;
          if (!isValidHashList(parsed)) continue;
          if (hashes.every((h) => parsed.includes(h))) matches.push(row.path);
        } catch (error) {
          console.warn(error); // unparseable row → skip it
        }
      }
      return matches;
    },
  };
}
