/**
 * Self-healing watcher for hash-anchored tools.
 * Restores the hashline tools the install actually registered when an external
 * preset deletes them (e.g. router-standard stage advance). The heal set is the
 * installed set: a tool the preset gate declined has no definition to restore,
 * so a `tools/change` can never resurrect it (Rianico/dsh-better-edit#110).
 * See Rianico/dsh-better-edit#43.
 * @module dsh-better-edit/self-heal
 */

import { getAgentScopedToolLayer, reclaimToolEntry } from "./reclaim.js";

export interface SelfHealOptions {
  // HACK: Cordis Context.get is service-specific and returns an untyped service instance — narrow immediately at use site to the tools service shape
  agentId: string;
  rootCtx: {
    logger: { warn(msg: string): void; error(msg: string): void };
    get(service: string): any;
  };
  agent: unknown;
  agentCtx: {
    tools: { register(def: unknown): () => void };
    on(event: string, handler: () => void): () => void;
  };
  toolsSvc: unknown;
  hashReadDef: unknown;
  /**
   * Omitted when the preset gate declined the hashline `edit`: an absent
   * definition is the watcher's "never heal this" signal, not a takeover.
   */
  hashEditDef?: unknown;
  /** ADR-0015 shadow def; when present the watcher also heals `str_replace_editor`. */
  hashStrReplaceDef?: unknown;
  healMinIntervalMs?: number;
}

export function createSelfHealWatcher(options: SelfHealOptions): () => void {
  const {
    agentId,
    rootCtx,
    agent,
    agentCtx,
    toolsSvc,
    hashReadDef,
    hashEditDef,
    hashStrReplaceDef,
    healMinIntervalMs = 1000,
  } = options;
  const watchEdit = hashEditDef !== undefined;
  const watchStrReplace = hashStrReplaceDef !== undefined;

  let lastHealAt = 0;
  let healCount = 0;
  let selfHealDisabled = false;

  const formatFailMsg = (error: unknown): string =>
    `dsh-better-edit: self-heal failed for agent ${agentId}: ${error instanceof Error ? error.message : String(error)} \u2014 see Rianico/dsh-better-edit#43`;
  const formatRestoredMsg = (toolLabel: string, attempt: number): string =>
    `dsh-better-edit: restored ${toolLabel} after external takeover \u2014 agent ${agentId} (${attempt}/2) \u2014 see Rianico/dsh-better-edit#43`;

  const stop = agentCtx.on("tools/change", () => {
    try {
      if (selfHealDisabled) return;
      const layer = getAgentScopedToolLayer(toolsSvc, agent);
      if (!layer) return;
      const currentRead = layer?.get?.("read") ?? layer?.data?.get?.("read");
      const currentEdit = layer?.get?.("edit") ?? layer?.data?.get?.("edit");
      const readOk = currentRead === hashReadDef;
      const editOk = !watchEdit || currentEdit === hashEditDef;
      const currentStrReplace = watchStrReplace
        ? (layer?.get?.("str_replace_editor") ?? layer?.data?.get?.("str_replace_editor"))
        : hashStrReplaceDef;
      const strReplaceOk = !watchStrReplace || currentStrReplace === hashStrReplaceDef;
      if (readOk && editOk && strReplaceOk) return;
      const now = Date.now();
      if (now - lastHealAt < healMinIntervalMs) return;
      if (healCount >= 2) {
        selfHealDisabled = true;
        try {
          rootCtx.logger.error(
            `dsh-better-edit: repeated takeover of edit detected; self-heal disabled for agent ${agentId} \u2014 edit will remain built-in for this session \u2014 see Rianico/dsh-better-edit#43`,
          );
        } catch {
          // HACK: ignore — logger may throw in mock
        }
        return;
      }
      healCount++;
      lastHealAt = now;
      const restoreRead = !readOk;
      const restoreEdit = !editOk;
      const restoreStrReplace = watchStrReplace && !strReplaceOk;
      const restoreCount = healCount;
      queueMicrotask(() => {
        try {
          const currentLayer = getAgentScopedToolLayer(toolsSvc, agent);
          if (!currentLayer) return;
          const restoreTool = (name: string, def: unknown, toolLabel: string): boolean => {
            reclaimToolEntry(currentLayer, name);
            try {
              agentCtx.tools.register(def);
            } catch (e) {
              rootCtx.logger.warn(formatFailMsg(e));
              return false;
            }
            rootCtx.logger.warn(formatRestoredMsg(toolLabel, restoreCount));
            return true;
          };
          if (restoreEdit) {
            if (!restoreTool("edit", hashEditDef, "hash-anchored edit")) return;
          }
          if (restoreStrReplace) {
            if (
              !restoreTool("str_replace_editor", hashStrReplaceDef, "governed str_replace_editor")
            )
              return;
          }
          if (restoreRead) {
            if (!restoreTool("read", hashReadDef, "hash-anchored read")) return;
          }
        } catch (error) {
          rootCtx.logger.warn(formatFailMsg(error));
        }
      });
    } catch (error) {
      try {
        rootCtx.logger.warn(formatFailMsg(error));
      } catch {
        // HACK: ignore — logger may throw in mock
      }
    }
  });
  return stop;
}
