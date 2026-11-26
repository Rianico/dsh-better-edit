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
import {
  canonDigest,
  lineHashesAligned,
  lineHashesPure,
  mapStableHashes,
  rawDigest,
} from "./hash-assign.js";
import { pairLineage, type LineageLine } from "../snapshot-store/pairing.js";
import type { LineageRow } from "../snapshot-store/lineage-store.js";

export interface HashSnapshotIO {
  get(path: string, content: string, deleteCorrupt: boolean): Promise<string[] | undefined>;
  upsert(
    path: string,
    checksum: string,
    lineCount: number,
    hashes: string[],
    content?: string,
  ): Promise<void>;
  /**
   * The newest committed lineage for `path`, or `undefined` when the path has no usable prior
   * lineage — the evidence the checksum-miss alignment pairs against. Optional: an IO without it
   * (a test double, or a store with no lineage family) simply cannot align, and the read falls
   * back to fresh allocation. A rejection is treated the same way, never surfaced to the model.
   */
  latestLineage?(path: string): Promise<LineageRow[] | undefined>;
}

let defaultHashSnapshotIO: HashSnapshotIO | undefined;

export function setDefaultHashSnapshotIO(io: HashSnapshotIO | undefined): void {
  defaultHashSnapshotIO = io;
}

export function snapshotIOFor(store?: HashStore): HashSnapshotIO | undefined {
  if (store) {
    return {
      get: (path, content, deleteCorrupt) =>
        Promise.resolve(store.getSnapshot(path, content, deleteCorrupt)),
      upsert: (path, checksum, lineCount, hashes, content?) => {
        store.upsertSnapshot(path, checksum, lineCount, hashes, content);
        return Promise.resolve();
      },
      latestLineage: async (path) => store.latestLineageFor(path),
    };
  }
  return (
    defaultHashSnapshotIO ?? {
      get: async (path, content, deleteCorrupt) => {
        const s = await loadHashStore();
        return s.getSnapshot(path, content, deleteCorrupt);
      },
      upsert: async (path, checksum, lineCount, hashes, content?) => {
        const s = await loadHashStore();
        s.upsertSnapshot(path, checksum, lineCount, hashes, content);
      },
      latestLineage: async (path) => {
        const s = await loadHashStore();
        return s.latestLineageFor(path);
      },
    }
  );
}

export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  return true;
}

export interface LineageAlignment {
  hashes: string[];
  /** Prior anchors the alignment retired: the line they named paired with nothing in `content`. */
  retired: Set<string>;
}

/**
 * Align `content` against the latest committed lineage — the checksum-miss half of a read.
 *
 * `pairLineage` decides what both sides can prove: a paired line keeps the exact anchor it was
 * served under, and every unpaired line allocates fresh (fail-closed — an ambiguous interval
 * retires rather than guessing a coordinate). A prior anchor whose CANON occurs more than once in
 * the lineage stays blocked from fresh allocation even when its own line retired, so a fresh
 * duplicate can never reclaim a retired twin's spelling; a canon seen once stays free, so a pure
 * reorder never rotates unchanged bytes.
 */
