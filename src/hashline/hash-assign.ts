/**
 * HashAssign — deep module owning hash assignment.
 *
 * Owns the `HASH_SPACE = 62^3` allocation invariant: every line gets a unique
 * 3-char anchor derived from canonicalized content via xxHash + probe-stride.
 * Previously split across alphabet.ts (ALPH), hasher.ts (xxh32), pure.ts
 * (lineHashesPure/mapStableHashes), hash.ts (lineHashes persistence).
 * Now one file owns the triad — ALPH/xxh32/hashAt are private to this seam.
 *
 * Callers use this seam's public surface: lineHashesPure, mapStableHashes,
 * lineHashes, canon, HASH_SEP, etc. Deleting this module would scatter the
 * allocation invariant across 4 files — it concentrates.
 *
 * @module dsh-better-edit/hashline/hash-assign
 */
import xxhash from "xxhash-wasm";
import { splitLines } from "../utils.js";
import { DomainError } from "../domain-errors.js";

// --- hasher (private to this seam) ---
export type Hasher = {
  h32(input: string, seed?: number): number;
  h64ToString(input: string, seed?: bigint): string;
};
let hasher: Hasher | null = null;
export function getH(): Hasher {
  if (hasher) return hasher;
  throw new Error(
    "xxhash-wasm hasher not initialized; await initHasher() before calling hashline APIs.",
  );
}
const hasherP: Promise<Hasher> = xxhash()
  .then((h) => {
    // SAFETY: `xxhash()` resolves the package's own hasher object, whose declaration types the
    // wider lazy-loaded API surface; the assertion narrows it to the two methods `getH()` exposes.
    hasher = h as unknown as Hasher;
    return hasher;
  })
  .catch((err: unknown) => {
    console.error("xxhash-wasm initialization failed:", err);
    throw err;
  });
export function initHasher(): Promise<Hasher> {
  return hasherP;
}
export function xxh32(input: string, seed = 0): number {
  return getH().h32(input, seed) >>> 0;
}
export function contentChecksum(content: string): string {
  return getH().h64ToString(content);
}

// --- alphabet (private to this seam) ---
export const HASH_LEN = 3;
export const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ALPH_SAFE = ALPH.replace(/-/g, "\\-");
export const ALPH_RE = new RegExp(`^[${ALPH_SAFE}]+$`);
export const HASH_CLASS = `[${ALPH_SAFE}]{${HASH_LEN}}`;
export const HASH_RE = new RegExp(`^${HASH_CLASS}$`);

// --- pure (allocation invariant) ---
export const ANCHOR_LEN = HASH_LEN;
export const HASH_SEP = "│";
export const HASH_SPACE = ALPH.length ** HASH_LEN;
// MAX_HASH_LINES is the anchor-space size (62³), not a line-count limit.
// File line-count limits use maxLines (e.g. 200k) and report E_LARGE_FILE;
// anchor-space exhaustion reports E_LARGE_FILE with limitKind "hash-space" — see nextZeroBit.
export const MAX_HASH_LINES = HASH_SPACE;
export const HASH_PROBE_STRIDE = ALPH.length ** 2 + ALPH.length + 1;

export class AnchorSpaceExhaustedError extends DomainError<"E_LARGE_FILE"> {
  readonly retiredCount: number;
  readonly servedCount: number;
  // F10.3: reserved count removed — the registry payload carries the limit,
  // not the probe state.
  constructor(retiredCount: number, servedCount: number) {
    // Channel rule: hard capacity refusal the model must route around → MODEL via the registry.
    super("E_LARGE_FILE", { limitKind: "hash-space", limit: HASH_SPACE });
    this.name = "AnchorSpaceExhaustedError";
    this.retiredCount = retiredCount;
    this.servedCount = servedCount;
  }
}

/**
 * The ONE anchor-space-exhaustion test, owned by the error's own module: "is this
 * exhaustion?" (a typing question).
 *
 * WHY single: the classification lives beside the error it classifies, and no site keeps a private
 * copy — the two translate blocks below ask exactly this question, and the promotion sites ask its
 * strict subset (`isPromotableAnchorSpaceExhaustion`). Each of the five sites used to carry its own
 * copy (or an inline variant) of the test; a rewording of the allocator's probe message in one copy
 * would silently change a decision at the others, and the failure mode is a raw `Error` reaching
 * the model instead of the typed refusal.
 *
 * Members: the typed `AnchorSpaceExhaustedError` (already translated), the allocator wording
 * `nextZeroBit` raises when the probe wraps the whole space ("probing failed over"), and that
 * same refusal's formatted headline ("Cannot allocate a unique hash anchor", which survives a
 * re-wrap that costs the error its class).
 */
export function isAnchorSpaceExhaustion(e: unknown): boolean {
  if (e instanceof AnchorSpaceExhaustedError) return true;
  return (
    e instanceof Error &&
    (e.message.includes("probing failed over") || e.message.includes("Cannot allocate"))
  );
}

