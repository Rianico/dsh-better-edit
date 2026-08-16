/**
 * Auto-read after `write`: when the built-in `write` tool succeeds, this scoped
 * `tools/post-execute` listener re-reads the written file and appends a fresh
 * hashline-anchored preview to the model-facing content, so the model gets new
 * anchors without an explicit read call (mirroring pi-hashline-edit-lsz).
 * @module dsh-better-edit/write-hook
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { readAndServe } from './read-and-serve.js'
import type { FileIO } from './fs-bridge.js'
import { execCwd, execSessionKey } from './dsh-context.js'
import { withWorkspace } from './workspace.js'

const AUTO_READ_HEADING = '--- Auto-read (hashline anchors) ---'

/**
 * Register the post-write auto-read listener on the calling agent's scope.
 * Replaces the result content (never the canonical value) with the original
 * content plus the hashline preview; any failure falls back to the untouched
 * decision so a broken auto-read never breaks the write.
 * @param rootCtx - host context for diagnostics.
 * @param agentCtx - the agent's scoped context; the listener receives only
 *   this agent's tool results.
 * @param io - the filesystem bridge.
 * @returns the exact disposer that unregisters the listener.
 */
export function registerWriteHook(
	rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
): () => void {
	return agentCtx.on(
		'tools/post-execute',
		async (
			exec: ToolExecution,
			result: Readonly<ToolExecutionResult>,
			next: () => Promise<PostToolDecision>,
		): Promise<PostToolDecision> => {
			return withWorkspace(execCwd(exec), async () => {
			const decision: PostToolDecision = await next()
			if (
				exec.name !== 'write' ||
				result.isError ||
				decision.kind !== 'accept'
			) {
				return decision
			}
			const decisionContent = decision.content ?? result.content

			const rawPath = (exec.arguments as Record<string, unknown> | undefined)
				?.file_path ?? (exec.arguments as Record<string, unknown> | undefined)
				?.path
			if (typeof rawPath !== 'string') return decision

			try {
				const cwd = execCwd(exec)
				const sessionKey = execSessionKey(exec)
				const signal = exec.signal
				const { text } = await readAndServe(io, rawPath, cwd, { sessionKey, signal })
				return {
					kind: 'accept' as const,
					content: [
						...(decisionContent),
						{ type: 'text', text: `\n\n${AUTO_READ_HEADING}\n${text}` },
					],
				}
			} catch (error) {
				rootCtx.logger.warn(
					`dsh-better-edit: auto-read after write failed: ${error instanceof Error ? error.message : String(error)}`,
				)
				return decision
			}
			})
		},
	)
}
