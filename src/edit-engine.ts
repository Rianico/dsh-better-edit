/**
 * The edit-sequence engine shared by `edit`, `batch_edit`, and previews:
 * apply-one-edit against in-memory content with served verification, the
 * multi-edit sequencer that drives a whole file's item list against evolving
 * content, the noop-loop guard, and the persist-undo → write → restore
 * transaction both mutating tools run.
 *
 * The model-facing contract lives here unchanged: [E_BATCH_ABORT],
 * [E_NOOP_LOOP], [E_UNDO_UNAVAILABLE] carry byte-identical messages, and
 * reject-and-serve records the same echo serves.
 * @module dsh-better-edit/edit-engine
 */

import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { FileIO } from "./fs-bridge.js";
import type { HashStore } from "./hash-store.js";
import type { LineEnding } from "./edit-diff.js";
import { restoreEndings } from "./edit-diff.js";
import { normFromText } from "./file-reader.js";
import { scanDrift, loadServed } from "./session-view.js";
import {
	applyEdit,
	resEdit,
	parseHashRef,
	type HEdit,
	type NEdit,
} from "./hashline/anchor-pipeline.js";
import { lineHashes } from "./hashline/hash.js";
import { MAX_HASH_LINES } from "./hashline/hash-assign.js";
import {
	AnchorMismatchError,
	ServedRejectionError,
	buildRangeEcho,
	fmtServedRows,
	recordEchoServes,
	type ResolvedRange,
	type ServeRecordPolicy,
	type ServedRow,
} from "./hashline/anchor-pipeline.js";
import { findSnapshotPathsByHashes } from "./hash-store.js";
import { saveUndo } from "./undo-edit.js";
import {
	clearNoopLoop,
	noopPayloadKey,
	trackNoopPayload,
} from "./noop-guard.js";
import { NOOP_LOOP_THRESHOLD } from "./constants.js";
import { abortIf, splitLines } from "./utils.js";
import type { FsSandboxController } from "./sandbox.js";

// ---------------------------------------------------------------------------
// shared types

export interface PreparedItem {
	index: number;
	path: string;
	absolutePath: string;
	remove_from: string;
	remove_to: string;
	replacement_text: string;
	pathWarning?: string;
}

export interface FileEditResult {
	displayPath: string;
	absolutePath: string;
	originalNormalized: string;
	result: string;
	bom: string;
	originalEnding: LineEnding;
	hadUtf8DecodeErrors: boolean;
	warnings: string[];
	originalHashes: string[];
	resultHashes: string[];
	appliedCount: number;
	noopCount: number;
	totalAddedLines: number;
	totalRemovedLines: number;
	driftNotice: string | undefined;
	range: ResolvedRange;
}

// ---------------------------------------------------------------------------
// request / counting helpers shared by both tool paths

/**
 * Resolve a request's missing `path` from its anchors: the only file whose
 * stored hashes contain both anchors. Returns the path plus an autocorrect
 * warning, or undefined when no resolution is possible.
 */
export async function resolveMissingPath(
	request: Record<string, unknown>,
): Promise<{ path: string; warning: string } | undefined> {
	if (typeof request.path === "string") return undefined;
	const from = request.remove_from;
	const to = request.remove_to;
	if (typeof from !== "string" || typeof to !== "string") return undefined;
	const hashes: string[] = [];
	for (const ref of [from, to]) {
		try {
			hashes.push(parseHashRef(ref).hash);
		} catch {
			return undefined;
		}
	}
	let matches: string[];
	try {
		matches = await findSnapshotPathsByHashes(hashes);
	} catch {
		return undefined;
	}
	if (matches.length === 1) {
		return {
			path: matches[0]!,
			warning: `[E_BAD_SHAPE] Autocorrected: missing "path" resolved to ${matches[0]} — the only file whose stored hashes contain both anchors.`,
		};
	}
	if (matches.length > 1) {
		throw new Error(
			`[E_BAD_SHAPE] Edit request requires a non-empty "path" string; the anchors match multiple known files: ${matches.join(', ')}. Include the intended path.`,
		);
	}
	return undefined;
}

