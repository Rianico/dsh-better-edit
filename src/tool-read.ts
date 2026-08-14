/**
 * The dsh `read` tool: hash-anchored reads (`HASH│content` rows) that shadow
 * the built-in `read` on the agent's own scope layer. Every shown row is
 * recorded as served, so a later `edit` can verify the model was actually
 * shown the lines it targets.
 * @module dsh-better-edit/tool-read
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { normReq } from "./edit-normalize.js";
import { abortIf, isRec, rejectUnknownFields } from "./utils.js";
import { normFromText } from "./file-reader.js";
import { fmtReadPreview, MAX_HASH_LINES } from "./read-render.js";
import { recordServed, clearDriftReported } from "./served-store.js";
import { READ_DESCRIPTION } from "./prompts.js";
import { pathSchema } from "./schema.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./dsh-context.js";

const ROOT_KS = new Set(["path", "offset", "limit"]);

function assertReadReq(request: unknown): asserts request is {
	path: string;
	offset?: number;
	limit?: number;
} {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] Read request must be an object.");
	}
	rejectUnknownFields(request, ROOT_KS, "Read request");
	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] Read request requires a non-empty "path" string.',
		);
	}
}

/**
 * Register the hash-anchored `read` tool on the calling agent's scope.
 * @param _rootCtx - host context.
 * @param agentCtx - the agent's scoped context (own scope layer).
 * @param io - the filesystem bridge.
 * @returns the exact disposer that unregisters the tool.
 */
export function buildReadTool(io: FileIO) {
	return defineTool({
		name: "read",
		description: READ_DESCRIPTION,
		parameters: {
			path: pathSchema,
			offset: {
				type: "number",
				description: "Line number to start reading from (1-indexed)",
			},
			limit: {
				type: "number",
				description: "Maximum number of lines to read",
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }],
		},
		async execute(args, exec) {
			const cwd = execCwd(exec);
			const sessionKey = execSessionKey(exec);
			const signal = exec.signal;

			const canonical = normReq(args);
			assertReadReq(canonical);
			const rawPath = canonical.path;

			abortIf(signal);
			const absolutePath = await io.resolve(rawPath, cwd, signal);
			const rawText = await io.readText(absolutePath, signal);
			const { normalized, fileHashes, hadUtf8DecodeErrors } =
				await normFromText({
					absolutePath,
					rawText,
					displayPath: rawPath,
					signal,
					maxLines: MAX_HASH_LINES,
				});

			const preview = await fmtReadPreview(
				normalized,
				{ offset: canonical.offset, limit: canonical.limit },
				fileHashes,
				absolutePath,
			);
			if (preview.served.length > 0) {
				await recordServed(sessionKey, absolutePath, preview.served);
			}
			await clearDriftReported(sessionKey, absolutePath);
			// Record the present observation with the fs policy gate so later
			// built-in write/edit calls see this file as observed at the
			// version the model just read (a no-op when no policy listens).
			await io.emitObserved(absolutePath, exec, signal);

			return hadUtf8DecodeErrors
				? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
				: preview.text;
		},
	});
}

/**
 * Register the hashline tool on the calling agent’s scope (own layer).
 */
export function registerReadTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
): () => void {
	return agentCtx.tools.register(buildReadTool(io));
}
