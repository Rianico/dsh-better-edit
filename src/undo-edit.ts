/**
 * Undo persistence for the hashline tools: before an edit is applied, the
 * pre-edit state (content, BOM, original line ending, hash anchors, and the
 * result content that the undo must verify against) is written to the hash
 * store. `undo_last_edit` reverts only when the file still matches the stored
 * result — a later external write clears the history instead of being
 * overwritten. Undo survives restarts (the store is on disk).
 * @module dsh-better-edit/undo-edit
 */

import type { LineEnding } from "./edit-diff.js";
import { loadHashStore, type FileUndoRecord, type FileUndoWrite } from "./hash-store.js";
import type { EncodingMigration } from "./file-encoding-state.js";
import { snapshotHashFor } from "./snapshot-store/lineage-store.js";
import { isCurrentRawAnchorGeneration, parseSnapshotEpoch } from "./snapshot-store/epoch.js";

/** Load the last undo row for a path from the active store, if any. */
/** Load the last undo row for a path from the active store, if any. */
async function readUndo(path: string): Promise<FileUndoRecord | undefined> {
  const store = await loadHashStore();
  return store.getFileUndo(path);
}

/** Persist the undo row (content plus the snapshot pin) for a path to the active store. */
async function writeUndo(path: string, record: FileUndoWrite): Promise<void> {
  const store = await loadHashStore();
  store.writeUndo(path, record);
}

export interface UndoEntry {
  content: string;
  bom: string;
  originalEnding: LineEnding;
  hashes: string[];
  resultContent: string;
  /**
   * The one terminator the edit wrote (#171). Absent = "not recorded" (or a pre-#171 caller), in
   * which case the revert falls back to `originalEnding`. Do not default it here: the fallback is
   * the reader's job (`getUndo`), so the writer never claims an ending the edit did not use.
   */
  effectiveEnding?: LineEnding;
  /** True when the pre-image spelled more than one terminator kind, so the revert cannot restore it. */
  preImageMixed?: boolean;
  /**
   * The codec the migrating write abandoned (#191). Absent = "not recorded" (a pre-#191 row,
   * or a write that migrated nothing): the revert claims nothing. Present only when the save
   * seam took the verdict on the non-faithful legacy arm — never recomputed here.
   */
  migration?: EncodingMigration;
}

/**
 * A stored ending narrowed to the type the restore can spell: anything else (including NULL from a
 * pre-#171 row) is "not recorded" and falls back to `originalEnding` at the call site.
 */
function knownEnding(value: string | null | undefined): LineEnding | undefined {
  return value === "\r\n" || value === "\n" || value === "\r" ? value : undefined;
}

/**
 * Persist an undo entry for one path before mutating it.
 * @param path - canonical absolute path.
 * @param entry - the pre-edit state plus the result content the undo will verify.
 * @returns whether persistence succeeded, plus a restore that puts the previous
 *   undo entry back (used when the mutation itself fails).
 */
export async function saveUndo(
  path: string,
  entry: UndoEntry,
): Promise<{ persisted: boolean; restore: () => Promise<void> }> {
  let previous: FileUndoRecord | undefined;
  try {
    previous = await readUndo(path);
    await writeUndo(path, {
      content: entry.content,
      bom: entry.bom,
      ending: entry.originalEnding,
      hashes: entry.hashes,
      resultContent: entry.resultContent,
      effectiveEnding: entry.effectiveEnding,
      preImageMixed: entry.preImageMixed === true ? 1 : 0,
      migratedFrom: entry.migration?.encoding,
      migratedFromBOM: entry.migration === undefined ? undefined : entry.migration.hasBOM ? 1 : 0,
      snapshotHash: snapshotHashFor(entry.content),
    });
  } catch (error) {
    console.error("Failed to persist undo entry:", error);
    return { persisted: false, restore: async () => undefined };
  }
  return {
    persisted: true,
    restore: async () => {
      try {
        if (previous) {
          const store = await loadHashStore();
          store.writeUndo(path, previous);
        } else {
          const store = await loadHashStore();
          store.deleteUndoPair(path);
        }
      } catch (error) {
        console.error("Failed to restore previous undo entry:", error);
      }
    },
  };
}

/** Load the last undo entry for a path, if any. */
export async function getUndo(path: string): Promise<UndoEntry | undefined> {
  try {
    const record = await readUndo(path);
    const pinEpoch = parseSnapshotEpoch(record?.snapshotHash);
    if (record === undefined || !isCurrentRawAnchorGeneration(pinEpoch?.anchorGeneration)) {
      const store = await loadHashStore();
      store.deleteUndoPair(path);
      return undefined;
    }
    const originalEnding = record.ending;
    if (originalEnding !== "\r\n" && originalEnding !== "\n" && originalEnding !== "\r") {
      const store = await loadHashStore();
      store.deleteUndoPair(path);
      return undefined;
    }
    const migration =
      typeof record.migratedFrom === "string" && typeof record.migratedFromBOM === "number"
        ? { encoding: record.migratedFrom, hasBOM: record.migratedFromBOM === 1 }
        : undefined;
    return {
      content: record.content,
      bom: record.bom,
      originalEnding,
      effectiveEnding: knownEnding(record.effectiveEnding) ?? originalEnding,
      preImageMixed: record.preImageMixed === 1,
      ...(migration === undefined ? {} : { migration }),
      hashes: record.hashes,
      resultContent: record.resultContent,
    };
  } catch (error) {
    console.error("Failed to load undo entry:", error);
    return undefined;
  }
}

/** Drop the undo entry for a path (a write or an undone revert clears history). */
export async function clearUndo(path: string): Promise<void> {
  try {
    const store = await loadHashStore();
    store.deleteUndoPair(path);
  } catch (error) {
    console.error("Failed to clear undo entry:", error);
  }
}
