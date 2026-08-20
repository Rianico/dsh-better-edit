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
 *   applySingle(io, params, {cwd, sessionKey, signal}) → PipelineResult
 *   applySequence(io, items, {cwd, sessionKey, signal}) → FileEditResult[]
 *   commit(io, files, {exec, sandboxPolicy, signal}) → void
 *
 * Internals (private): verifyServedRange, resToSpan, assemble, scanDrift,
 * boundaryDups, noopGuard. Tested via PipelineResult/FileEditResult, not via split e2e.
 *
 * @module dsh-better-edit/mutation
 */

import type { FileIO } from "./fs-bridge.js";
import type { EditParams } from "./contract.js";
import type { HashStore } from "./hash-store.js";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { FsSandboxController } from "./sandbox.js";

import { execPipeline, snapshotIdFor } from "./edit-pipeline.js";
import type { PipelineResult } from "./edit-pipeline.js";
import {
  runFileEdits,
  resolveMissingPath,
  persistUndoAndWrite,
  enforceNoopLoop,
  collectRemovedHashes,
  countLineChanges,
} from "./edit-engine.js";
import type { FileEditResult, PreparedItem } from "./edit-engine.js";
import { buildMetrics, buildNoop, buildChanged, buildBatchResult } from "./edit-response.js";
import type { RMeta, BatchSection } from "./edit-response.js";
import { genDiff, restoreEndings, toLF, stripBOM } from "./edit-diff.js";
import { computeDrift, scanDrift } from "./drift.js";
import { trackNoopPayload, clearNoopLoop, noopPayloadKey } from "./noop-guard.js";

// Re-exports for callers that need the underlying types/helpers
export { execPipeline, snapshotIdFor };
export type { PipelineResult };
export { runFileEdits, resolveMissingPath, persistUndoAndWrite, enforceNoopLoop, collectRemovedHashes, countLineChanges };
export type { FileEditResult, PreparedItem };
export { buildMetrics, buildNoop, buildChanged, buildBatchResult };
export type { RMeta, BatchSection };
export { genDiff, restoreEndings, toLF, stripBOM };
export { computeDrift, scanDrift };
export { trackNoopPayload, clearNoopLoop, noopPayloadKey };

// --- Deep seam: unified mutation API (one interface, twoAdapters) ---

/** Apply a single edit — owns read→normalize→loadServed→applyOne→stableRehash→drift. */
export async function applySingle(
  io: FileIO,
  params: EditParams,
  cwd: string,
  opts?: { sessionKey?: string; signal?: AbortSignal; store?: HashStore; noPersist?: boolean },
): Promise<PipelineResult> {
  return execPipeline(io, params, cwd, opts);
}

/** Apply a per-file sequence (batch's group) — owns the loop + unionRange + counters. */
export async function applySequence(
  io: FileIO,
  items: PreparedItem[],
  ctx: { sessionKey: string; signal?: AbortSignal },
): Promise<FileEditResult> {
  return runFileEdits(io, items, ctx);
}

/** Commit the transaction — owns persist-undo → write → restore. */
export async function commit(opts: {
  io: FileIO;
  files: Array<{
    absolutePath: string;
    displayPath: string;
    originalNormalized: string;
    bom: string;
    originalEnding: import("./edit-diff.js").LineEnding;
    originalHashes: string[];
    result: string;
  }>;
  exec: ToolExecution;
  sandbox: FsSandboxController;
  sandboxPolicy: SandboxExecutionPolicy | undefined;
  signal?: AbortSignal;
  undoUnavailableMessage: (displayPath: string) => string;
  restoreUnwrittenUndos?: boolean;
}): Promise<void> {
  return persistUndoAndWrite({
    io: opts.io,
    files: opts.files,
    exec: opts.exec,
    sandbox: opts.sandbox,
    sandboxPolicy: opts.sandboxPolicy,
    signal: opts.signal,
    undoUnavailableMessage: opts.undoUnavailableMessage,
    restoreUnwrittenUndos: opts.restoreUnwrittenUndos,
  });
}
