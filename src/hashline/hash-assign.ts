/**
 * HashAssign — deep module owning hash assignment.
 *
 * Owns the `HASH_SPACE = 62^3` allocation invariant: every line of a file
 * gets a unique 3-char anchor derived from canonicalized content via xxHash
 * + probe-stride allocation. The triad `alphabet + hasher + pure + hash`
 * is interdependent; this seam hides that coupling.
 *
 * Private internals (not re-exported as public API): ALPH, idxToHash/hashAt,
 * nextZeroBit/assignHash, getBit/setBit, hashToIndex/nearestNew, xxh32 internals.
 * Callers use the deep interface below — one test surface for determinism +
 * stable mapping + persistence.
 *
 * @module dsh-better-edit/hashline/hash-assign
 */

// --- re-exports from the underlying files (canonical surface is this module) ---
export {
 ANCHOR_LEN,
 HASH_SEP,
 HASH_SPACE,
 HASH_PROBE_STRIDE,
 MAX_HASH_LINES,
 HL_PREFIX_PLUS_RE,
 HL_PREFIX_MINUS_RE,
 HL_BARE_PREFIX_RE,
 ALPH_RE,
 HASH_CLASS,
 HASH_LEN,
 canon,
 lineHashesPure,
 mapStableHashes,
 initHasher,
} from "./pure.js";

export { HASH_RE } from "./alphabet.js";
export { contentChecksum } from "./hasher.js";
export { lineHashes } from "./hash.js";
