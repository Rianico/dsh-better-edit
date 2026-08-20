/**
 * The dsh `read` tool: hash-anchored reads (`HASH│content` rows) that shadow
 * the built-in `read` on the agent's own scope layer. Every shown row is
 * recorded as served, so a later `edit` can verify the model was actually
 * shown the lines it targets.
 * @module dsh-better-edit/tool-read
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { normalizeRequest as normReq, assertReadRequest, pathSchema } from "./contract.js";

import { readAndServe } from "./read-and-serve.js";
import { READ_DESCRIPTION } from "./prompts.js";

import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./dsh-context.js";
import { withWorkspace } from "./workspace.js";

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
			return withWorkspace(execCwd(exec), async () => {
			const cwd = execCwd(exec);
			const sessionKey = execSessionKey(exec);
			const signal = exec.signal;

			const canonical = normReq(args);
			assertReadRequest(canonical);
			const rawPath = canonical.path;

			const { text, absolutePath } = await readAndServe(
				io,
				rawPath,
				cwd,
				{
					sessionKey,
					signal,
					offset: canonical.offset,
					limit: canonical.limit,
				},
			);
			// Record the present observation with the fs policy gate so later
			// built-in write/edit calls see this file as observed at the
			// version the model just read (a no-op when no policy listens).
			await io.emitObserved(absolutePath, exec, signal);

			return text;
			})
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
