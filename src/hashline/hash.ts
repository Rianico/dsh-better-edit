import { splitLines } from "../utils.js";
import { loadHashStore, type HashStore } from "../hash-store.js";
import { contentChecksum, initHasher } from "./hasher.js";
import { lineHashesPure, mapStableHashes } from "./pure.js";

/**
 * Persistence-aware hash-anchor assignment: the pure hasher
 * ({@link lineHashesPure} / {@link mapStableHashes} in ./pure.js) composed
 * with snapshot load/upsert in the hash store, keyed by
 * (path, content checksum, line count). Without a `path` this never touches
 * the store and is exactly the pure path. With `previous` the stable re-hash
 * mapping keeps surviving anchors stable across edits.
 */
export async function lineHashes(
  content: string,
  path?: string,
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> },
  store?: HashStore,
  persist?: boolean,
): Promise<string[]> {
  await initHasher();
  if (!path) {
    return lineHashesPure(content);
  }

  const hashStore = store ?? await loadHashStore();

  if (previous) {
    const newHashes = mapStableHashes(
      previous.content, previous.hashes,
      content,
      previous.removedHashes,
    );
    if (persist !== false) {
      try {
        hashStore.upsertSnapshot(path, contentChecksum(content), splitLines(content).length, newHashes);
      } catch (error) {
        console.error("Failed to persist hash snapshot:", error);
      }
    }
    return newHashes;
  }

  let cached: string[] | undefined;
  try {
    cached = hashStore.getSnapshot(path, content, persist !== false);
  } catch (error) {
    console.error("Failed to read hash store snapshot:", error);
  }
  if (cached) {
    return cached;
  }

  const newHashes = lineHashesPure(content);
  if (persist !== false) {
    try {
      hashStore.upsertSnapshot(path, contentChecksum(content), splitLines(content).length, newHashes);
    } catch (error) {
      console.error("Failed to persist hash snapshot:", error);
    }
  }
  return newHashes;
}
