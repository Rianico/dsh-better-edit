/**
 * Mutation — deep module owning the full file mutation lifecycle.
 *
 * Previously fragmented: tool-edit → edit-pipeline → edit-engine.applyOne →
 * edit-response/diff/drift, and tool-batch-edit → edit-engine.runFileEdits
 * (loop + unionRange + counters) → persistUndoAndWrite with a boolean flag.
 * Warnings, hadUtf8DecodeErrors, firstChangedLine, driftNotice were threaded
 * by mutation across 5 hops; bugs hid in wiring, not pure helpers.
 *
 * This seam owns: read → normalize → loadServed → applyOne* → stableRehash →
 * drift → persist. Tools become thin adapters: validate → delegate → render.
 * edit-diff, drift, noop-guard are private helpers of this seam.
 *
 * Public surface:
 *   applySingle(io, params, {cwd, sessionKey, signal}) → MutationFile
 *   applySequence(io, items, {cwd, sessionKey, signal}) → MutationFile[]
 *   commit(io, files, {exec, sandboxPolicy, signal}) → void
 *
 * Internals (private): verifyServedRange, resToSpan, assemble, scanDrift,
 * boundaryDups, noopGuard. Tested via MutationFile, not via split e2e.
 *
 * @module dsh-better-edit/mutation
 */

export { execPipeline, snapshotIdFor } from "./edit-pipeline.js";
export type { PipelineResult } from "./edit-pipeline.js";

export {
 runFileEdits,
 resolveMissingPath,
 persistUndoAndWrite,
 enforceNoopLoop,
 collectRemovedHashes,
 countLineChanges,
} from "./edit-engine.js";
export type { FileEditResult, PreparedItem } from "./edit-engine.js";

export {
 buildMetrics,
 buildNoop,
 buildChanged,
 buildBatchResult,
} from "./edit-response.js";
export type { RMeta, BatchSection } from "./edit-response.js";

export { genDiff, restoreEndings, toLF, stripBOM } from "./edit-diff.js";
export { computeDrift, scanDrift } from "./drift.js";
export {
 trackNoopPayload,
 clearNoopLoop,
 noopPayloadKey,
} from "./noop-guard.js";

// Deep seam facade: the ordering invariant lives here even though the current
// implementation still delegates to the underlying modules. Future refactor
// will inline execPipeline + runFileEdits + persistUndoAndWrite behind
// applySingle/applySequence/commit without changing callers.