/**
 * Promotion's narrower question: is this an exhaustion that clearing retired anchors and
 * retrying could actually cure?
 *
 * WHY a second predicate, not the one above: `isAnchorSpaceExhaustion` answers "is this
 * exhaustion" — a typing question, asked by the two translate blocks that must turn any
 * allocator wording into the typed `E_LARGE_FILE`. Promotion asks a different question, and the
 * two answers differ on every refusal whose subject is the file's line count rather than the
 * anchor space: exhaustion and the line cap are the same diagnosis (a file too long to hash),
 * but promotion cannot out-grow the line cap, because the retry re-reads the same oversized file
 * and throws the identical error — with this `(session, path)`'s retired anchors now cleared, so
 * the failed read has also degraded its own stale-anchor checks. "Can promotion help?" is
 * therefore the strict subset: the probe wrapping the whole space.
 *
 * The line cap is a capacity refusal, never an identity one, and its wording is not the hash-space
 * one: `eLargeFileMsg` formats with `limitKind: "lines"` ("<path> has N lines, exceeding the
 * N-line limit"), so `isAnchorSpaceExhaustion` already declines it; "Cannot allocate a unique hash
 * anchor" is `AnchorSpaceExhaustedError`'s own headline, reachable as message-only text on a
 * re-wrap. Declining both keeps promotion off every refusal a retry cannot out-grow, and leaves
 * the line cap free to be re-formatted through the hash-space wording without promotion silently
 * becoming a hazard-clear.
 */
export function isPromotableAnchorSpaceExhaustion(e: unknown): boolean {
  if (e instanceof AnchorSpaceExhaustedError) return true;
  return e instanceof Error && e.message.includes("probing failed over");
}

export function idxToHash(idx: number): string {
  let out = "";
  for (let j = 0; j < HASH_LEN; j++) {
    out = ALPH[idx % ALPH.length]! + out;
    idx = Math.floor(idx / ALPH.length);
  }
  return out;
}
const hashCache = new Map<number, string>();
export function hashAt(idx: number): string {
  let hash = hashCache.get(idx);
  if (hash === undefined) {
    hash = idxToHash(idx);
    hashCache.set(idx, hash);
  }
  return hash;
}

export const HL_PREFIX_PLUS_RE = new RegExp(`^\\+${HASH_CLASS}│`);
export const HL_PREFIX_MINUS_RE = new RegExp(`^-(?:${HASH_CLASS}│| {${ANCHOR_LEN}}│)`);
export const HL_BARE_PREFIX_RE = new RegExp(`^\\s*(${HASH_CLASS})│`);

export const CANON_VERSION = 2;

const CANON_RE = /[ \t\r\n]+/g;

export function canon(line: string): string {
  return line.replace(CANON_RE, "");
}
/** Single definition of served_leases.canon_hash / line_lineage.canon_hash (CP2). */
export function canonDigest(line: string): string {
  return String(xxh32(canon(line)));
}

