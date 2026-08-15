/**
 * The dsh `batch_edit` tool: several hash-anchored edits in one all-or-nothing
 * call. Items targeting the same file are applied in order against the served
 * state; any failing item rejects the whole batch with nothing written, and
 * the failing item's current range is echoed as fresh serves.
 * @module dsh-better-edit/tool-batch-edit
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { restoreEndings, type LineEnding } from "./edit-diff.js";
import { normFromText } from "./file-reader.js";
import { scanDrift } from "./drift.js";
import {
	abortIf,
	isRec,
	normalizeFilePath,
	rejectUnknownFields,
	splitLines,
} from "./utils.js";
import { normReq } from "./edit-normalize.js";
import {
	applyEdit,
	lineHashes,
	resEdit,
	MAX_HASH_LINES,
	type HEdit,
} from "./hashline/index.js";
import {
	AnchorMismatchError,
	ServedRejectionError,
	buildRangeEcho,
	fmtServedRows,
	recordEchoServes,
	type ResolvedRange,
	type ServedRow,
} from "./hashline/served.js";
import { buildBatchResult, type BatchSection } from "./edit-response.js";
import { saveUndo } from "./undo-edit.js";
import { loadServed, recordServedTruncated } from "./served-store.js";
import { BATCH_EDIT_MAX_ITEMS, NOOP_LOOP_THRESHOLD } from "./constants.js";
import {
	collectRemovedHashes,
	countLineChanges,
	resolveMissingPath,
} from "./edit-pipeline.js";
import {
	clearNoopLoop,
	noopPayloadKey,
	trackNoopPayload,
} from "./noop-guard.js";
import { BATCH_EDIT_DESCRIPTION } from "./prompts.js";
import {
	pathSchema,
	removeFromSchema,
	removeToSchema,
	replacementTextSchema,
} from "./schema.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./dsh-context.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { withWorkspace } from "./workspace.js";

interface BatchItem {
	path?: string;
	remove_from: string;
	remove_to: string;
	replacement_text: string;
}

interface BatchEditParams {
	edits: BatchItem[];
}

type PreparedItem = {
	index: number;
	path: string;
	absolutePath: string;
	remove_from: string;
	remove_to: string;
	replacement_text: string;
	pathWarning?: string;
};

const BATCH_ITEM_KS = new Set([
	"path",
	"remove_from",
	"remove_to",
	"replacement_text",
]);

function assertBatchReq(request: unknown): asserts request is BatchEditParams {
	if (!isRec(request)) {
		throw new Error(
			'[E_BAD_SHAPE] batch_edit request must be an object with an "edits" array.',
		);
	}
	rejectUnknownFields(
		request,
		new Set(["edits", "sandbox_permissions", "justification"]),
		"batch_edit request",
	);
	if (!Array.isArray(request.edits) || request.edits.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] batch_edit request requires a non-empty "edits" array.',
		);
	}
	if (request.edits.length > BATCH_EDIT_MAX_ITEMS) {
		throw new Error(
			`[E_BAD_SHAPE] batch_edit accepts at most ${BATCH_EDIT_MAX_ITEMS} edits; got ${request.edits.length}. Split the batch.`,
		);
	}
	request.edits.forEach((item, index) => {
		if (!isRec(item)) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}] must be an object with remove_from, remove_to, and replacement_text.`,
			);
		}
		rejectUnknownFields(item, BATCH_ITEM_KS, `edits[${index}]`);
		if (
			typeof item.remove_from !== "string" ||
			typeof item.remove_to !== "string" ||
			typeof item.replacement_text !== "string"
		) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}] requires "remove_from", "remove_to", and "replacement_text" strings.`,
			);
		}
		if (
			item.path !== undefined &&
			(typeof item.path !== "string" || item.path.length === 0)
		) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].path must be a non-empty string.`,
			);
		}
	});
}

async function prepareItems(
	io: FileIO,
	params: BatchEditParams,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<PreparedItem[]> {
	const items: PreparedItem[] = [];
	for (let index = 0; index < params.edits.length; index++) {
		const raw = params.edits[index]!;
		const record: Record<string, unknown> = { ...raw };
		normalizeFilePath(record);

		let path = typeof record.path === "string" ? record.path : undefined;
		let pathWarning: string | undefined;
		if (!path) {
			let resolution: { path: string; warning: string } | undefined;
			try {
				resolution = await resolveMissingPath(record);
			} catch (error) {
				if (error instanceof Error) {
					throw new Error(`edits[${index}]: ${error.message}`);
				}
				throw error;
			}
			if (resolution) {
				path = resolution.path;
				pathWarning = resolution.warning;
			}
		}
		if (!path) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}] requires a non-empty "path" string, and its anchors match no known file.`,
			);
		}

		items.push({
			index,
			path,
			absolutePath: await io.resolve(path, cwd, signal),
			remove_from: record.remove_from as string,
			remove_to: record.remove_to as string,
			replacement_text: record.replacement_text as string,
			pathWarning,
		});
	}
	return items;
}

function groupByPath(items: PreparedItem[]): Map<string, PreparedItem[]> {
	const groups = new Map<string, PreparedItem[]>();
	for (const item of items) {
		const list = groups.get(item.absolutePath);
		if (list) list.push(item);
		else groups.set(item.absolutePath, [item]);
	}
	return groups;
}

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

type ProcessedFile = {
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
};

async function processFile(
	io: FileIO,
	items: PreparedItem[],
	_cwd: string,
	opts: { signal?: AbortSignal; sessionKey: string },
): Promise<ProcessedFile> {
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
		let edit: HEdit;
		try {
			edit = resEdit(
				{
					remove_from: item.remove_from,
					remove_to: item.remove_to,
					replacement_text: item.replacement_text,
				},
				warnings,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`[E_BATCH_ABORT] edits[${item.index}] (${item.path}) failed: ${message}\n` +
					"The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied.",
			);
		}

		let anchorResult: ReturnType<typeof applyEdit>;
		try {
			anchorResult = applyEdit(
				currentContent,
				edit,
				opts.signal,
				currentHashes,
				item.path,
				served,
			);
		} catch (error) {
			if (
				error instanceof AnchorMismatchError ||
				error instanceof ServedRejectionError
			) {
				const originalLines = splitLines(originalNormalized);
				const echoRows =
					error.servedRows.length > 0
						? error.servedRows
						: echoRowsForItem(edit, originalHashes);
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
			throw error;
		}

		const nextContent = anchorResult.content;
		const isNoop = nextContent === currentContent;
		const range = anchorResult.range;
		if (range.startLine < unionStartLine) {
			unionStartLine = range.startLine;
			unionStartHash = range.startHash;
		}
		if (range.endLine > unionEndLine) {
			unionEndLine = range.endLine;
			unionEndHash = range.endHash;
		}

		if (isNoop) {
			noopCount += 1;
			const payload = noopPayloadKey(
				absolutePath,
				item.remove_from,
				item.remove_to,
				item.replacement_text,
			);
			const count = trackNoopPayload(absolutePath, payload);
			if (count >= NOOP_LOOP_THRESHOLD) {
				const originalLines = splitLines(originalNormalized);
				const echoRows = echoRowsForItem(edit, originalHashes);
				if (echoRows) {
					await recordEchoServes(
						opts.sessionKey,
						absolutePath,
						echoRows,
						"live",
						originalHashes.length,
					);
				}
				throw new Error(
					`[E_NOOP_LOOP] edits[${item.index}] (${item.path}): this exact edit (anchors ${item.remove_from} to ${item.remove_to}) has been submitted ${count} times and produced no changes each time — the range already contains the replacement text. Do not resend it; it will never change the file. The whole batch was rejected and nothing was written.` +
						(echoRows
							? ` Current on-disk range:\n${fmtServedRows(echoRows, originalLines)}`
							: ""),
				);
			}
			if (count === 2) {
				warnings.push(
					`[E_NOOP_LOOP] Notice: edits[${item.index}] (${item.path}) — this exact edit has produced no changes twice in a row; the range already contains the replacement text. Resending it again will reject the batch.`,
				);
			}
			warnings.push(
				`edits[${item.index}] (${item.path}) was a noop: the range already contains the replacement text.`,
			);
			if (anchorResult.warnings?.length)
				warnings.push(...anchorResult.warnings);
			continue;
		}

		appliedCount += 1;
		const removedHashes = collectRemovedHashes(edit, currentHashes);
		const nextHashes = await lineHashes(
			nextContent,
			absolutePath,
			{ content: currentContent, hashes: currentHashes, removedHashes },
			undefined,
			false,
		);
		const { totalAddedLines: added, totalRemovedLines: removed } =
			countLineChanges(
				edit,
				originalHashes,
				false,
				anchorResult.autoFixes?.length ?? 0,
			);
		totalAddedLines += added;
		totalRemovedLines += removed;
		lastApplied = {
			content: currentContent,
			hashes: currentHashes,
			removedHashes,
		};
		currentContent = nextContent;
		currentHashes = nextHashes;
		clearNoopLoop(absolutePath);
		if (anchorResult.warnings?.length) warnings.push(...anchorResult.warnings);
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

function toSection(file: ProcessedFile): BatchSection {
	return {
		path: file.displayPath,
		originalNormalized: file.originalNormalized,
		result: file.result,
		originalHashes: file.originalHashes,
		resultHashes: file.resultHashes,
		warnings: file.warnings,
		driftNotice: file.driftNotice,
		appliedCount: file.appliedCount,
		noopCount: file.noopCount,
		totalAddedLines: file.totalAddedLines,
		totalRemovedLines: file.totalRemovedLines,
	};
}

/**
 * Register the `batch_edit` tool on the calling agent's scope.
 * @param _rootCtx - host context.
 * @param agentCtx - the agent's scoped context (own scope layer).
 * @param io - the filesystem bridge.
 * @returns the exact disposer that unregisters the tool.
 */
