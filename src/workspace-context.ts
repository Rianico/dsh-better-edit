/**
 * WorkspaceContext — deep module owning execution context propagation.
 *
 * Single job: propagate `cwd` and `sessionKey` from the DSH tool execution
 * into the plugin's async chain. Previously co-located inside
 * `session-view.ts` (served+drift+workspace+paths re-exports) as
 * "private to this seam, @internal" with an AsyncLocalStorage. That god
 * seam mixed two invariants: served-merge+drift vs context propagation.
 *
 * Deleting this module would scatter `withWorkspace`/`workspaceCwd` and
 * `execCwd`/`execSessionKey`/`sessionKeyFor` across every tool and IO
 * caller — it concentrates (deep). Tested via scoped-execution tests,
 * not drift.
 *
 * @module dsh-better-edit/workspace-context
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";

// --- AsyncLocalStorage for cwd propagation ---
const current = new AsyncLocalStorage<string>();

export function withWorkspace<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  return current.run(cwd, fn);
}

export function workspaceCwd(): string | undefined {
  return current.getStore();
}

// --- sessionKey helpers ---

// WHY: (#165) there is deliberately no fallback key: a minted key that was never served anything
// WHY: makes every lease lookup miss and surfaces a misleading E_UNKNOWN_ANCHOR. Entrypoints
// WHY: without a session fail here, at the boundary, with the real cause.
export function sessionKeyFor(sessionId?: string): string {
  if (sessionId && sessionId.length > 0) return sessionId;
  throw new Error(
    "sessionKeyFor: tool context carries no session — entrypoints must supply the ToolExecution's session id",
  );
}

export function execCwd(exec: ToolExecution): string {
  return exec.agent?.session.header.cwd ?? process.cwd();
}

export function execSessionKey(exec: ToolExecution): string {
  return sessionKeyFor(exec.agent?.session.id);
}
