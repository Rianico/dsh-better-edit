/**
 * dsh-better-edit — hash-anchored read/edit/batch_edit/undo_last_edit for
 * DeepSeek Harness, a dsh port of pi-hashline-edit-lsz.
 *
 * Cordis host-plane plugin (mounted by the bundle's cordis.patch.yml). On
 * `agent/session-start` it registers the hashline tools and prompt sections on
 * the AGENT's own scope layer, so they shadow the preset's built-in `read` /
 * `edit` for that agent (nearest layer wins in dsh's tool registry) and unwind
 * automatically when the agent is disposed. The built-in `write` stays in
 * place; a scoped `tools/post-execute` listener appends the fresh hashline
 * preview to write results.
 * @module dsh-better-edit
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { ctxFsIO } from './fs-bridge.js'
import { registerReadTool } from './tool-read.js'
import { registerEditTool } from './tool-edit.js'
import { registerBatchEditTool } from './tool-batch-edit.js'
import { registerUndoTool } from './tool-undo.js'
import { registerWriteHook } from './write-hook.js'

import { initHasher } from './hashline/hasher.js'
import { pruneMissingAll } from './snapshot-store.js'
import {
	EDIT_DESCRIPTION,
	EDIT_GUIDELINES,
	READ_GUIDELINES,
	BATCH_EDIT_GUIDELINES,
	UNDO_GUIDELINES,
} from './prompts.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-better-edit'

/**
 * Services the plugin's per-agent install touches: `tools` and `systemPrompt`
 * for the shadow registrations, `fs` for the IO bridge. Cordis refuses
 * property access to an undeclared service ("cannot get property X without
 * inject"), so these MUST be listed or every agent install fails at
 * session-start.
 */
export const inject = ['tools', 'systemPrompt', 'fs']

/** One per-agent registration bundle, disposed with the agent. */
interface AgentTools {
	dispose(): void
}

function installAgentTools(
	rootCtx: Context,
	agent: Agent,
): () => void {
	return agent.ctx.effect(() => {
		// `fs` is host-plane: use the plugin's own context (covered by
		// inject) rather than the agent's scoped one, whose fiber chain does
		// not declare it. Session cwd still reaches the bridge per call via
		// exec.agent.session.header.cwd.
		const io = ctxFsIO(rootCtx.fs as FileSystem, rootCtx)
		const disposers: Array<() => void> = []
		disposers.push(registerReadTool(rootCtx, agent.ctx, io))
		disposers.push(registerEditTool(rootCtx, agent.ctx, io))
		disposers.push(registerBatchEditTool(rootCtx, agent.ctx, io))
		disposers.push(registerUndoTool(rootCtx, agent.ctx, io))
		disposers.push(registerWriteHook(rootCtx, agent.ctx, io))

		// Shadow the preset's built-in tool guidance with the hashline contract.
		// Same section names on the agent's own layer win over the preset's.
		disposers.push(agent.ctx.systemPrompt.section({
			name: 'tool:edit',
			order: 102,
			text: [
				EDIT_DESCRIPTION,
				'',
				EDIT_GUIDELINES.map((line) => `- ${line}`).join('\n'),
			].join('\n'),
		}))
		disposers.push(agent.ctx.systemPrompt.section({
			name: 'tool:read',
			order: 100,
			text: [
				'Use the read tool — not shell commands like cat — to inspect text files.',
				'',
				READ_GUIDELINES.map((line) => `- ${line}`).join('\n'),
			].join('\n'),
		}))
		disposers.push(agent.ctx.systemPrompt.section({
			name: 'tool:batch_edit',
			order: 103,
			text: BATCH_EDIT_GUIDELINES.map((line) => `- ${line}`).join('\n'),
		}))
		disposers.push(agent.ctx.systemPrompt.section({
			name: 'tool:undo_last_edit',
			order: 104,
			text: UNDO_GUIDELINES.map((line) => `- ${line}`).join('\n'),
		}))

		return () => {
			for (const dispose of disposers) dispose()
		}
	})
}

/** Mount the bundle: initialize the store, then install tools per agent. */
export function apply(rootCtx: Context): void {
	// Warm the hasher and prune missing snapshots once; failures are non-fatal
	// (each store operation retries on demand).
	initHasher()
		.then(() => pruneMissingAll())
		.catch((error) => {
			rootCtx.logger.warn(
				`dsh-better-edit: hash-store warm-up failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		})

	const registered = new WeakSet<Agent>()
	rootCtx.on('agent/session-start', ({ agent }) => {
		if (registered.has(agent)) return
		registered.add(agent)
		try {
			installAgentTools(rootCtx, agent)
		} catch (error) {
			rootCtx.logger.warn(
				`dsh-better-edit: failed to install tools for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	})
}

export type { AgentTools }