/** The hashes a range edit removes, for stable re-hash bookkeeping. */
export function collectRemovedHashes(
	edit: HEdit,
	originalHashes: string[],
): Set<string> {
	const removedHashes = new Set<string>();
	const startHash = edit.hash_bounds[0].hash;
	const endHash = edit.hash_bounds[1].hash;
	const startLine = originalHashes.indexOf(startHash);
	const endLine = originalHashes.indexOf(endHash);
	if (startLine >= 0 && endLine >= 0) {
		const firstLine = Math.min(startLine, endLine);
		const lastLine = Math.max(startLine, endLine);
		for (let i = firstLine; i <= lastLine; i++) {
			removedHashes.add(originalHashes[i]!);
		}
	}
	return removedHashes;
}

/** Added/removed line counts for one resolved edit against a file's original hashes. */
export function countLineChanges(
	edit: HEdit,
	originalHashes: string[],
	isNoop: boolean,
	removedAutoFixes: number,
): { totalAddedLines: number; totalRemovedLines: number } {
	if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
	let totalRemovedLines = 0;
	const startLine = originalHashes.indexOf(edit.hash_bounds[0].hash);
	const endLine = originalHashes.indexOf(edit.hash_bounds[1].hash);
	if (startLine >= 0 && endLine >= 0) {
		totalRemovedLines = Math.abs(endLine - startLine) + 1;
	}
	return {
		totalAddedLines: Math.max(0, edit.content_lines.length - removedAutoFixes),
		totalRemovedLines,
	};
}

// ---------------------------------------------------------------------------
// apply-one

export interface ApplyOneInput {
	content: string;
	hashes: string[];
	served: (string | null)[];
	removeFrom: string;
	removeTo: string;
	replacementText: string;
	absolutePath: string;
	displayPath: string;
	signal?: AbortSignal;
	/** Shared warnings array; resEdit warnings are pushed here. */
	warnings: string[];
	/**
	 * The hashes to count added/removed lines against. Defaults to `hashes`;
	 * the batch sequencer passes the file's ORIGINAL hashes so later edits in
	 * a sequence still count against the file as first served.
	 */
	countHashes?: string[];
	store?: HashStore;
	persist: boolean;
	/** Pre-resolved edit (single path keeps resEdit before IO for error order). */
	edit?: HEdit;
}

export interface ApplyOneResult {
	result: string;
	/** Stable re-hash after the edit (equals `hashes` for a noop). */
	hashes: string[];
	range: ResolvedRange;
	noop: boolean;
	edit: HEdit;
	noopEdit?: NEdit;
	firstChangedLine?: number;
	lastChangedLine?: number;
	removedHashes: Set<string> | undefined;
	totalAddedLines: number;
	totalRemovedLines: number;
	anchorWarnings: string[] | undefined;
}

/**
 * One edit against in-memory content: resolve (unless a pre-resolved edit was
 * given) → apply with served verification → stable re-hash → line counts.
 *
 * `onReject` owns the reject-and-serve policy: it receives resolve/verify
 * failures (and the edit that failed, when resolved) and MUST throw. The
 * single path rethrows the original anchor error after recording echo serves;
 * the batch path wraps with [E_BATCH_ABORT] plus the current-range echo.
 */
export async function applyOne(
	input: ApplyOneInput,
	onReject: (error: unknown, edit: HEdit | undefined) => Promise<never>,
): Promise<ApplyOneResult> {
	let edit: HEdit;
	if (input.edit) {
		edit = input.edit;
	} else {
		try {
			edit = resEdit(
				{
					remove_from: input.removeFrom,
					remove_to: input.removeTo,
					replacement_text: input.replacementText,
				},
				input.warnings,
			);
		} catch (error) {
			return onReject(error, undefined);
		}
	}

	let anchorResult: ReturnType<typeof applyEdit>;
	try {
		anchorResult = applyEdit(
			input.content,
			edit,
			input.signal,
			input.hashes,
			input.displayPath,
			input.served,
		);
	} catch (error) {
		if (
			error instanceof AnchorMismatchError ||
			error instanceof ServedRejectionError
		) {
			return onReject(error, edit);
		}
		throw error;
	}

	const result = anchorResult.content;
	const noop = result === input.content;
	const removedHashes = noop
		? undefined
		: collectRemovedHashes(edit, input.hashes);
	const resultHashes = noop
		? input.hashes
		: await lineHashes(
				result,
				input.absolutePath,
				{
					content: input.content,
					hashes: input.hashes,
					removedHashes,
				},
				input.store,
				input.persist,
			);
	const { totalAddedLines, totalRemovedLines } = countLineChanges(
		edit,
		input.countHashes ?? input.hashes,
		noop,
		anchorResult.autoFixes?.length ?? 0,
	);

	return {
		result,
		hashes: resultHashes,
		range: anchorResult.range,
		noop,
		edit,
		noopEdit: anchorResult.noopEdit,
		firstChangedLine: anchorResult.firstChangedLine,
		lastChangedLine: anchorResult.lastChangedLine,
		removedHashes,
		totalAddedLines,
		totalRemovedLines,
		anchorWarnings: anchorResult.warnings,
	};
}

