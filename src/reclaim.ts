/**
 * Shared tool reclamation utility for DSH scoped layers.
 * Used by installAgentTools and createSelfHealWatcher.
 * @module dsh-better-edit/reclaim
 */

export interface ScopedToolLayer {
  get?: (name: string) => unknown;
  data?: Map<string, unknown>;
}

export interface LoggerChannel {
  warn(msg: string): void;
  error?(msg: string): void;
}

/**
 * Resolve the agent's scoped tool layer from the DSH tools service.
 */
export function getAgentScopedToolLayer(
  toolsSvc: unknown,
  agent: unknown,
): ScopedToolLayer | undefined {
  // SAFETY: toolsSvc is the DSH tools service — shape is `layers.scoped: Map<agent, {tools}>` per Cordis internals; narrow at boundary
  return (
    toolsSvc as unknown as { layers?: { scoped?: Map<unknown, { tools?: unknown }> } }
  )?.layers?.scoped?.get?.(agent)?.tools as ScopedToolLayer | undefined;
}

/**
 * Reclaim an entry by deleting it from the scoped layer's data map.
 */
export function reclaimToolEntry(layer: ScopedToolLayer | undefined, name: string): boolean {
  if (!layer?.data) return false;
  try {
    const deleted = layer.data.delete(name);
    return Boolean(deleted && layer.get?.(name) === undefined);
  } catch {
    return false;
  }
}

/**
 * Register a tool with collision detection, guarded reclaim, and single retry.
 */
export function registerWithReclaim(options: {
  toolsSvc: unknown;
  agent: unknown;
  agentCtx: { tools: { register(def: unknown): () => void } };
  name: string;
  def: unknown;
  logger?: LoggerChannel;
}): (() => void) | undefined {
  const { toolsSvc, agent, agentCtx, name, def, logger } = options;
  const layer = getAgentScopedToolLayer(toolsSvc, agent);
  const current = layer?.get?.(name) ?? layer?.data?.get?.(name);
  if (current === def) return () => {};

  try {
    return agentCtx.tools.register(def);
  } catch (initialError) {
    const errorStr = String(initialError);
    const isCollision = errorStr.includes("already registered") || current != null;
    if (!isCollision) {
      logger?.warn(
        `dsh-better-edit: tool "${name}" registration failed with non-collision error: ${errorStr} (#123)`,
      );
      return undefined;
    }

    if (!layer) {
      logger?.warn(
        `dsh-better-edit: cannot reclaim tool "${name}" because scoped layer is unresolvable (#123)`,
      );
      return undefined;
    }

    const reclaimed = reclaimToolEntry(layer, name);
    if (!reclaimed) {
      logger?.warn(
        `dsh-better-edit: cannot reclaim contested tool "${name}" from scoped layer (#123)`,
      );
      return undefined;
    }

    try {
      const dispose = agentCtx.tools.register(def);
      logger?.warn(
        `dsh-better-edit: reclaimed contested tool "${name}" from peer registration (#123)`,
      );
      return dispose;
    } catch (retryError) {
      logger?.warn(
        `dsh-better-edit: failed to register tool "${name}" after reclaim: ${String(retryError)} (#123)`,
      );
      return undefined;
    }
  }
}
