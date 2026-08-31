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
 *   applySingle(io, params, cwd, opts) → PipelineResult               — single-edit helper
 *   applySequence(io, items, ctx) → FileEditResult                    — per-file sequencer
 *   commit(io, files, {exec, sandboxPolicy, signal}) → void           — transaction
 *
 * Depth: small interface (execute) with large implementation — locality and leverage.
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

import { normFromText, fileSnap } from "./file-reader.js";
import type { LineEnding } from "./edit-diff.js";
import { toCwd } from "./paths.js";
import { resEdit, type NEdit } from "./hashline/anchor-pipeline.js";
import { MAX_HASH_LINES } from "./hashline/hash-assign.js";
import type { ResolvedRange } from "./hashline/anchor-pipeline.js";
import {
  AnchorMismatchError,
  ServedRejectionError,
  recordEchoServes,
  type ServeRecordPolicy,
} from "./hashline/anchor-pipeline.js";
import { sessionKeyFor } from "./workspace-context.js"
import { loadServed, scanDrift, recordServedTruncated } from "./session-view.js";
import { abortIf, splitLines } from "./utils.js";
import { applyOne } from "./mutation/engine.js";
import {
  runFileEdits,
  resolveMissingPath,
} from "./mutation/engine.js";
import type { FileEditResult, PreparedItem } from "./mutation/engine.js";
import { saveUndo } from "./undo-edit.js";
import { restoreEndings } from "./edit-diff.js";
import { buildMetrics, buildNoop, buildChanged, buildBatchResult } from "./edit-response.js";
import type { RMeta, BatchSection } from "./edit-response.js";
import { genDiff, toLF, stripBOM } from "./edit-diff.js";
import { computeDrift } from "./session-view.js";
import { trackNoopPayload, clearNoopLoop, noopPayloadKey } from "./noop-guard.js";

export interface PipelineResult {
	path: string
	absolutePath: string
	originalNormalized: string
	result: string
	bom: string
	originalEnding: LineEnding
	hadUtf8DecodeErrors: boolean
	warnings: string[]
	noopEdit?: NEdit
	firstChangedLine?: number
	lastChangedLine?: number
	originalHashes: string[]
	resultHashes: string[]
	totalAddedLines: number
	totalRemovedLines: number
	driftNotice?: string
	range: ResolvedRange
}

export interface ExecPipelineOptions {
	signal?: AbortSignal
	store?: HashStore
	noPersist?: boolean
	sessionKey?: string
}

export async function execPipeline(
	io: FileIO,
	params: EditParams,
	cwd: string,
	options?: ExecPipelineOptions,
): Promise<PipelineResult> {
	const path = params.path

	const editWarnings: string[] = []
	// Resolve the edit up front (before IO) so malformed anchors fail before
	// any filesystem work, exactly as the tool always did.
	const edit = resEdit(
		{
			remove_from: params.remove_from,
			remove_to: params.remove_to,
			replacement_text: params.replacement_text,
		},
		editWarnings,
	)

	const hashStore = options?.store
	const signal = options?.signal

	abortIf(signal)
	const absolutePath = await io.resolve(path, cwd, signal)
	const rawText = await io.readText(absolutePath, signal)
	const {
		normalized: originalNormalized,
		bom,
		originalEnding,
		fileHashes: originalHashes,
		hadUtf8DecodeErrors,
	} = await normFromText({
		absolutePath,
		rawText,
		displayPath: path,
		signal,
		maxLines: MAX_HASH_LINES,
		store: hashStore,
		noPersist: options?.noPersist,
	})

	const sessionKey = options?.sessionKey ?? sessionKeyFor(undefined)
	const served = await loadServed(sessionKey, absolutePath)
	const policy: ServeRecordPolicy =
		options?.noPersist === true ? 'preview' : 'live'

	const applied = await applyOne(
		{
			content: originalNormalized,
			hashes: originalHashes,
			served,
			removeFrom: params.remove_from,
			removeTo: params.remove_to,
			replacementText: params.replacement_text,
			absolutePath,
			displayPath: path,
			signal,
			warnings: editWarnings,
			store: hashStore,
			persist: options?.noPersist !== true,
			edit,
		},
		async (error) => {
			if (
				error instanceof AnchorMismatchError ||
				error instanceof ServedRejectionError
			) {
				await recordEchoServes(
					sessionKey,
					absolutePath,
					error.servedRows,
					policy,
					originalHashes.length,
				)
			}
			throw error
		},
	)
	const result = applied.result
	const isNoop = applied.noop
	const warnings = [...editWarnings, ...(applied.anchorWarnings ?? [])]

	let driftNotice: string | undefined
	if (options?.noPersist !== true) {
		try {
			driftNotice = await scanDrift({
				sessionKey,
				served,
				resultHashes: applied.hashes,
				resultLines: splitLines(result),
				range: applied.range,
				path: absolutePath,
			})
		} catch (error) {
			console.error('Failed to compute drift notice:', error)
		}
	}

	return {
		path,
		absolutePath,
		originalNormalized,
		result,
		bom,
		originalEnding,
		hadUtf8DecodeErrors,
		warnings,
		noopEdit: applied.noopEdit,
		firstChangedLine: applied.firstChangedLine,
		lastChangedLine: applied.lastChangedLine,
		originalHashes,
		resultHashes: applied.hashes,
		totalAddedLines: applied.totalAddedLines,
		totalRemovedLines: applied.totalRemovedLines,
		driftNotice,
		range: applied.range,
	}
}

