/**
 * Mutation — deep module owning the full file mutation lifecycle.
 *
 * Previously fragmented: tool-edit → edit-pipeline → engine.applyOne →
 * edit-response/diff/drift, and tool-batch-edit → engine.runFileEdits
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
 *   persistUndoAndWrite(opts) → void                                  — transaction (exported for tests)
 *
 * Depth: small interface (execute) with large implementation — locality and leverage.
 *
 * Internals (private): verifyServedRange, resToSpan, assemble, boundaryDups,
 * noopGuard. Tested via FileEditResult, not via split e2e.
 *
 * @module dsh-better-edit/mutation
 */

import type { FileIO } from "./fs-bridge.js";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { FsSandboxController } from "./sandbox.js";

import { formatError } from "./domain-errors.js";
import { canon } from "./hashline/hash-assign.js";
import type { LineEnding } from "./edit-diff.js";
import { recordServedTruncated, retireAnchors } from "./session-view.js";
import { abortIf, splitLines } from "./utils.js";
import { runFileEdits } from "./mutation/engine.js";
import type { PreparedItem } from "./mutation/engine.js";
import { saveUndo } from "./undo-edit.js";
import { restoreEndings } from "./edit-diff.js";
import { buildBatchResult } from "./edit-response.js";
import type { BatchSection } from "./edit-response.js";
import { getEncodingState, prepareForSave } from "./file-encoding-state.js";
import type { FileEncodingState } from "./file-encoding-state.js";
import { loadConfig } from "./store-config.js";

// Engine helpers are private to Mutation — not re-exported.

// ---------------------------------------------------------------------------
// Transaction (private to Mutation) — persist-undo → write → restore
// ---------------------------------------------------------------------------

interface UndoWriteFile {
  absolutePath: string;
  displayPath: string;
  originalNormalized: string;
  bom: string;
  originalEnding: LineEnding;
  /**
   * The one terminator this write uses, resolved from the pre-image counts (#169). The forward
   * write and its `prepareForSave` both name it: the IO seam re-prepares against a memo that still
   * describes the old ending, so the override is what makes the rewrite reach disk.
   */
  effectiveEnding: LineEnding;
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
}

