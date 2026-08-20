/**
 * AnchorPipeline — deep module owning the anchor autofix chain.
 *
 * Single ordering invariant (private):
 *   swapReversed → stripBare → stripDiff → valEdit → boundaryDups splice → valEdit → verifyServed → resToSpan
 *
 * Detection (valEdit → boundaryDups[]) and correction (splice + second valEdit)
 * were split across resolve.ts / apply.ts with an implicit coupling.
 * This seam co-locates that invariant. Public surface is two functions:
 *   resEdit  — pre-validation (tool-layer, no file state)
 *   applyEdit — full pipeline (file + hashes + served verification)
 *
 * Private to this seam (not re-exported): stripBarePrefixes, stripDiffPrefixes,
 * swapReversedRanges, valEdit, boundaryDups helpers, warnUnicodeEsc, findNewEdge.
 * They remain exported from resolve.ts for backwards compat but are marked
 * @internal and should be imported via this module only.
 *
 * @module dsh-better-edit/hashline/anchor-pipeline
 */

export { resEdit } from "./resolve.js";
export type { HEdit, HTEdit, NEdit, BDup, AutoFix } from "./resolve.js";

export { applyEdit, fmtRegion, changedRange, buildIdx } from "./apply.js";
export type { Anchor } from "./parse.js";
export { parseHashRef, parseText } from "./parse.js";

export {
 ServedRejectionError,
 AnchorMismatchError,
 isServedRejection,
 isAnchorMismatch,
 verifyServedRange,
 buildRangeEcho,
 fmtServedRows,
} from "./served.js";
export type { ServedRow, ResolvedRange, ServedCode } from "./served.js";