function getCanon(cache: Map<string, string>, line: string): string {
  let v = cache.get(line);
  if (v !== undefined) return v;
  v = canon(line);
  cache.set(line, v);
  return v;
}
const BITSET_WORDS = Math.ceil(HASH_SPACE / 32);
function getBit(bits: Uint32Array, idx: number): boolean {
  return ((bits[idx >>> 5] >>> (idx & 31)) & 1) !== 0;
}
function setBit(bits: Uint32Array, idx: number): void {
  bits[idx >>> 5] |= 1 << (idx & 31);
}
function nextZeroBit(bits: Uint32Array, start: number): number {
  const totalBits = HASH_SPACE;
  let idx = start % totalBits;
  for (let i = 0; i < totalBits; i++) {
    if (!getBit(bits, idx)) return idx;
    idx += HASH_PROBE_STRIDE;
    if (idx >= totalBits) idx -= totalBits;
  }
  throw new Error(
    `Anchor space exhausted — probing failed over ${HASH_SPACE} slots (reserved full).`,
  );
}
function assignHash(used: Uint32Array, baseIdx: number, hint: { value: number }): string {
  if (!getBit(used, baseIdx)) {
    setBit(used, baseIdx);
    hint.value = baseIdx + HASH_PROBE_STRIDE;
    return hashAt(baseIdx);
  }
  const nextIdx = nextZeroBit(used, hint.value);
  setBit(used, nextIdx);
  hint.value = nextIdx + HASH_PROBE_STRIDE;
  return hashAt(nextIdx);
}
export function lineHashesPure(
  content: string,
  reservedHashes: ReadonlySet<string> = new Set(),
  // optional counts for richer error — when caller knows retired vs served split
  retiredCount?: number,
  servedCount?: number,
): string[] {
  const lines = splitLines(content);
  const hashes = new Array<string>(lines.length);
  const used = new Uint32Array(BITSET_WORDS);
  for (const hash of reservedHashes) markHashUsed(used, hash);
  const hint = { value: 0 };
  const canonCache = new Map<string, string>();
  try {
    for (let i = 0; i < lines.length; i++) {
      const c = getCanon(canonCache, lines[i]!);
      const baseIdx = (xxh32(c) >>> 14) % HASH_SPACE;
      const h = assignHash(used, baseIdx, hint);
      hashes[i] = h;
    }
  } catch (e: unknown) {
    // Rethrow identity: an already-typed exhaustion keeps its counts untouched.
    if (e instanceof AnchorSpaceExhaustedError) throw e;
    if (isAnchorSpaceExhaustion(e)) {
      const rc = retiredCount ?? reservedHashes.size;
      const sc = servedCount ?? 0;
      throw new AnchorSpaceExhaustedError(rc, sc);
    }
    throw e;
  }
  return hashes;
}
function hashToIndex(hash: string): number {
  let idx = 0;
  for (let j = 0; j < HASH_LEN; j++) {
    const charIdx = ALPH.indexOf(hash[j]!);
    if (charIdx < 0) return -1;
    idx = idx * ALPH.length + charIdx;
  }
  return idx;
}
function nearestNew(candidates: number[], target: number): number {
  let lo = 0;
  let hi = candidates.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candidates[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  const left = lo - 1;
  const right = lo;
  if (
    left >= 0 &&
    (right >= candidates.length || target - candidates[left]! <= candidates[right]! - target)
  ) {
    return left;
  }
  return right < candidates.length ? right : -1;
}
export function mapStableHashes(
  oldContent: string,
  oldHashes: string[],
  newContent: string,
  removedHashes?: Set<string>,
  reservedHashes: ReadonlySet<string> = new Set(),
  retiredCount?: number,
  servedCount?: number,
): string[] {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const newHashes = new Array<string>(newLines.length);
  const used = new Uint32Array(BITSET_WORDS);
  const hint = { value: 0 };
  const canonCache = new Map<string, string>();
  const removed = removedHashes ?? new Set<string>();
  const blocked = new Set(reservedHashes);
  for (const hash of removed) blocked.add(hash);
  const oldHashIndex = new Map<string, number>();
  for (let i = 0; i < oldHashes.length; i++) {
    const hash = oldHashes[i]!;
    oldHashIndex.set(hash, i);
    const idx = hashToIndex(hash);
    if (idx >= 0) setBit(used, idx);
  }
  const removedIndexes = new Set<number>();
  for (const hash of removed) {
    const idx = oldHashIndex.get(hash);
    if (idx !== undefined) removedIndexes.add(idx);
  }
  for (const hash of blocked) markHashUsed(used, hash);
  let spanStart = oldLines.length;
  let spanEnd = -1;
  for (const idx of removedIndexes) {
    if (idx < spanStart) spanStart = idx;
    if (idx > spanEnd) spanEnd = idx;
  }
  const spanLen = spanEnd >= spanStart ? spanEnd - spanStart + 1 : 0;
  const replacementLen = newLines.length - oldLines.length + spanLen;
  const shiftAfterSpan = spanEnd >= spanStart ? replacementLen - spanLen : 0;
  const survivors: { index: number; hash: string }[] = [];
  for (let i = 0; i < oldLines.length; i++) {
    const entry = { index: i, hash: oldHashes[i]! };
    if (!removedIndexes.has(i)) survivors.push(entry);
  }
  const newByContent = new Map<string, number[]>();
  for (let i = 0; i < newLines.length; i++) {
    const key = getCanon(canonCache, newLines[i]!);
    const list = newByContent.get(key);
    if (list) list.push(i);
    else newByContent.set(key, [i]);
  }
  const markUsed = (hash: string): void => {
    const idx = hashToIndex(hash);
    if (idx >= 0) {
      setBit(used, idx);
      if (idx + HASH_PROBE_STRIDE > hint.value) hint.value = idx + HASH_PROBE_STRIDE;
    }
  };
  for (const entry of survivors) {
    const candidates = newByContent.get(getCanon(canonCache, oldLines[entry.index]!));
    if (!candidates || candidates.length === 0) continue;
    const target = entry.index > spanEnd ? entry.index + shiftAfterSpan : entry.index;
    const pos = nearestNew(candidates, target);
    if (pos < 0) continue;
    const newIdx = candidates.splice(pos, 1)[0]!;
    newHashes[newIdx] = entry.hash;
    markUsed(entry.hash);
  }
  try {
    for (let i = 0; i < newLines.length; i++) {
      if (newHashes[i]) continue;
      const c = getCanon(canonCache, newLines[i]!);
      const baseIdx = (xxh32(c) >>> 14) % HASH_SPACE;
      const h = assignHash(used, baseIdx, hint);
      newHashes[i] = h;
    }
  } catch (e: unknown) {
    // Rethrow identity: an already-typed exhaustion keeps its counts untouched.
    if (e instanceof AnchorSpaceExhaustedError) throw e;
    if (isAnchorSpaceExhaustion(e)) {
      const rc = retiredCount ?? reservedHashes.size;
      const sc = servedCount ?? 0;
      throw new AnchorSpaceExhaustedError(rc, sc);
    }
    throw e;
  }
  return newHashes;
}

function markHashUsed(used: Uint32Array, hash: string): void {
  const idx = hashToIndex(hash);
  if (idx >= 0) setBit(used, idx);
}

// --- persistence wrapper (from hash.ts) ---