export async function persistUndoAndWrite(opts: PersistWriteOptions): Promise<void> {
  const { io, files } = opts;
  // Issue #112: decide the save text for EVERY file BEFORE any write. The seam throws
  // E_ENCODING_UNWRITABLE when the recorded encoding cannot be reproduced through the
  // text-only write, so a batch never leaves file 1 transcoded and file 2 refused —
  // nothing (not even the undo rows) is written when the round-trip is impossible.
  const normalizeToUtf8 = loadConfig().normalizeToUtf8;
  const prepared: Array<{ file: UndoWriteFile; textToWrite: string }> = files.map((file) => {
    const recorded = getEncodingState(file.absolutePath);
    // No memo (e.g. a first write): reconstruct the utf8/utf8bom state the edit read.
    const state: FileEncodingState = recorded ?? {
      encoding: file.bom ? "utf8bom" : "utf8",
      hasBOM: file.bom !== "",
      lineEnding: file.originalEnding,
      version: undefined,
    };
    const prep = prepareForSave(file.result, state, {
      normalizeToUtf8,
      displayPath: file.displayPath,
      lineEnding: file.effectiveEnding,
    });
    return { file, textToWrite: prep.textToWrite };
  });

  const undos: Array<{
    file: UndoWriteFile;
    textToWrite: string;
    restore: () => Promise<void>;
  }> = [];
  for (const { file, textToWrite } of prepared) {
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
    undos.push({ file, textToWrite, restore: undo.restore });
  }

  const written: typeof undos = [];
  try {
    for (const u of undos) {
      abortIf(opts.signal);
      await io.writeText(
        u.file.absolutePath,
        u.textToWrite,
        opts.signal,
        opts.exec,
        opts.sandboxPolicy,
        undefined,
        { lineEnding: u.file.effectiveEnding },
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
          undefined,
          // WHY: the memo now records the NEW ending (the write that failed may still have
          // recorded it), so the rollback must name the pre-image's own ending or it would
          // re-spell the restored bytes at the ending the edit introduced.
          //
          // PRE-EXISTING LIMITATION (deliberately kept here): the rollback rebuilds the bytes from
          // `originalNormalized` + `originalEnding`, so a MIXED pre-image comes back normalized at
          // `originalEnding` — not byte-for-byte. Exact mixed restoration is the undo ticket (#171),
          // not this one; the ending override above does not widen or narrow that gap.
          { lineEnding: w.file.originalEnding },
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
    // ADR-0034: the transaction is the one authority for these rows. A row `saveUndo` persisted for
    // a file this write never reached describes content that is not on disk; leaving it there makes
    // the next `undo_last_edit` compare the real file against a phantom and report `E_UNDO_STALE
    // "modified"` — blaming an external write for the tool's own failed write.
    for (const u of undos) {
      if (written.includes(u)) continue;
      try {
        await u.restore();
      } catch (e) {
        console.error("Failed to restore undo entry after write failure:", e);
      }
    }
    throw opts.sandbox.mapError(error, opts.sandboxPolicy);
  }
}

// --- Deep seam: unified mutation API (one interface, thin adapters) ---

/**
 * Deep seam: execute the full mutation lifecycle.
 *
 * Owns: runFileEdits → branch (single/multi × noop/applied) → commit →
 * buildBatchResult → recordServedTruncated → return text.
 *
 * The tool layer (adapter) only validates and delegates; all
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

  const fileResult = await runFileEdits(io, items, { signal, sessionKey });

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
    ...(fileResult.served === undefined ? {} : { served: fileResult.served }),
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

  // WHY (#98, port of upstream CAND-3): the apply phase reports the anchors its edits freed, and
  // this is where they are retired — after the write transaction landed. Retiring them inside the
  // apply phase let a failed write leave a file's live anchors marked dead.
  //
  // Residual window (deliberately kept: fail-safe, do NOT "fix" by re-merging phases): if this
  // retire call throws after the write landed, the freed anchors stay live for one session — the
  // next use of one rejects loud (stale/probed hash) and the user re-reads. That is strictly safer
  // than a retire that commits for a write which never happened; re-merging the phases reintroduces
  // the torn state this ticket removed.
  const retireFreedAnchors = async (): Promise<void> => {
    if (fileResult.newlyRetired.length === 0) return;
    try {
      await retireAnchors(sessionKey, fileResult.absolutePath, fileResult.newlyRetired);
    } catch (error) {
      // WHY (R1 review, #98): retirement is best-effort AFTER the landed write — a store fault here
      // must never turn an applied edit into a thrown error. The freed anchors stay live for this
      // session; the next use of one rejects loud (stale/probed hash) and the user re-reads.
      const detail = error instanceof Error ? error.message : String(error);
      console.warn("Failed to retire freed anchors after the edit landed:", error);
      fileResult.warnings.push(
        "WARNING: the edit applied and stands \u2014 nothing was rolled back \u2014 but the anchors it " +
          `freed could not be retired for this session (${detail}). The next use of a freed anchor ` +
          "will reject as stale; re-read the file to refresh.",
      );
    }
  };

  const isSingleCall = items.length === 1 && fileResult.appliedCount + fileResult.noopCount === 1;

  // Both branches commit exactly this one file, so both name it the same way.
  const commitFile: UndoWriteFile = {
    absolutePath: fileResult.absolutePath,
    displayPath: fileResult.displayPath,
    originalNormalized: fileResult.originalNormalized,
    bom: fileResult.bom,
    originalEnding: fileResult.originalEnding,
    effectiveEnding: fileResult.effectiveEnding,
    originalHashes: fileResult.originalHashes,
    result: fileResult.result,
  };

  // WHY (#169): the EOL notice describes a write, so it is pushed only after one LANDED — an
  // all-noop call rewrites nothing and must not claim it did. Both applied branches share this.
  const pushEolNoticeAfterWrite = (): void => {
    if (fileResult.eolRewriteWarning !== undefined) {
      fileResult.warnings.push(fileResult.eolRewriteWarning);
    }
  };

  if (isSingleCall) {
    if (fileResult.appliedCount === 0) {
      const built = buildBatchResult([toSection()]);
      const serveLanded = await recordIfNeeded(built);
      return withServeNotice(built.content[0]!.text, serveLanded);
    }
    await persistUndoAndWrite({
      io,
      files: [commitFile],
      exec,
      sandbox,
      sandboxPolicy,
      signal,
      undoUnavailableMessage: (displayPath) =>
        formatError("E_UNDO_UNAVAILABLE", { path: displayPath }),
    });
    await retireFreedAnchors();
    pushEolNoticeAfterWrite();
    const built = buildBatchResult([toSection()]);
    const serveLanded = await recordIfNeeded(built);
    return withServeNotice(built.content[0]!.text, serveLanded);
  }

  if (fileResult.appliedCount === 0 && fileResult.noopCount > 0) {
    // all noops — no commit
  } else if (fileResult.appliedCount > 0) {
    await persistUndoAndWrite({
      io,
      files: [commitFile],
      exec,
      sandbox,
      sandboxPolicy,
      signal,
      undoUnavailableMessage: (displayPath) =>
        formatError("E_UNDO_UNAVAILABLE", { path: displayPath, batch: true }),
    });
    await retireFreedAnchors();
    pushEolNoticeAfterWrite();
  }

  const built = buildBatchResult([toSection()]);
  const serveLanded = await recordIfNeeded(built);
  return withServeNotice(built.content[0]!.text, serveLanded);
}
