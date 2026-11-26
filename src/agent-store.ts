/**
 * AgentStore — the attach + scope seam between one tool execution and the store lifecycle.
 *
 * Two jobs, one wrapper. ATTACH records that the calling agent uses the store for this call's
 * directory; SCOPE keeps that directory's handle open for the whole call, so a concurrent
 * disposal (the agent's Cordis effect) can only decide the close, never run it under the body.
 * The attach is best-effort by design: store bookkeeping must never fail a tool call.
 *
 * The token is the agent's stable id (`exec.agent.id`) — the same string the install's teardown
 * detaches — because one agent re-attaches idempotently on every call and detaches once. The
 * store path is resolved per CALL from `execCwd(exec)`, because one agent can move workspaces
 * through the `workingDirectory` service; the reverse index accumulates every path it touched.
 *
 * WHY A WRAPPER, NOT A REGISTRY HOOK. The registry owns dispatch, so the only per-call seam the
 * plugin owns is its own tool bodies. Wrapping `execute` in place keeps the definition object
 * identity the self-heal watcher compares against, so the guarded watch still recognises its own
 * tools after registration.
 *
 * APPLIED ONLY WHERE THE BODY TOUCHES THE STORE. Every decoration costs a path resolution, and in
 * central/custom mode that resolution creates the runtime directory and writes the `.wsPath`
 * sidecar — so a definition whose body never resolves or opens the store (`str_replace_editor`, a
 * governed mutation with no `hash-store` import) is registered undecorated.
 *
 * SCOPES MAY NEST ON ONE PATH, and nesting is safe because a scope never awaits a drain:
 * `withStoreScope` only moves the path's in-flight counter, `awaitDrainingClose` is a no-op inside its
 * own slot's scope, and the LAST scope to end is the one that finishes the pending close. Today the
 * write hook's scope and a tool body's scope are sequential, never nested; a future site that nests
 * inside one of them inherits the deferral for free — the close waits for the outermost scope.
 *
 * @module dsh-better-edit/agent-store
 */

import type { ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { execCwd } from "./workspace-context.js";
import { hashStorePath } from "./store-tenancy.js";
import { attachStore, withStoreScope } from "./store-lifecycle-slot.js";

/** Channel for a best-effort attach failure; the install passes its own logger. */
export type AttachErrorReporter = (message: string) => void;

/**
 * Attach + scope seam for one tool execution.
 *
 * The token is the agent's stable id (`exec.agent.id`), the same string `installAgentTools`
 * detaches with. The store path is resolved per CALL from `execCwd(exec)`, because one agent can
 * move workspaces through the `workingDirectory` service; the reverse index accumulates every
 * path the agent touched. Attach is best-effort: store lifecycle bookkeeping must never fail a
 * tool call.
 *
 * The body runs inside the per-path in-flight scope, so a concurrent disposal defers the close to
 * the end of this call instead of closing the handle under it. A close that fails exactly when
 * this call's scope ends rejects the CALL — the registry's documented contract — because the
 * scope's `finally` supersedes the body result; the failed close leaves the handle retryable, so
 * a later release closes it, and a teardown's detached detach promise carries the warning.
 *
 * @param exec - the execution context; its `agent.id` is the store token.
 * @param run - the tool body, run inside the attach + scope.
 * @param onAttachError - channel for a best-effort attach failure (default `console.warn`).
 */
export function withAgentStore<T>(
  exec: ToolExecution,
  run: () => Promise<T>,
  onAttachError: AttachErrorReporter = (message) => console.warn(message),
): Promise<T> {
  const token = exec.agent?.id;
  let storePath: string | undefined;
  try {
    storePath = hashStorePath(execCwd(exec));
    if (token !== undefined) attachStore(storePath, token);
  } catch (error) {
    onAttachError(
      `dsh-better-edit: store attach failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    storePath = undefined;
  }
  if (storePath === undefined) return run();
  return withStoreScope(storePath, run);
}

/**
 * One tool definition surface: enough to decorate `execute` without depending on its args.
 *
 * The exec parameter is `ToolRunContext` (what `defineTool` hands a body), not the narrower
 * `ToolExecution`: the context is a SUPERTYPE, so a definition accepting it is assignable here,
 * while a definition requiring `ToolExecution` is not.
 */
interface AgentToolDef {
  execute: (args: never, exec: ToolRunContext) => Promise<unknown>;
}

/**
 * Wraps a tool definition's `execute` in place, so the object identity self-heal compares against
 * stays the one registered. Returns the same object; `defineTool` results are extensible (verify
 * with a probe; if a def is ever frozen, build the copy BEFORE it is stored as `hash*Def` and use
 * that copy for registration and the watcher, never a second object).
 *
 * @param onAttachError - forwarded to `withAgentStore`: one channel per install, so an attach
 * failure reaches the plugin's logger instead of the console.
 */
export function wrapToolWithAgentStore<T extends AgentToolDef>(
  def: T,
  onAttachError?: AttachErrorReporter,
): T {
  const original = def.execute.bind(def);
  def.execute = ((args: never, exec: ToolRunContext) =>
    withAgentStore(exec, () => original(args, exec), onAttachError)) as T["execute"];
  return def;
}
