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
 */

import type { FileIO } from "./fs-bridge.js";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { FsSandboxController } from "./sandbox.js";

import { formatError, formatWarning } from "./domain-errors.js";
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
import type { EncodingMigration, FileEncodingState } from "./file-encoding-state.js";
import { resolveEncodingMigrationConsent } from "./encoding-consent.js";
import type { EncodingMigrationConsent } from "./encoding-consent.js";
import { loadConfig } from "./store-config.js";

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
  /**
   * True when the pre-image spelled more than one terminator kind (#171). Carried to the undo pair
   * so the revert can say it cannot restore the mixture, instead of silently flattening it.
   */
  preImageMixed: boolean;
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
  /**
   * The raw per-call consent from the `edit` payload (#209), or absent. Resolved here against the
   * config ladder, so every file in the batch converts (or refuses) under one answer.
   */
  allowEncodingMigration?: EncodingMigrationConsent;
}

/**
 * The codec one file's write abandoned (#191): the save seam's verdict, forwarded so the
 * undo can disclose it. Empty when no file in the batch migrated — the caller renders
 * nothing from this; the disclosure belongs to the undo that restores the content.
 */
export interface AppliedMigration {
  displayPath: string;
  migration: EncodingMigration;
}

export async function persistUndoAndWrite(opts: PersistWriteOptions): Promise<AppliedMigration[]> {
  const { io, files } = opts;
  const consent = resolveEncodingMigrationConsent(opts.allowEncodingMigration, loadConfig());
  const prepared: Array<{
    file: UndoWriteFile;
    textToWrite: string;
    migration?: EncodingMigration;
  }> = files.map((file) => {
    const recorded = getEncodingState(file.absolutePath);
    const state: FileEncodingState = recorded ?? {
      encoding: file.bom ? "utf8bom" : "utf8",
      hasBOM: file.bom !== "",
      lineEnding: file.originalEnding,
      version: undefined,
    };
    const prep = prepareForSave(file.result, state, {
      migrationConsent: consent,
      displayPath: file.displayPath,
      lineEnding: file.effectiveEnding,
    });
    return {
      file,
      textToWrite: prep.textToWrite,
      ...(prep.migration === undefined ? {} : { migration: prep.migration }),
    };
  });

  const appliedMigrations: AppliedMigration[] = [];
  for (const { file, migration } of prepared) {
    if (migration !== undefined) {
      appliedMigrations.push({ displayPath: file.displayPath, migration });
    }
  }

  const undos: Array<{
    file: UndoWriteFile;
    textToWrite: string;
    restore: () => Promise<void>;
  }> = [];
  for (const { file, textToWrite, migration } of prepared) {
    const undo = await saveUndo(file.absolutePath, {
      content: file.originalNormalized,
      bom: file.bom,
      originalEnding: file.originalEnding,
      hashes: file.originalHashes,
      resultContent: file.result,
      effectiveEnding: file.effectiveEnding,
      preImageMixed: file.preImageMixed,
      ...(migration === undefined ? {} : { migration }),
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
        { lineEnding: u.file.effectiveEnding, migrationConsent: consent },
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
          //
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

  return appliedMigrations;
}

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
  /**
   * Preview only (#145): the run reads, validates and renders, and commits nothing — no byte write,
   * no undo row, no anchor retirement, and no serve/lease for rows that were never written.
   */
  dryRun?: boolean;
  /** Per-call encoding-migration consent from the payload (#209); absent means the config decides. */
  allowEncodingMigration?: EncodingMigrationConsent;
}): Promise<string> {
  const { io, items, sessionKey, signal, exec, sandbox, sandboxPolicy, dryRun = false } = opts;

  const fileResult = await runFileEdits(io, items, { signal, sessionKey, dryRun });

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
    return true;
  };

  const publishServe = async (built: ReturnType<typeof buildBatchResult>): Promise<boolean> =>
    dryRun ? true : recordIfNeeded(built);

  //
  const retireFreedAnchors = async (): Promise<void> => {
    if (fileResult.newlyRetired.length === 0) return;
    try {
      await retireAnchors(sessionKey, fileResult.absolutePath, fileResult.newlyRetired);
    } catch (error) {
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

  const commitFile: UndoWriteFile = {
    absolutePath: fileResult.absolutePath,
    displayPath: fileResult.displayPath,
    originalNormalized: fileResult.originalNormalized,
    bom: fileResult.bom,
    originalEnding: fileResult.originalEnding,
    effectiveEnding: fileResult.effectiveEnding,
    preImageMixed: fileResult.preImageMixed,
    originalHashes: fileResult.originalHashes,
    result: fileResult.result,
  };

  const pushAppliedWriteNotices = (migrations: AppliedMigration[]): void => {
    if (fileResult.eolRewriteWarning !== undefined) {
      fileResult.warnings.push(fileResult.eolRewriteWarning);
    }
    for (const { displayPath, migration } of migrations) {
      fileResult.warnings.push(
        formatWarning("W_ENCODING_MIGRATED", { path: displayPath, ...migration }),
      );
    }
  };

  if (isSingleCall) {
    if (fileResult.appliedCount === 0) {
      const built = buildBatchResult([toSection()], dryRun);
      const serveLanded = await publishServe(built);
      return withServeNotice(built.content[0]!.text, serveLanded);
    }
    if (!dryRun) {
      const migrations = await persistUndoAndWrite({
        io,
        files: [commitFile],
        exec,
        sandbox,
        sandboxPolicy,
        signal,
        ...(opts.allowEncodingMigration === undefined
          ? {}
          : { allowEncodingMigration: opts.allowEncodingMigration }),
        undoUnavailableMessage: (displayPath) =>
          formatError("E_UNDO_UNAVAILABLE", { path: displayPath }),
      });
      await retireFreedAnchors();
      pushAppliedWriteNotices(migrations);
    }

    const built = buildBatchResult([toSection()], dryRun);
    const serveLanded = await publishServe(built);
    return withServeNotice(built.content[0]!.text, serveLanded);
  }

  if (fileResult.appliedCount === 0 && fileResult.noopCount > 0) {
  } else if (fileResult.appliedCount > 0) {
    if (!dryRun) {
      const migrations = await persistUndoAndWrite({
        io,
        files: [commitFile],
        exec,
        sandbox,
        sandboxPolicy,
        signal,
        ...(opts.allowEncodingMigration === undefined
          ? {}
          : { allowEncodingMigration: opts.allowEncodingMigration }),
        undoUnavailableMessage: (displayPath) =>
          formatError("E_UNDO_UNAVAILABLE", { path: displayPath, batch: true }),
      });
      await retireFreedAnchors();
      pushAppliedWriteNotices(migrations);
    }
  }

  const built = buildBatchResult([toSection()], dryRun);
  const serveLanded = await publishServe(built);
  return withServeNotice(built.content[0]!.text, serveLanded);
}
