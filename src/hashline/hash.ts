/**
 * Hash persistence — deep persistence wrapper for HashAssign.
 * Private to HashAssign seam; use `from "./hash-assign.js"` for pure APIs
 * and `from "./hash.js"` only for persistence-aware lineHashes.
 * Now imports pure APIs from hash-assign (no circular).
 * @module dsh-better-edit/hashline/hash
 */
import { splitLines } from "../utils.js";
import { loadHashStore, type HashStore } from "../hash-store.js";
import { contentChecksum, initHasher } from "./hash-assign.js";
import { lineHashesPure, mapStableHashes } from "./hash-assign.js";

export async function lineHashes(content: string, path?: string, previous?: { content: string; hashes: string[]; removedHashes?: Set<string> }, store?: HashStore, persist?: boolean): Promise<string[]> {
  await initHasher();
  if (!path) return lineHashesPure(content);
  const hashStore = store ?? (await loadHashStore());
  if (previous) {
    const newHashes = mapStableHashes(previous.content, previous.hashes, content, previous.removedHashes);
    if (persist !== false) {
      try { hashStore.upsertSnapshot(path, contentChecksum(content), splitLines(content).length, newHashes); } catch (e) { console.error("Failed to persist hash snapshot:", e); }
    }
    return newHashes;
  }
  let cached: string[] | undefined;
  try { cached = hashStore.getSnapshot(path, content, persist !== false); } catch (e) { console.error("Failed to read hash store snapshot:", e); }
  if (cached) return cached;
  const newHashes = lineHashesPure(content);
  if (persist !== false) {
    try { hashStore.upsertSnapshot(path, contentChecksum(content), splitLines(content).length, newHashes); } catch (e) { console.error("Failed to persist hash snapshot:", e); }
  }
  return newHashes;
}
