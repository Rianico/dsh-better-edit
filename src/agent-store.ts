/**
 * AgentStore — the attach + scope seam between one tool execution and the store lifecycle.
 *
 * ATTACH records the calling agent's use of the store for this call's directory; SCOPE keeps that
 * handle open for the whole call, so a concurrent disposal only decides the close. The token is the
 * agent's stable id and the path is resolved per call, because one agent can move workspaces.
 * Attach is best-effort, and only bodies that touch the store are decorated.
 *
 * Ref: docs/adr/0057-session-scoped-per-workspace-store-lifecycle.md
 */

import type { ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { execCwd } from "./workspace-context.js";
import { hashStorePath } from "./store-tenancy.js";
import { attachStore, withStoreScope } from "./store-lifecycle-slot.js";

/** Channel for a best-effort attach failure; the install passes its own logger. */
export type AttachErrorReporter = (message: string) => void;

/**
 * Attach + scope seam for one tool execution: the body runs inside the path's in-flight scope, so a
 * concurrent disposal defers the close to the end of this call. A close that fails when this scope
 * ends rejects the call, and the failed close leaves the handle retryable.
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
