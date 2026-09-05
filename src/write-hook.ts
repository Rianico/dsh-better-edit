/**
 * Guard + auto-read around `write`: a scoped `tools/pre-execute` listener
 * rejects copied hashline preview rows before they can reach disk, then a
 * `tools/post-execute` listener re-reads successful writes and appends fresh
 * anchors to the model-facing content (mirroring pi-hashline-edit-lsz).
 * @module dsh-better-edit/write-hook
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { readAndServe } from './read-and-serve.js'
import type { FileIO } from './fs-bridge.js'
import { execCwd, execSessionKey, withWorkspace } from './workspace-context.js'
import { loadServed } from './session-view.js'
import { HASH_SEP } from './hashline/hash-assign.js'
import { abortIf, splitLines } from './utils.js'

const AUTO_READ_HEADING = '--- Auto-read (hashline anchors) ---'

export interface ServedHashEcho {
	/** One-based candidate line carrying the copied anchor. */
	line: number
	/** The exact anchor served for this session, path, and line. */
	hash: string
}

/**
 * Find a copied hashline prefix without treating arbitrary `3-char│` text as
 * metadata. A match requires the exact hash currently recorded at the same
 * line position for this session and canonical path.
 */
export function findServedHashEcho(
	content: string,
	served: readonly (string | null)[],
): ServedHashEcho | undefined {
	const lines = splitLines(content)
	const compared = Math.min(lines.length, served.length)
	for (let index = 0; index < compared; index += 1) {
		const hash = served[index]
		if (hash !== null && lines[index]!.startsWith(`${hash}${HASH_SEP}`)) {
			return { line: index + 1, hash }
		}
	}
	return undefined
}

/**
 * Inspect one validated-looking built-in write request against session-scoped
 * served state. Returns a pre-dispatch denial reason only for an exact
 * same-session / same-canonical-path / same-line anchor echo.
 */
export async function servedHashEchoDenial(
	io: FileIO,
	rawPath: string,
	content: string,
	cwd: string,
	sessionKey: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	abortIf(signal)
	const absolutePath = await io.resolve(rawPath, cwd, signal)
	abortIf(signal)
	const served = await loadServed(sessionKey, absolutePath)
	const match = findServedHashEcho(content, served)
	if (!match) return undefined
	return (
		`[MODEL] [E_SERVED_ECHO] Refused write to ${rawPath}: line ${match.line} begins with ` +
		`the exact ${match.hash}${HASH_SEP} anchor served for this session, path, and line. ` +
		`HASH${HASH_SEP} anchors are tool output, not file content. ` +
		'Retry with file content only (remove the entire copied anchor chain). Nothing was written.'
	)
}

/**
 * Register the pre-write echo guard and post-write auto-read on the calling
 * agent's scope. The guard denies before dispatch; the auto-read replaces only
 * model-facing result content (never the canonical value). Infrastructure
 * failures fail open so the plugin never breaks an otherwise valid write.
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
	const disposeGuard = agentCtx.on(
		'tools/pre-execute',
		async (
			exec: ToolExecution,
			next: () => Promise<PreToolDecision>,
		): Promise<PreToolDecision> => {
			if (exec.name !== 'write') return next()
			const args = exec.arguments as Record<string, unknown> | undefined
			const rawPath = args?.file_path ?? args?.path
			const content = args?.content
			if (typeof rawPath !== 'string' || typeof content !== 'string') return next()

			const cwd = execCwd(exec)
			return withWorkspace(cwd, async () => {
				try {
					const reason = await servedHashEchoDenial(
						io,
						rawPath,
						content,
						cwd,
						execSessionKey(exec),
						exec.signal,
					)
					return reason === undefined ? next() : { kind: 'deny', reason }
				} catch (error) {
					if (exec.signal.aborted) throw error
					rootCtx.logger.warn(
						`dsh-better-edit: pre-write hash-echo guard failed open: ${error instanceof Error ? error.message : String(error)}`,
					)
					return next()
				}
			})
		},
	)
	const disposeAutoRead = agentCtx.on(
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
	return () => {
		disposeGuard()
		disposeAutoRead()
	}
}