export function alignToLatestLineage(
  content: string,
  latest: readonly LineageRow[],
  reservedHashes: ReadonlySet<string> = new Set(),
  reservedCount?: number,
  servedCount?: number,
): LineageAlignment {
  const lines = splitLines(content);
  const prev: LineageLine[] = latest.map((row) => ({
    lineNumber: row.lineNumber,
    canonHash: row.canonHash,
    rawHash: row.rawHash,
  }));
  const curr: LineageLine[] = lines.map((line, index) => ({
    lineNumber: index + 1,
    canonHash: canonDigest(line),
    rawHash: rawDigest(line),
  }));
  const pairing = pairLineage(prev, curr);

  const byLineNumber = new Map(latest.map((row) => [row.lineNumber, row]));
  const carried = new Map<number, string>();
  const pairedPrev = new Set<number>();
  for (const [prevLine, currLine] of pairing) {
    const row = byLineNumber.get(prevLine);
    if (row === undefined || !HASH_RE.test(row.anchor)) continue;
    carried.set(currLine, row.anchor);
    pairedPrev.add(prevLine);
  }

  const seenCanons = new Set<string>();
  const twinCanons = new Set<string>();
  for (const row of latest) {
    if (seenCanons.has(row.canonHash)) twinCanons.add(row.canonHash);
    else seenCanons.add(row.canonHash);
  }
  const blocked = new Set<string>(reservedHashes);
  for (const row of latest) {
    if (!HASH_RE.test(row.anchor)) continue;
    if (pairedPrev.has(row.lineNumber) || twinCanons.has(row.canonHash)) blocked.add(row.anchor);
  }

  const liveAnchors = new Set(carried.values());
  const retired = new Set<string>();
  for (const row of latest) {
    if (pairedPrev.has(row.lineNumber)) continue;
    if (!HASH_RE.test(row.anchor) || liveAnchors.has(row.anchor)) continue;
    retired.add(row.anchor);
  }

  return {
    hashes: lineHashesAligned(content, carried, blocked, reservedCount, servedCount),
    retired,
  };
}

/** Best-effort prior-lineage read: a missing capability, an absent family, or a store fault loses the alignment, never the read. */
async function readLatestLineage(
  io: HashSnapshotIO | undefined,
  path: string,
): Promise<LineageRow[] | undefined> {
  if (io?.latestLineage === undefined) return undefined;
  try {
    const latest = await io.latestLineage(path);
    return latest !== undefined && latest.length > 0 ? latest : undefined;
  } catch (error) {
    console.error("Failed to read the latest lineage for alignment:", error);
    return undefined;
  }
}

export interface HashAlignmentOptions {
  /**
   * Opt in to the checksum-miss lineage alignment. The READ path sets it (`readView` through
   * `normFromText`); every other caller — the edit pipeline's working-buffer re-derivation in
   * particular — keeps the fresh allocation it has always had, so the write path's anchor identity
   * does not move until the identity union owns it.
   */
  enabled: boolean;
  /** OUT: prior anchors the alignment retired — the session layer persists them as retirement markers. */
  retired?: Set<string>;
}

export async function lineHashes(
  content: string,
  path?: string,
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> },
  ioOrStore?: HashStore | HashSnapshotIO,
  persist?: boolean,
  reservedHashes: ReadonlySet<string> = new Set(),
  retiredHashes: ReadonlySet<string> = new Set(),
  /** Opt in to (and collect from) the checksum-miss lineage alignment; absent means fresh allocation. */
  alignment?: HashAlignmentOptions,
): Promise<string[]> {
  await initHasher();
  if (!path) return lineHashesPure(content, reservedHashes);

  const io: HashSnapshotIO | undefined =
    ioOrStore && "getSnapshot" in ioOrStore
      ? snapshotIOFor(ioOrStore as HashStore)
      : ((ioOrStore as HashSnapshotIO | undefined) ?? snapshotIOFor(undefined));

  if (previous) {
    const newHashes = mapStableHashes(
      previous.content,
      previous.hashes,
      content,
      previous.removedHashes,
      reservedHashes,
      retiredHashes.size,
      previous.hashes.length,
    );
    if (persist !== false && io) {
      try {
        await io.upsert(
          path,
          contentChecksum(content),
          splitLines(content).length,
          newHashes,
          content,
        );
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
  const latest = alignment?.enabled === true ? await readLatestLineage(io, path) : undefined;
  const aligned =
    latest === undefined
      ? undefined
      : alignToLatestLineage(content, latest, reservedHashes, retiredHashes.size, 0);
  if (aligned !== undefined && alignment?.retired !== undefined) {
    for (const hash of aligned.retired) alignment.retired.add(hash);
  }
  const newHashes =
    aligned?.hashes ?? lineHashesPure(content, reservedHashes, retiredHashes.size, 0);
  if (persist !== false && io) {
    try {
      await io.upsert(
        path,
        contentChecksum(content),
        splitLines(content).length,
        newHashes,
        content,
      );
    } catch (e) {
      console.error("Failed to persist hash snapshot:", e);
    }
  }
  return newHashes;
}
