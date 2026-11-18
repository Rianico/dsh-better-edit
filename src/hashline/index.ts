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

export { parseHashRef, parseText } from "./anchor-pipeline.js";
export type { Anchor } from "./anchor-pipeline.js";

export { resEdit } from "./anchor-pipeline.js";
export type { HEdit, HTEdit, NEdit } from "./anchor-pipeline.js";

export {
  applyEdit,
  fmtRegion,
  changedRange,
  buildIdx,
  AnchorMismatchError,
  EditHashEchoError,
  findEditHashEcho,
  isAnchorMismatch,
} from "./anchor-pipeline.js";
export type { ServedRow } from "./anchor-pipeline.js";

// Read-side served evidence (ADR-0037) — re-exported here so the barrel stays the one
// external surface; `ServedRow` keeps coming from anchor-pipeline's domain-errors re-export.
export {
  ServedRejectionError,
  verifyServedRange,
  verifyRebasedSpan,
  buildRangeEcho,
  fmtServedRows,
  moreRowsHint,
} from "./served-evidence.js";
export type { ResolvedRange, LeaseSpanSource, LeaseIdentityView } from "./served-evidence.js";