/** Resolve the display path a caller names against the session cwd. */
export function resolveDisplayPath(path: string, cwd: string): string {
	return toCwd(path, cwd)
}

/** Snapshot bookkeeping for noop/success results (best-effort). */
export async function snapshotIdFor(
	io: FileIO,
	absolutePath: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		return await io.statVersion(absolutePath, signal)
	} catch {
		try {
			return (await fileSnap(absolutePath)).snapshotId
		} catch {
			return undefined
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
        try { await u.restore(); } catch (e) { console.error("Failed to restore undo entry after abort:", e); }
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
      } catch (e) { console.error("Failed to restore file after write failure:", e); }
      try { await w.restore(); } catch (e) { console.error("Failed to restore undo entry after write failure:", e); }
    }
    if (opts.restoreUnwrittenUndos) {
      for (const u of undos) {
        if (written.includes(u)) continue;
        try { await u.restore(); } catch (e) { console.error("Failed to restore undo entry after write failure:", e); }
      }
    }
    throw opts.sandbox.mapError(error, opts.sandboxPolicy);
  }
}

async function commitSingle(opts: Omit<PersistWriteOptions, "restoreUnwrittenUndos">): Promise<void> {
  return persistUndoAndWrite({ ...opts, restoreUnwrittenUndos: true });
}

async function commitBatch(opts: Omit<PersistWriteOptions, "restoreUnwrittenUndos">): Promise<void> {
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

  const recordIfNeeded = async (built: ReturnType<typeof buildBatchResult>) => {
    if (built.details.servedRows && built.details.servedRows.length > 0) {
      const entry = built.details.servedByPath?.[0];
      if (entry) {
        await recordServedTruncated(
          sessionKey,
          fileResult.absolutePath,
          entry.servedRows,
          splitLines(fileResult.result).length,
          fileResult.range.startLine - 1,
        );
      }
    }
  };

  const isSingleCall = items.length === 1 && fileResult.appliedCount + fileResult.noopCount === 1;

  if (isSingleCall) {
    if (fileResult.appliedCount === 0) {
      const built = buildBatchResult([toSection()]);
      await recordIfNeeded(built);
      return built.content[0]!.text;
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
        `[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${displayPath} is unchanged. Retry the edit, or use write if the store cannot be recovered.`,
    });
    const built = buildBatchResult([toSection()]);
    await recordIfNeeded(built);
    return built.content[0]!.text;
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
      undoUnavailableMessage: () =>
        "[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the batch was NOT applied and no file was written. Retry the batch, or use write if the store cannot be recovered.",
    });
  }

  const built = buildBatchResult([toSection()]);
  await recordIfNeeded(built);
  return built.content[0]!.text;
}

/** Apply a single edit — owns read→normalize→loadServed→applyOne→stableRehash→drift. */
export async function applySingle(
 io: FileIO,
 params: EditParams,
 cwd: string,
 opts?: {
  sessionKey?: string;
  signal?: AbortSignal;
  store?: HashStore;
  noPersist?: boolean;
 },
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
  restoreUnwrittenUndos: opts.restoreUnwrittenUndos ?? false,
 });
}

export { commitSingle, commitBatch };
