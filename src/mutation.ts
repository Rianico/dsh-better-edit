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
 * drift → persist → render. Tools become thin adapters: validate → delegate → return.
 * edit-diff, drift, noop-guard are private helpers of this seam.
 *
 * Public surface:
 *   execute(io, items, {sessionKey, exec, sandbox, signal}) → string  — deep seam: ONE interface
 *   applySequence(io, items, ctx) → FileEditResult                    — per-file sequencer
 *   commit(io, files, {exec, sandboxPolicy, signal}) → void           — transaction
 *
 * Depth: small interface (execute) with large implementation — locality and leverage.
 *
 * Internals (private): verifyServedRange, resToSpan, assemble, scanDrift,
 * boundaryDups, noopGuard. Tested via FileEditResult, not via split e2e.
 *
 * @module dsh-better-edit/mutation
 */

import type { FileIO } from "./fs-bridge.js";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { FsSandboxController } from "./sandbox.js";

import { formatError } from "./domain-errors.js";
import { canon } from "./hashline/hash-assign.js";
import { fileSnap } from "./file-reader.js";
import type { LineEnding } from "./edit-diff.js";
import { toCwd } from "./paths.js";
import { recordServedTruncated, scanDrift } from "./session-view.js";
import { abortIf, splitLines } from "./utils.js";
import { runFileEdits, resolveMissingPath } from "./mutation/engine.js";
import type { FileEditResult, PreparedItem } from "./mutation/engine.js";
import { saveUndo } from "./undo-edit.js";
import { restoreEndings } from "./edit-diff.js";
import { buildMetrics, buildNoop, buildChanged, buildBatchResult } from "./edit-response.js";
import type { RMeta, BatchSection } from "./edit-response.js";
import { genDiff, toLF, stripBOM } from "./edit-diff.js";
import { computeDrift } from "./session-view.js";
import { trackNoopPayload, clearNoopLoop, noopPayloadKey } from "./noop-guard.js";

/** Resolve the display path a caller names against the session cwd. */
export function resolveDisplayPath(path: string, cwd: string): string {
  return toCwd(path, cwd);
}

/** Snapshot bookkeeping for noop/success results (best-effort). */
export async function snapshotIdFor(
  io: FileIO,
  absolutePath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await io.statVersion(absolutePath, signal);
  } catch {
    try {
      return (await fileSnap(absolutePath)).snapshotId;
    } catch {
      return undefined;
    }
  }
}

// Engine helpers are private to Mutation — not re-exported for new code.
// Deprecated re-exports kept for existing tests (commitlint: ignore):
export { runFileEdits, resolveMissingPath };
export { persistUndoAndWrite };
export type { FileEditResult, PreparedItem };
export { buildMetrics, buildNoop, buildChanged, buildBatchResult };
export type { RMeta, BatchSection };
export { genDiff, restoreEndings, toLF, stripBOM };
export { computeDrift, scanDrift };
export { trackNoopPayload, clearNoopLoop, noopPayloadKey };

// ---------------------------------------------------------------------------
// Transaction (private to Mutation) — persist-undo → write → restore
// ---------------------------------------------------------------------------

interface UndoWriteFile {
  absolutePath: string;
  displayPath: string;
  originalNormalized: string;
  bom: string;
  originalEnding: LineEnding;
  originalHashes: string[];
  result: string;
}

interface PersistWriteOptions {
  io: FileIO;
  files: UndoWriteFile[];
  exec: ToolExecution;
  sandbox: FsSandboxController;
  sandboxPolicy: SandboxExecutionPolicy | undefined;
  signal?: AbortSignal;
  undoUnavailableMessage: (displayPath: string) => string;
  restoreUnwrittenUndos: boolean;
}

async function persistUndoAndWrite(opts: PersistWriteOptions): Promise<void> {
  const { io, files } = opts;
  const undos: Array<{
    file: UndoWriteFile;
    restore: () => Promise<void>;
  }> = [];
  for (const file of files) {
    const undo = await saveUndo(file.absolutePath, {
      content: file.originalNormalized,
      bom: file.bom,
      originalEnding: file.originalEnding,
      hashes: file.originalHashes,
      resultContent: file.result,
    });
    if (!undo.persisted) {
      for (const u of undos) {
        try {
          await u.restore();
        } catch (e) {
          console.error("Failed to restore undo entry after abort:", e);
        }
      }
      throw new Error(opts.undoUnavailableMessage(file.displayPath));
    }
    undos.push({ file, restore: undo.restore });
  }

  const written: typeof undos = [];
  try {
    for (const u of undos) {
      abortIf(opts.signal);
      await io.writeText(
        u.file.absolutePath,
        u.file.bom + restoreEndings(u.file.result, u.file.originalEnding),
        opts.signal,
        opts.exec,
        opts.sandboxPolicy,
      );
      written.push(u);
    }
  } catch (error) {
    for (const w of written) {
      try {
        await io.writeText(
          w.file.absolutePath,
          w.file.bom + restoreEndings(w.file.originalNormalized, w.file.originalEnding),
          undefined,
          opts.exec,
          opts.sandboxPolicy,
        );
      } catch (e) {
        console.error("Failed to restore file after write failure:", e);
      }
      try {
        await w.restore();
      } catch (e) {
        console.error("Failed to restore undo entry after write failure:", e);
      }
    }
    if (opts.restoreUnwrittenUndos) {
      for (const u of undos) {
        if (written.includes(u)) continue;
        try {
          await u.restore();
        } catch (e) {
          console.error("Failed to restore undo entry after write failure:", e);
        }
      }
    }
    throw opts.sandbox.mapError(error, opts.sandboxPolicy);
  }
}

