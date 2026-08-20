/**
 * The dsh `undo_last_edit` tool: reverts the last hashline edit on a file,
 * only when the file still matches the stored post-edit content — a later
 * external write clears the history instead of being overwritten.
 * @module dsh-better-edit/tool-undo
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { toLF, stripBOM, genDiff, restoreEndings } from "./edit-diff.js";
import { cntDiff, splitLines } from "./utils.js";
import { assertUndoRequest } from "./contract.js";
import { normalizeRequest as normReq } from "./contract.js";
import { upsertSnapshotFor } from "./hash-store.js";
import { contentChecksum } from "./hashline/hasher.js";
import { lineHashes, changedRange } from "./hashline/index.js";
import { getUndo, clearUndo } from "./undo-edit.js";
import { recordServedTruncated } from "./served-store.js";
import { UNDO_DESCRIPTION } from "./prompts.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./dsh-context.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { withWorkspace } from "./workspace.js";

/**
 * Register the `undo_last_edit` tool on the calling agent's scope.
 * @param _rootCtx - host context.
 * @param agentCtx - the agent's scoped context (own scope layer).
 * @param io - the filesystem bridge.
 * @returns the exact disposer that unregisters the tool.
 */
export function buildUndoTool(io: FileIO, sandbox: FsSandboxController) {
	return defineTool({
		name: "undo_last_edit",
		description: UNDO_DESCRIPTION,
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Path to the file to undo",
			},
			...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
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
			assertUndoRequest(canonical);
			const path = canonical.path;
			const absolutePath = await io.resolve(path, cwd, signal);
			const sandboxPolicy = await sandbox.resolvePolicy("undo_last_edit", canonical as unknown as FsEscalationArgs, exec);

			const undo = await getUndo(absolutePath);
			if (!undo) {
				return `No undo history for ${path}. There is no previous edit to revert.`;
			}

			let currentRaw: string;
			try {
				currentRaw = await io.readText(absolutePath, signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("[E_NOT_FOUND]")) {
					await clearUndo(absolutePath);
					return `[E_UNDO_STALE] Cannot undo last edit on ${path}: the file no longer exists. Call read() to inspect the current state.`;
				}
				throw error;
			}
			if (
				currentRaw !==
				undo.bom + restoreEndings(undo.resultContent, undo.originalEnding)
			) {
				await clearUndo(absolutePath);
				return `[E_UNDO_STALE] Cannot undo last edit on ${path}: the file was modified after the edit, so undoing would overwrite those changes. Call read() to inspect the current state.`;
			}

			const { text: currentStripped } = stripBOM(currentRaw);
			const currentNormalized = toLF(currentStripped);
			const currentHashes = await lineHashes(currentNormalized, absolutePath);
			const diffResult = genDiff(
				undo.content,
				currentNormalized,
				0,
				undefined,
				undo.hashes,
			);
			const linesAddedByEdit = cntDiff(diffResult.diff, "+");
			const linesRemovedByEdit = cntDiff(diffResult.diff, "-");
			const undoDiffResult = genDiff(
				currentNormalized,
				undo.content,
				1,
				undo.hashes,
				currentHashes,
			);
			const undoDiff = undoDiffResult.diff;
			const restoredRange = changedRange(currentNormalized, undo.content);

			try {
				await io.writeText(
					absolutePath,
					undo.bom + restoreEndings(undo.content, undo.originalEnding),
					signal,
					exec,
					sandboxPolicy,
				);
			} catch (error) {
				throw sandbox.mapError(error, sandboxPolicy);
			}

			try {
				await upsertSnapshotFor(
					absolutePath,
					contentChecksum(undo.content),
					splitLines(undo.content).length,
					undo.hashes,
				);
			} catch (error) {
				console.error(
					"Failed to restore hash store snapshot after undo:",
					error,
				);
			}

			await clearUndo(absolutePath);

			const parts: string[] = [`Undone last edit on ${path}.`];
			if (linesAddedByEdit > 0 || linesRemovedByEdit > 0) {
				parts.push(
					`Removed ${linesAddedByEdit} line(s) that were added and restored ${linesRemovedByEdit} line(s) that were removed.`,
				);
			}
			parts.push(
				"File reverted to previous state. The post-edit diff rows carry the restored file\u2019s fresh anchors for follow-up edits.",
			);

			if (undoDiffResult.servedRows.length > 0) {
				await recordServedTruncated(
					sessionKey,
					absolutePath,
					undoDiffResult.servedRows,
					splitLines(undo.content).length,
					restoredRange?.firstChangedLine ?? 0,
				);
			}

			return [parts.join("\n"), "", "Diff of the revert:", "", undoDiff].join(
				"\n",
			);
			})
		},
	});
}

/**
 * Register the hashline tool on the calling agent’s scope (own layer).
 */
export function registerUndoTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
	sandbox: FsSandboxController,
): () => void {
	return agentCtx.tools.register(buildUndoTool(io, sandbox));
}