// ---------------------------------------------------------------------------
// noop-loop guard

export interface NoopLoopOptions {
	absolutePath: string;
	removeFrom: string;
	removeTo: string;
	replacementText: string;
	displayPath: string;
	/** Batch item index; undefined = single-edit flavor. */
	index?: number;
	count: number;
	sessionKey: string;
	originalHashes: string[];
	originalNormalized: string;
	/** Single-edit flavor only: the edit's range, for the echo rows. */
	range?: ResolvedRange;
	/** Batch flavor: precomputed echo rows for the failed item (may be absent). */
	echoRows?: ServedRow[];
}


/**
 * The shared noop-loop guard. Returns the "twice in a row" notice for the
 * caller to append to warnings, or throws [E_NOOP_LOOP] (after recording the
 * echo serves) once the payload has been submitted NOOP_LOOP_THRESHOLD times
 * with no change. Messages are byte-identical to the pre-engine tools.
 */
export async function enforceNoopLoop(
	opts: NoopLoopOptions,
): Promise<string | undefined> {
	const {
		absolutePath,
		removeFrom,
		removeTo,
		displayPath,
		index,
		count,
		sessionKey,
		originalHashes,
	} = opts;

	if (index === undefined) {
		if (count >= NOOP_LOOP_THRESHOLD) {
			const echoRows = buildRangeEcho(
				opts.range!.startLine,
				opts.range!.endLine,
				originalHashes,
			);
			const echo = fmtServedRows(
				echoRows,
				splitLines(opts.originalNormalized),
			);
			await recordEchoServes(
				sessionKey,
				absolutePath,
				echoRows,
				"live",
				originalHashes.length,
			);
			throw new Error(
				`[E_NOOP_LOOP] This exact edit (anchors ${removeFrom} to ${removeTo} in ${displayPath}) has been submitted ${count} times and produced no changes each time — the range already contains the replacement text. Do not resend this edit; it will never change the file. Current range:\n${echo}`,
			);
		}
		if (count === 2) {
			return `[E_NOOP_LOOP] Notice: this exact edit (anchors ${removeFrom} to ${removeTo} in ${displayPath}) has produced no changes twice in a row. The range already contains the replacement text; resending it again will be rejected.`;
		}
		return undefined;
	}

	if (count >= NOOP_LOOP_THRESHOLD) {
		const originalLines = splitLines(opts.originalNormalized);
		const echoRows = opts.echoRows;
		if (echoRows) {
			await recordEchoServes(
				sessionKey,
				absolutePath,
				echoRows,
				"live",
				originalHashes.length,
			);
		}
		throw new Error(
			`[E_NOOP_LOOP] edits[${index}] (${displayPath}): this exact edit (anchors ${removeFrom} to ${removeTo}) has been submitted ${count} times and produced no changes each time — the range already contains the replacement text. Do not resend it; it will never change the file. The whole batch was rejected and nothing was written.` +
				(echoRows
					? ` Current on-disk range:\n${fmtServedRows(echoRows, originalLines)}`
					: ""),
		);
	}
	if (count === 2) {
		return `[E_NOOP_LOOP] Notice: edits[${index}] (${displayPath}) — this exact edit has produced no changes twice in a row; the range already contains the replacement text. Resending it again will reject the batch.`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// per-file sequencer (batch)

function echoRowsForItem(
	edit: HEdit,
	originalHashes: string[],
): ServedRow[] | undefined {
	const startHash = edit.hash_bounds[0].hash;
	const endHash = edit.hash_bounds[1].hash;
	const s = originalHashes.indexOf(startHash);
	const e = originalHashes.indexOf(endHash);
	if (s < 0 || e < 0) return undefined;
	return buildRangeEcho(Math.min(s, e) + 1, Math.max(s, e) + 1, originalHashes);
}

/**
 * Run a file's item list against freshly-read content with served
 * verification, evolving content/hashes, union range, noop tracking, and a
 * per-file drift notice. All-or-nothing is enforced by the caller's
 * transaction ({@link persistUndoAndWrite}): nothing here writes to disk.
 */
export async function runFileEdits(
	io: FileIO,
	items: PreparedItem[],
	opts: { signal?: AbortSignal; sessionKey: string },
): Promise<FileEditResult> {
	const first = items[0]!;
	abortIf(opts.signal);
	const absolutePath = first.absolutePath;
	const rawText = await io.readText(absolutePath, opts.signal);
	const {
		normalized: originalNormalized,
		bom,
		originalEnding,
		fileHashes: originalHashes,
		hadUtf8DecodeErrors,
	} = await normFromText({
		absolutePath,
		rawText,
		displayPath: first.path,
		signal: opts.signal,
		maxLines: MAX_HASH_LINES,
	});

	const served = await loadServed(opts.sessionKey, absolutePath);
	const warnings: string[] = [];

	let currentContent = originalNormalized;
	let currentHashes = originalHashes;
	let appliedCount = 0;
	let noopCount = 0;
	let totalAddedLines = 0;
	let totalRemovedLines = 0;
	let unionStartLine = Infinity;
	let unionEndLine = -Infinity;
	let unionStartHash = "";
	let unionEndHash = "";
	let lastApplied:
		| { content: string; hashes: string[]; removedHashes: Set<string> }
		| undefined;

	for (const item of items) {
		abortIf(opts.signal);
		const applied = await applyOne(
			{
				content: currentContent,
				hashes: currentHashes,
				served,
				removeFrom: item.remove_from,
				removeTo: item.remove_to,
				replacementText: item.replacement_text,
				absolutePath,
				displayPath: item.path,
				signal: opts.signal,
				warnings,
				countHashes: originalHashes,
				persist: false,
			},
			async (error, edit) => {
				if (
					error instanceof AnchorMismatchError ||
					error instanceof ServedRejectionError
				) {
					const originalLines = splitLines(originalNormalized);
					const echoRows =
						error.servedRows.length > 0
							? error.servedRows
							: edit
								? echoRowsForItem(edit, originalHashes)
								: undefined;
					if (echoRows) {
						await recordEchoServes(
							opts.sessionKey,
							absolutePath,
							echoRows,
							"live",
							originalHashes.length,
						);
					}
					const echoBlock = echoRows
						? ` Current on-disk range for edits[${item.index}] (unchanged — nothing was written):\n${fmtServedRows(echoRows, originalLines)}`
						: " Call read() to get fresh anchors.";
					throw new Error(
						`[E_BATCH_ABORT] edits[${item.index}] (${item.path}) failed: ${error.message}${echoBlock}\n` +
							"The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied. Fix the failing edit (and any later edit that depends on it), then resubmit the batch.",
					);
				}
				const message =
					error instanceof Error ? error.message : String(error);
				throw new Error(
					`[E_BATCH_ABORT] edits[${item.index}] (${item.path}) failed: ${message}\n` +
						"The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied.",
				);
			},
		);

		const range = applied.range;
		if (range.startLine < unionStartLine) {
			unionStartLine = range.startLine;
			unionStartHash = range.startHash;
		}
		if (range.endLine > unionEndLine) {
			unionEndLine = range.endLine;
			unionEndHash = range.endHash;
		}

		if (applied.noop) {
			noopCount += 1;
			const payload = noopPayloadKey(
				absolutePath,
				item.remove_from,
				item.remove_to,
				item.replacement_text,
			);
			const count = trackNoopPayload(absolutePath, payload);
			const notice = await enforceNoopLoop({
				absolutePath,
				removeFrom: item.remove_from,
				removeTo: item.remove_to,
				replacementText: item.replacement_text,
				displayPath: item.path,
				index: item.index,
				count,
				sessionKey: opts.sessionKey,
				originalHashes,
				originalNormalized,
				echoRows: echoRowsForItem(applied.edit, originalHashes),
			});
			if (notice) warnings.push(notice);
			warnings.push(
				`edits[${item.index}] (${item.path}) was a noop: the range already contains the replacement text.`,
			);
			if (applied.anchorWarnings?.length)
				warnings.push(...applied.anchorWarnings);
			continue;
		}

		appliedCount += 1;
		const removedHashes = applied.removedHashes!;
		totalAddedLines += applied.totalAddedLines;
		totalRemovedLines += applied.totalRemovedLines;
		lastApplied = {
			content: currentContent,
			hashes: currentHashes,
			removedHashes,
		};
		currentContent = applied.result;
		currentHashes = applied.hashes;
		clearNoopLoop(absolutePath);
		if (applied.anchorWarnings?.length)
			warnings.push(...applied.anchorWarnings);
	}

	const result = currentContent;
	let resultHashes = currentHashes;
	if (appliedCount > 0 && lastApplied) {
		resultHashes = await lineHashes(
			result,
			absolutePath,
			{
				content: lastApplied.content,
				hashes: lastApplied.hashes,
				removedHashes: lastApplied.removedHashes,
			},
			undefined,
			true,
		);
	}

	if (hadUtf8DecodeErrors) {
		warnings.push(
			"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
		);
	}
	if (first.pathWarning) warnings.unshift(first.pathWarning);

	let driftNotice: string | undefined;
	if (appliedCount > 0 && unionStartLine !== Infinity) {
		const resultLines = splitLines(result);
		const originalLines = splitLines(originalNormalized);
		try {
			driftNotice = await scanDrift({
				sessionKey: opts.sessionKey,
				served,
				resultHashes,
				resultLines,
				range: {
					startLine: unionStartLine,
					endLine: unionEndLine,
					startHash: unionStartHash,
					endHash: unionEndHash,
					delta: resultLines.length - originalLines.length,
				},
				path: absolutePath,
			});
		} catch (error) {
			console.error("Failed to compute drift notice:", error);
		}
	}

	return {
		displayPath: first.path,
		absolutePath,
		originalNormalized,
		result,
		bom,
		originalEnding,
		hadUtf8DecodeErrors,
		warnings,
		originalHashes,
		resultHashes,
		appliedCount,
		noopCount,
		totalAddedLines,
		totalRemovedLines,
		driftNotice,
		range: {
			startLine: unionStartLine,
			endLine: unionEndLine,
			startHash: unionStartHash,
			endHash: unionEndHash,
			delta: splitLines(result).length - splitLines(originalNormalized).length,
		},
	};
}

// ---------------------------------------------------------------------------
// the write transaction

export interface UndoWriteFile {
	absolutePath: string;
	displayPath: string;
	originalNormalized: string;
	bom: string;
	originalEnding: LineEnding;
	originalHashes: string[];
	result: string;
}

export interface PersistWriteOptions {
	io: FileIO;
	files: UndoWriteFile[];
	exec: ToolExecution;
	sandbox: FsSandboxController;
	sandboxPolicy: SandboxExecutionPolicy | undefined;
	signal?: AbortSignal;
	/** [E_UNDO_UNAVAILABLE] message builder, per tool flavor. */
	undoUnavailableMessage: (displayPath: string) => string;
	/**
	 * On write failure, also restore undo entries of files that were saved but
	 * never written. The single-edit tool restores its one entry; the batch
	 * tool keeps current behavior and restores only written files.
	 */
	restoreUnwrittenUndos?: boolean;
}

/**
 * The persist-undo → write-all → restore-on-failure transaction shared by
 * `edit` (one file) and `batch_edit` (many files). Every file's undo entry is
 * persisted before anything is written; if a write fails, already-written
 * files are restored (original content written back, undo entry restored) and
 * the sandbox-mapped error rethrown.
 */
export async function persistUndoAndWrite(
	opts: PersistWriteOptions,
): Promise<void> {
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
				} catch (error) {
					console.error("Failed to restore undo entry after abort:", error);
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
					w.file.bom +
						restoreEndings(
							w.file.originalNormalized,
							w.file.originalEnding,
						),
					undefined,
					opts.exec,
					opts.sandboxPolicy,
				);
			} catch (restoreError) {
				console.error("Failed to restore file after write failure:", restoreError);
			}
			try {
				await w.restore();
			} catch (restoreError) {
				console.error(
					"Failed to restore undo entry after write failure:",
					restoreError,
				);
			}
		}
		if (opts.restoreUnwrittenUndos) {
			for (const u of undos) {
				if (written.includes(u)) continue;
				try {
					await u.restore();
				} catch (restoreError) {
					console.error(
						"Failed to restore undo entry after write failure:",
						restoreError,
					);
				}
			}
		}
		throw opts.sandbox.mapError(error, opts.sandboxPolicy);
	}
}

// re-exported for the callers that used to import these from the pipeline
export type { ServeRecordPolicy };