async function commitSingle(
  opts: Omit<PersistWriteOptions, "restoreUnwrittenUndos">,
): Promise<void> {
  return persistUndoAndWrite({ ...opts, restoreUnwrittenUndos: true });
}

async function commitBatch(
  opts: Omit<PersistWriteOptions, "restoreUnwrittenUndos">,
): Promise<void> {
  return persistUndoAndWrite({ ...opts, restoreUnwrittenUndos: false });
}

// --- Deep seam: unified mutation API (one interface, thin adapters) ---

/**
 * Deep seam: execute the full mutation lifecycle.
 *
 * Owns: applySequence → branch (single/multi × noop/applied) → commit →
 * buildBatchResult → recordServedTruncated → return text.
 *
 * The tool layer (adapter) only validates and resolves the nullable path; all
 * lifecycle branching concentrates here (locality). One interface serves N
 * call sites (leverage). Deleting this module would scatter the lifecycle
 * across every tool — it concentrates (deep).
 */
export async function execute(opts: {
  io: FileIO;
  items: PreparedItem[];
  sessionKey: string;
  signal?: AbortSignal;
  exec: ToolExecution;
  sandbox: FsSandboxController;
  sandboxPolicy: SandboxExecutionPolicy | undefined;
}): Promise<string> {
  const { io, items, sessionKey, signal, exec, sandbox, sandboxPolicy } = opts;

  const fileResult = await applySequence(io, items, { signal, sessionKey });

  const toSection = (): BatchSection => ({
    path: fileResult.displayPath,
    originalNormalized: fileResult.originalNormalized,
    result: fileResult.result,
    originalHashes: fileResult.originalHashes,
    resultHashes: fileResult.resultHashes,
    warnings: fileResult.warnings,
    driftNotice: fileResult.driftNotice,
    appliedCount: fileResult.appliedCount,
    noopCount: fileResult.noopCount,
    totalAddedLines: fileResult.totalAddedLines,
    totalRemovedLines: fileResult.totalRemovedLines,
  });

  // The serve write is a SECOND unit, deliberately outside the committed pair: a fault there must
  // not roll the edit back. But it decides whether the diff's anchors are usable, so the claim is
  // made only when the serve landed. Same vocabulary as the undo warning (src/tool-undo.ts).
  const serveNotRecordedNotice =
    "WARNING: the edit applied and stands \u2014 nothing was rolled back \u2014 but the edited rows " +
    "were NOT recorded as served. The diff's `HASH\u2502` rows above are NOT usable anchors and no " +
    "edit can be based on them. Re-read the file before the next edit.";
  const withServeNotice = (text: string, serveLanded: boolean): string =>
    serveLanded ? text : `${text}\n\n${serveNotRecordedNotice}`;

  const recordIfNeeded = async (built: ReturnType<typeof buildBatchResult>): Promise<boolean> => {
    if (built.details.servedRows && built.details.servedRows.length > 0) {
      const entry = built.details.servedByPath?.[0];
      if (entry) {
        return recordServedTruncated(
          sessionKey,
          fileResult.absolutePath,
          entry.servedRows,
          splitLines(fileResult.result).length,
          fileResult.range.startLine - 1,
          splitLines(fileResult.result).map((l) => canon(l)),
          { content: fileResult.result, hashes: fileResult.resultHashes },
        );
      }
    }
    // Nothing to record, so nothing can fail: vacuously landed.
    return true;
  };

  const isSingleCall = items.length === 1 && fileResult.appliedCount + fileResult.noopCount === 1;

  if (isSingleCall) {
    if (fileResult.appliedCount === 0) {
      const built = buildBatchResult([toSection()]);
      const serveLanded = await recordIfNeeded(built);
      return withServeNotice(built.content[0]!.text, serveLanded);
    }
    await commitSingle({
      io,
      files: [
        {
          absolutePath: fileResult.absolutePath,
          displayPath: fileResult.displayPath,
          originalNormalized: fileResult.originalNormalized,
          bom: fileResult.bom,
          originalEnding: fileResult.originalEnding,
          originalHashes: fileResult.originalHashes,
          result: fileResult.result,
        },
      ],
      exec,
      sandbox,
      sandboxPolicy,
      signal,
      undoUnavailableMessage: (displayPath) =>
        formatError("E_UNDO_UNAVAILABLE", { path: displayPath }),
    });
    const built = buildBatchResult([toSection()]);
    const serveLanded = await recordIfNeeded(built);
    return withServeNotice(built.content[0]!.text, serveLanded);
  }

  if (fileResult.appliedCount === 0 && fileResult.noopCount > 0) {
    // all noops — no commit
  } else if (fileResult.appliedCount > 0) {
    await commitBatch({
      io,
      files: [
        {
          absolutePath: fileResult.absolutePath,
          displayPath: fileResult.displayPath,
          originalNormalized: fileResult.originalNormalized,
          bom: fileResult.bom,
          originalEnding: fileResult.originalEnding,
          originalHashes: fileResult.originalHashes,
          result: fileResult.result,
        },
      ],
      exec,
      sandbox,
      sandboxPolicy,
      signal,
      undoUnavailableMessage: (displayPath) =>
        formatError("E_UNDO_UNAVAILABLE", { path: displayPath, batch: true }),
    });
  }

  const built = buildBatchResult([toSection()]);
  const serveLanded = await recordIfNeeded(built);
  return withServeNotice(built.content[0]!.text, serveLanded);
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
    restoreUnwrittenUndos: opts.restoreUnwrittenUndos ?? false,
  });
}

export { commitSingle, commitBatch };
