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
import { normalizeEncoding } from "./encoding.js";

import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./workspace-context.js";
import { withWorkspace } from "./workspace-context.js";

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
			encoding: {
				type: "string",
				description: "Text encoding for Reopen with Encoding (e.g. gbk, shift_jis, windows-1251). Case-insensitive.",
			},
		},
		output: {
			schema: { type: "object", properties: { text: { type: "string", required: true }, warning: { type: "string" } }, additionalProperties: false },
			render: (_args, value) => {
				const v = value as { text: string; warning?: string } | string;
				if (typeof v === "string") return [{ type: "text", text: v }];
				const blocks: Array<{ type: "text"; text: string }> = [{ type: "text", text: v.text }];
				if (v.warning) blocks.push({ type: "text", text: v.warning });
				return blocks;
			},
		},
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
			const cwd = execCwd(exec);
			const sessionKey = execSessionKey(exec);
			const signal = exec.signal;

			const encoding = (args as Record<string, unknown>).encoding as string | undefined;
			if (encoding !== undefined) {
				const norm = normalizeEncoding(String(encoding));
				if (!norm) throw new Error(`[E_BAD_ENCODING] Unknown encoding: ${String(encoding)}. Supported: utf8, gbk, big5, shift_jis, euc-kr, windows-1251, iso-8859-1`);
			}
			const canonical = normReq(args);
			assertReadRequest(canonical);
			const rawPath = canonical.path;

			const { text, absolutePath, warning } = await readAndServe(
				io,
				rawPath,
				cwd,
				{
					sessionKey,
					signal,
					offset: canonical.offset,
					limit: canonical.limit,
					encoding: encoding as string | undefined,
				},
			);
			// Record the present observation with the fs policy gate so later
			// built-in write/edit calls see this file as observed at the
			// version the model just read (a no-op when no policy listens).
			await io.emitObserved(absolutePath, exec, signal);

			return warning ? { text, warning } : { text };
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
