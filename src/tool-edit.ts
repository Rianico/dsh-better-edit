/**
 * The dsh `edit` tool: hash-anchored literal range edits that shadow the
 * built-in `edit` on the agent's own scope layer. Registered through the
 * agent context so the model-facing contract (remove_from/remove_to hashes,
 * served-range verification, reject-and-serve) replaces the built-in one.
 * @module dsh-better-edit/tool-edit
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { restoreEndings } from "./edit-diff.js";
import { normReq } from "./edit-normalize.js";
import { abortIf, isRec, splitLines } from "./utils.js";
import {
	assertReq,
	execPipeline,
	resolveMissingPath,
	snapshotIdFor,
} from "./edit-pipeline.js";
import {
	buildRangeEcho,
	fmtServedRows,
	recordEchoServes,
} from "./hashline/served.js";
import { saveUndo } from "./undo-edit.js";
import {
	clearNoopLoop,
	noopPayloadKey,
	trackNoopPayload,
} from "./noop-guard.js";
import { buildNoop, buildChanged, type RMeta } from "./edit-response.js";
import { recordServedTruncated } from "./served-store.js";
import { NOOP_LOOP_THRESHOLD } from "./constants.js";
import { EDIT_DESCRIPTION } from "./prompts.js";
import {
	pathSchema,
	removeFromSchema,
	removeToSchema,
	replacementTextSchema,
} from "./schema.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./dsh-context.js";
import { withWorkspace } from "./workspace.js";

/**
 * Register the hash-anchored `edit` tool on the calling agent's scope.
 * @param _rootCtx - host context (logger, lifecycle).
 * @param agentCtx - the agent's scoped context; registrations here land on the
 *   agent's OWN scope layer, shadowing the preset's built-in `edit`.
 * @param io - the filesystem bridge (ctx.fs backed in deployment).
 * @returns the exact disposer that unregisters the tool.
 */
export function buildEditTool(io: FileIO) {
	return defineTool({
		name: "edit",
		description: EDIT_DESCRIPTION,
		parameters: {
			path: pathSchema,
			remove_from: removeFromSchema,
			remove_to: removeToSchema,
			replacement_text: replacementTextSchema,
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
			const resolution = isRec(canonical)
				? await resolveMissingPath(canonical)
				: undefined;
			if (resolution && isRec(canonical)) {
				canonical.path = resolution.path;
			}
			assertReq(canonical);

			const normalizedParams = canonical;
			const path = normalizedParams.path;
			abortIf(signal);

			const pipeline = await execPipeline(io, normalizedParams, cwd, {
				signal,
				sessionKey,
			});
			const {
				originalNormalized,
				originalHashes,
				result,
				bom,
				originalEnding,
				hadUtf8DecodeErrors,
				warnings,
				noopEdit,
				firstChangedLine,
				lastChangedLine,
				resultHashes,
				totalAddedLines,
				totalRemovedLines,
				driftNotice,
				range,
				absolutePath,
			} = pipeline;

			if (resolution) {
				warnings.unshift(resolution.warning);
			}

			const editsAttempted = 1;
			if (originalNormalized === result) {
				const payload = noopPayloadKey(
					absolutePath,
					canonical.remove_from,
					canonical.remove_to,
					canonical.replacement_text,
				);
				const count = trackNoopPayload(absolutePath, payload);

				if (count >= NOOP_LOOP_THRESHOLD) {
					const echoRows = buildRangeEcho(
						range.startLine,
						range.endLine,
						originalHashes,
					);
					const echo = fmtServedRows(echoRows, splitLines(originalNormalized));
					await recordEchoServes(sessionKey, absolutePath, echoRows, "live");
					throw new Error(
						`[E_NOOP_LOOP] This exact edit (anchors ${canonical.remove_from} to ${canonical.remove_to} in ${path}) has been submitted ${count} times and produced no changes each time — the range already contains the replacement text. Do not resend this edit; it will never change the file. Current range:\n${echo}`,
					);
				}

				if (count === 2) {
					warnings.push(
						`[E_NOOP_LOOP] Notice: this exact edit (anchors ${canonical.remove_from} to ${canonical.remove_to} in ${path}) has produced no changes twice in a row. The range already contains the replacement text; resending it again will be rejected.`,
					);
				}

				const noopSnapshotId = await snapshotIdFor(io, absolutePath, signal);
				const noopResult = buildNoop({
					path,
					noopEdit,
					snapshotId: noopSnapshotId,
					editMeta: {
						editsAttempted,
						noopEditsCount: noopEdit ? 1 : 0,
						addedLines: 0,
						removedLines: 0,
					},
					warnings,
					driftNotice,
				});
				return noopResult.content[0]!.text;
			}

			clearNoopLoop(absolutePath);

			if (hadUtf8DecodeErrors) {
				warnings.push(
					"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
				);
			}

			abortIf(signal);
			const undo = await saveUndo(absolutePath, {
				content: originalNormalized,
				bom,
				originalEnding,
				hashes: originalHashes,
				resultContent: result,
			});
			if (!undo.persisted) {
				throw new Error(
					`[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${path} is unchanged. Retry the edit, or use write if the store cannot be recovered.`,
				);
			}
			try {
				abortIf(signal);
				await io.writeText(
					absolutePath,
					bom + restoreEndings(result, originalEnding),
					signal,
					exec,
				);
			} catch (error) {
				await undo.restore();
				throw error;
			}
			const updatedSnapshotId = await snapshotIdFor(io, absolutePath, signal);

			const editMeta: RMeta = {
				editsAttempted,
				noopEditsCount: noopEdit ? 1 : 0,
				firstChangedLine,
				lastChangedLine,
				addedLines: totalAddedLines,
				removedLines: totalRemovedLines,
			};

			const successInput = {
				path,
				originalNormalized,
				originalHashes,
				result,
				resultHashes,
				warnings,
				snapshotId: updatedSnapshotId,
				editMeta,
				driftNotice,
			};
			const changed = buildChanged(successInput);
			if (changed.details.servedRows && changed.details.servedRows.length > 0) {
				await recordServedTruncated(
					sessionKey,
					absolutePath,
					changed.details.servedRows,
					splitLines(result).length,
					range.startLine - 1,
				);
			}
			return changed.content[0]!.text;
			})
		},
	});
}

/**
 * Register the hashline tool on the calling agent’s scope (own layer).
 */
export function registerEditTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
): () => void {
	return agentCtx.tools.register(buildEditTool(io));
}
