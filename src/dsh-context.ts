/**
 * dsh execution-context helpers shared by the tool layer: session cwd and
 * served-state session key derived from the dsh {@link ToolExecution}.
 * @module dsh-better-edit/dsh-context
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { sessionKeyFor } from './served-store.js'

/**
 * The workspace directory a model-facing filesystem tool resolves relative
 * paths against: the calling agent's per-session cwd (each session's tools act
 * on ITS workspace), falling back to the process cwd for non-agent callers.
 * Mirrors how `dsh-tool-bash` defaults a bash `workdir` to the session cwd.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the session cwd, or the process cwd when no agent applies.
 */
export function execCwd(exec: ToolExecution): string {
	return exec.agent?.session.header.cwd ?? process.cwd()
}

/**
 * The served-state session key for one execution: the live session id. A
 * stable key per session keeps served rows (what the model was shown) and
 * undo history correctly scoped — never shared across sessions.
 * @param exec - the tool-execution context.
 * @returns the session key.
 */
export function execSessionKey(exec: ToolExecution): string {
	return sessionKeyFor(exec.agent?.session.id)
}
