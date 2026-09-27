/**
 * Legacy pre-SQLite JSON file import (`hash-store.json` → `snapshots` shell).
 * Moved verbatim from `hash-store.ts`: same validity rules, same messages,
 * same best-effort I/O handling, same transaction shape, same `.bak` rename.
 * The legacy path stays the caller's business: `openStore` resolves it
 * tenant-aware via `join(dirname(storePath), "hash-store.json")` and passes
 * it in, so this module never touches tenancy or `hash-store`.
 * @module dsh-better-edit/snapshot-store/migrate
 */
import { DatabaseSync } from "node:sqlite";
import { rename, readFile } from "node:fs/promises";
import { contentChecksum } from "../hashline/hash-assign.js";
import { splitLines, errCode } from "../utils.js";
import { isValidHashList } from "./index.js";

export interface LegacySnapshot {
  content: string;
  hashes: string[];
}

export function isValidSnapshot(value: unknown): value is LegacySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.content !== "string") return false;
  return isValidHashList(v.hashes);
}

export async function migrateLegacyStore(db: DatabaseSync, legacyPath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(legacyPath, "utf-8");
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") return;
    console.error("Failed to read legacy hash store for migration:", error);
    return;
  }

  let parsed: { snapshots?: Record<string, unknown> };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch (error) {
    console.error("Failed to parse legacy hash store, skipping migration:", error);
    return;
  }

  const raw = parsed.snapshots;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

  const rows: [string, string, number, string, number][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isValidSnapshot(value)) continue;
    if (new Set(value.hashes).size !== value.hashes.length) {
      console.warn(
        `Skipped legacy snapshot with duplicate hashes for ${key}; it will be re-hashed on next read.`,
      );
      continue;
    }
    rows.push([
      key,
      contentChecksum(value.content),
      splitLines(value.content).length,
      JSON.stringify(value.hashes),
      Date.now(),
    ]);
  }
  if (rows.length > 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = db.prepare(
        "INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const row of rows) stmt.run(...row);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  try {
    await rename(legacyPath, `${legacyPath}.bak`);
  } catch (error) {
    console.error("Failed to rename legacy hash store after migration:", error);
  }
}
