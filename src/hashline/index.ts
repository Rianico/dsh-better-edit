/**
 * Hashline barrel — thin re-export via deep seams.
 * Deep seams: hash-assign (allocation), anchor-pipeline (ordering), hash (persistence).
 * @module dsh-better-edit/hashline
 */
export {
 CANON_VERSION,
 ANCHOR_LEN,
 HASH_SEP,
 HASH_SPACE,
 HASH_PROBE_STRIDE,
 MAX_HASH_LINES,
 HASH_LEN,
 HASH_CLASS,
 HASH_RE,
 ALPH_RE,
 HL_PREFIX_PLUS_RE,
 HL_PREFIX_MINUS_RE,
 HL_BARE_PREFIX_RE,
 canon,
 lineHashesPure,
 mapStableHashes,
 initHasher,
 contentChecksum,
} from "./hash-assign.js";

export { lineHashes } from "./hash.js";

export { parseHashRef, parseText } from "./parse.js";
export type { Anchor } from "./parse.js";

export { resEdit } from "./anchor-pipeline.js";
export type { HEdit, HTEdit, NEdit, BDup, AutoFix } from "./anchor-pipeline.js";

export {
 applyEdit,
 fmtRegion,
 changedRange,
 buildIdx,
 ServedRejectionError,
 AnchorMismatchError,
 isServedRejection,
 isAnchorMismatch,
 verifyServedRange,
 buildRangeEcho,
 fmtServedRows,
} from "./anchor-pipeline.js";
export type {
 ServedRow,
 ResolvedRange,
 ServedCode,
} from "./anchor-pipeline.js";
