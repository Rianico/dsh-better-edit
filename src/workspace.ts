/**
 * Per-call workspace context. dsh serves several sessions in one process, each
 * with its own cwd, and only the tool execution knows which one it belongs to —
 * so a module-global "current cwd" would race between parallel sessions. The
 * store path is derived per tool call from the session cwd; this module carries
 * that cwd through the async execution so every store access inside the call
 * (served rows, undo, hash snapshots) lands in the right per-workspace store.
 * @module dsh-better-edit/workspace
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const current = new AsyncLocalStorage<string>()

/**
 * Run `fn` with the given workspace cwd active for this async execution.
 * Every `loadHashStore()` (and any store access) inside `fn` resolves the
 * `<cwd>/.dsh_better_edit` store.
 * @param cwd - the session workspace root (absolute).
 * @param fn - the tool body.
 * @returns the body's result.
 */
export function withWorkspace<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
	return current.run(cwd, fn)
}

/**
 * The workspace cwd active for this async execution, or undefined outside a
 * tool call (tests, previews, startup) — callers fall back to the shared
 * `$DSH_HOME` store then.
 */
export function workspaceCwd(): string | undefined {
	return current.getStore()
}
