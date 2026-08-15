/**
 * Regression tests for the sandbox integration: the mutating hashline tools
 * resolve the per-call sandbox policy with the SESSION workspace root (so
 * `workspace-write` allows edits inside the session cwd — the bug that denied
 * every edit while the built-in write succeeded), advertise the escalation
 * fields under a confining backend, and map denials to the shared `[sandbox: …]`
 * vocabulary.
 * @module dsh-better-edit/sandbox.test
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import { FsSandboxController } from '../../src/sandbox.js'

function makePolicy() {
	const resolve = vi.fn((request?: { session?: unknown }) => ({
		mode: request?.session !== undefined ? 'workspace-write' : 'danger-full-access',
		workspaceRoot: '/sessions/ws',
	}))
	return { resolve }
}

function makeCtx(mode: string | undefined) {
	const policy = makePolicy()
	const ctx = {
		fs: { sandboxMode: mode },
		get: (name: string) => (name === 'sandboxPolicy' ? policy : undefined),
	} as unknown as Context
	return { ctx, policy }
}

const exec = {
	agent: { session: { id: 'sess-1' } },
	callId: 'call-1',
	signal: new AbortController().signal,
} as unknown as ToolExecution

describe('FsSandboxController', () => {
	it('advertises nothing and resolves no policy on an unsandboxed backend', async () => {
		const { ctx } = makeCtx(undefined)
		const sandbox = new FsSandboxController(ctx)

		expect(sandbox.escalationModes).toHaveLength(0)
		await expect(sandbox.resolvePolicy('edit', {}, exec)).resolves.toBeUndefined()
	})

	it('advertises the escalation fields and resolves the session policy under a confining backend', async () => {
		const { ctx, policy } = makeCtx('workspace-write')
		const sandbox = new FsSandboxController(ctx)

		expect(sandbox.escalationModes.length).toBeGreaterThan(0)
		const fields = sandbox.schemaFields()
		expect(fields.sandbox_permissions.enum).toEqual([...sandbox.escalationModes])

		const resolved = await sandbox.resolvePolicy('edit', {}, exec)
		// The SESSION is passed to the policy resolver — that is what stamps the
		// session workspace root onto the write, keeping workspace-write edits
		// inside the session cwd from being denied.
		expect(policy.resolve).toHaveBeenCalledWith({ session: exec.agent!.session })
		expect(resolved).toMatchObject({ mode: 'workspace-write' })
	})

	it('throws when escalation args are used on a composition that advertises none', async () => {
		const { ctx } = makeCtx(undefined)
		const sandbox = new FsSandboxController(ctx)

		await expect(
			sandbox.resolvePolicy('edit', { sandbox_permissions: 'danger-full-access', justification: 'need it' }, exec),
		).rejects.toThrow(/not available in this composition/)
	})

	it('maps a sandbox denial onto the shared [sandbox: …] marker and escalation hint', () => {
		const { ctx } = makeCtx('workspace-write')
		const sandbox = new FsSandboxController(ctx)
		const denial = new FsError('denied', 'FS_SANDBOX_DENIED')

		const mapped = sandbox.mapError(denial, { mode: 'workspace-write', workspaceRoot: '/sessions/ws' })
		expect(String(mapped)).toContain('[sandbox: file access denied under workspace-write mode]')
		expect(String(mapped)).toContain('sandbox_permissions')
	})

	it('passes non-sandbox errors through unchanged', () => {
		const { ctx } = makeCtx('workspace-write')
		const sandbox = new FsSandboxController(ctx)
		const other = new Error('plain')
		expect(sandbox.mapError(other, { mode: 'workspace-write', workspaceRoot: '/sessions/ws' })).toBe(other)
	})
})
