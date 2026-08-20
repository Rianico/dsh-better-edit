/**
 * The dsh `batch_edit` tool: several hash-anchored edits in one all-or-nothing
 * call. Items targeting the same file are applied in order against the served
 * state; any failing item rejects the whole batch with nothing written, and
 * the failing item's current range is echoed as fresh serves. The per-file
 * sequencing and the persist-undo → write → restore transaction live in the
 * edit engine; this module owns request preparation and result rendering.
 * @module dsh-better-edit/tool-batch-edit
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	abortIf,
	isRec,
	normalizeFilePath,
	splitLines,
} from "./utils.js";
import {
	assertBatchEditRequest,
	normalizeRequest as normReq,
	type BatchEditParams,
} from "./contract.js";
import {
	persistUndoAndWrite,
	resolveMissingPath,
	runFileEdits,
	type FileEditResult,
	type PreparedItem,
} from "./mutation.js";
import { buildBatchResult, type BatchSection } from "./mutation.js";
import { recordServedTruncated } from "./session-view.js";
import { BATCH_EDIT_DESCRIPTION } from "./prompts.js";
import {
	pathSchema,
	removeFromSchema,
	removeToSchema,
	replacementTextSchema,
} from "./contract.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./session-view.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { withWorkspace } from "./session-view.js";

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

function toSection(file: FileEditResult): BatchSection {
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
 * @param sandbox - the sandbox-escalation controller.
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
				assertBatchEditRequest(canonical);
				const sandboxPolicy = await sandbox.resolvePolicy(
					"batch_edit",
					canonical as unknown as FsEscalationArgs,
					exec,
				);

				const items = await prepareItems(io, canonical, cwd, signal);
				const groups = groupByPath(items);

				const processed: FileEditResult[] = [];
				for (const groupItems of groups.values()) {
					abortIf(signal);
					processed.push(
						await runFileEdits(io, groupItems, {
							signal,
							sessionKey,
						}),
					);
				}

				await persistUndoAndWrite({
					io,
					files: processed
						.filter((file) => file.appliedCount > 0)
						.map((file) => ({
							absolutePath: file.absolutePath,
							displayPath: file.displayPath,
							originalNormalized: file.originalNormalized,
							bom: file.bom,
							originalEnding: file.originalEnding,
							originalHashes: file.originalHashes,
							result: file.result,
						})),
					exec,
					sandbox,
					sandboxPolicy,
					signal,
					undoUnavailableMessage: () =>
						"[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the batch was NOT applied and no file was written. Retry the batch, or use write if the store cannot be recovered.",
					restoreUnwrittenUndos: false,
				});

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
