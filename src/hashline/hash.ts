/**
 * Hash persistence — deep persistence wrapper for HashAssign.
 * Private to HashAssign seam; use `from "./hash-assign.js"` for pure APIs
 * and `from "./hash.js"` only for persistence-aware lineHashes.
 * Now imports pure APIs from hash-assign (no circular).
 * Hash line purity seam: lineHashes takes HashSnapshotIO injection so hash.ts
 * is the only place that touches the DB — hash-assign stays pure.
 * @module dsh-better-edit/hashline/hash
 */
import { splitLines } from "../utils.js";
import { loadHashStore, type HashStore } from "../hash-store.js";
import { contentChecksum, initHasher, HASH_RE } from "./hash-assign.js";
import { lineHashesPure, mapStableHashes } from "./hash-assign.js";

export interface HashSnapshotIO {
  get(path: string, content: string, deleteCorrupt: boolean): Promise<string[] | undefined>;
  upsert(path: string, checksum: string, lineCount: number, hashes: string[]): Promise<void>;
}

let defaultHashSnapshotIO: HashSnapshotIO | undefined;

export function setDefaultHashSnapshotIO(io: HashSnapshotIO | undefined): void {
  defaultHashSnapshotIO = io;
}

export function snapshotIOFor(store?: HashStore): HashSnapshotIO | undefined {
  if (store) {
    return {
      get: (path, content, deleteCorrupt) => Promise.resolve(store.getSnapshot(path, content, deleteCorrupt)),
      upsert: (path, checksum, lineCount, hashes) => {
        store.upsertSnapshot(path, checksum, lineCount, hashes);
        return Promise.resolve();
      },
    };
  }
  return defaultHashSnapshotIO ?? {
    get: async (path, content, deleteCorrupt) => {
      const s = await loadHashStore();
      return s.getSnapshot(path, content, deleteCorrupt);
    },
    upsert: async (path, checksum, lineCount, hashes) => {
      const s = await loadHashStore();
      s.upsertSnapshot(path, checksum, lineCount, hashes);
    },
  };
}

export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  return true;
}

export async function lineHashes(
  content: string,
  path?: string,
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> },
  ioOrStore?: HashStore | HashSnapshotIO,
  persist?: boolean,
  reservedHashes: ReadonlySet<string> = new Set(),
  retiredHashes: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  await initHasher();
  if (!path) return lineHashesPure(content, reservedHashes);

  // Back-compat: caller may pass HashStore as 4th arg; adapt to IO.
  const io: HashSnapshotIO | undefined =
    ioOrStore && "getSnapshot" in ioOrStore
      ? snapshotIOFor(ioOrStore as HashStore)
      : (ioOrStore as HashSnapshotIO | undefined) ?? snapshotIOFor(undefined);

  if (previous) {
    const newHashes = mapStableHashes(
      previous.content,
      previous.hashes,
      content,
      previous.removedHashes,
      reservedHashes,
    );
    if (persist !== false && io) {
      try {
        await io.upsert(path, contentChecksum(content), splitLines(content).length, newHashes);
      } catch (e) {
        console.error("Failed to persist hash snapshot:", e);
      }
    }
    return newHashes;
  }
  let cached: string[] | undefined;
  if (io) {
    try {
      cached = await io.get(path, content, persist !== false);
    } catch (e) {
      console.error("Failed to read hash store snapshot:", e);
    }
  }
  if (cached && !cached.some((hash) => retiredHashes.has(hash))) return cached;
  const newHashes = lineHashesPure(content, reservedHashes);
  if (persist !== false && io) {
    try {
      await io.upsert(path, contentChecksum(content), splitLines(content).length, newHashes);
    } catch (e) {
      console.error("Failed to persist hash snapshot:", e);
    }
  }
  return newHashes;
}