export function buildBatchEditTool(io: FileIO, sandbox: FsSandboxController) {
	return defineTool({
		name: "batch_edit",
		description: BATCH_EDIT_DESCRIPTION,
		parameters: {
			edits: {
				type: "array",
				required: true,
				description:
					`Ordered list of edits, each with the same shape as the edit tool: { path?, remove_from, remove_to, replacement_text }. ` +
					"Edits to the same file are applied in order and verified against what was served before anything is written. " +
					"The batch is all-or-nothing: if any edit fails validation, nothing is written and the failing edit\u2019s current range is served back. " +
					"Use batch_edit when you have multiple edits; do not issue several edit calls in one message.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: pathSchema,
						remove_from: removeFromSchema,
						remove_to: removeToSchema,
						replacement_text: replacementTextSchema,
					},
				},
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }],
		},
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
				const cwd = execCwd(exec);
				const sessionKey = execSessionKey(exec);
				const signal = exec.signal;

				const canonical = normReq(args);
				if (isRec(canonical) && Array.isArray(canonical.edits)) {
					canonical.edits = canonical.edits.map((item: unknown) => {
						if (!isRec(item)) return item;
						const cloned = { ...item };
						normalizeFilePath(cloned);
						return cloned;
					});
				}
				assertBatchReq(canonical);
				const sandboxPolicy = await sandbox.resolvePolicy(
					"batch_edit",
					canonical as unknown as FsEscalationArgs,
					exec,
				);

				const items = await prepareItems(io, canonical, cwd, signal);
				const groups = groupByPath(items);

				const processed: ProcessedFile[] = [];
				for (const groupItems of groups.values()) {
					abortIf(signal);
					processed.push(
						await processFile(io, groupItems, cwd, {
							signal,
							sessionKey,
						}),
					);
				}

				const undos: Array<{
					file: ProcessedFile;
					restore: () => Promise<void>;
				}> = [];
				for (const file of processed) {
					if (file.appliedCount === 0) continue;
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
								console.error(
									"Failed to restore undo entry after batch abort:",
									error,
								);
							}
						}
						throw new Error(
							"[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the batch was NOT applied and no file was written. Retry the batch, or use write if the store cannot be recovered.",
						);
					}
					undos.push({ file, restore: undo.restore });
				}

				const written: Array<{
					file: ProcessedFile;
					restore: () => Promise<void>;
				}> = [];
				try {
					for (const u of undos) {
						abortIf(signal);
						await io.writeText(
							u.file.absolutePath,
							u.file.bom + restoreEndings(u.file.result, u.file.originalEnding),
							signal,
							exec,
							sandboxPolicy,
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
								exec,
								sandboxPolicy,
							);
						} catch (restoreError) {
							console.error(
								"Failed to restore file after batch write failure:",
								restoreError,
							);
						}
						try {
							await w.restore();
						} catch (restoreError) {
							console.error(
								"Failed to restore undo entry after batch write failure:",
								restoreError,
							);
						}
					}
					throw sandbox.mapError(error, sandboxPolicy);
				}

				const result = buildBatchResult(processed.map(toSection));
				if (result.details.servedRows && result.details.servedRows.length > 0) {
					const byPath = result.details.servedByPath ?? [];
					for (const entry of byPath) {
						if (entry.servedRows.length === 0) continue;
						const file = processed.find((f) => f.displayPath === entry.path);
						if (file) {
							await recordServedTruncated(
								sessionKey,
								file.absolutePath,
								entry.servedRows,
								splitLines(file.result).length,
								file.range.startLine - 1,
							);
						}
					}
				}
				return result.content[0]!.text;
			});
		},
	});
}

/**
 * Register the hashline tool on the calling agent’s scope (own layer).
 */
export function registerBatchEditTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
	sandbox: FsSandboxController,
): () => void {
	return agentCtx.tools.register(buildBatchEditTool(io, sandbox));
}
