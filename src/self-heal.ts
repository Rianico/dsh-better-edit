/**
 * Self-healing watcher for hash-anchored tools.
 * Restores `read`/`edit` on the agent's own scope layer if an external
 * preset deletes them (e.g. router-standard stage advance).
 * See Rianico/dsh-better-edit#43.
 * @module dsh-better-edit/self-heal
 */

export interface SelfHealOptions {
	// SAFETY: Cordis Context.get is service-specific and returns an untyped service instance — narrow immediately at use site to the tools service shape
	agentId: string;
	rootCtx: { logger: { warn(msg: string): void; error(msg: string): void }; get(service: string): any };
	agent: unknown;
	agentCtx: { tools: { register(def: unknown): () => void }; on(event: string, handler: () => void): () => void };
	toolsSvc: unknown;
	hashReadDef: unknown;
	hashEditDef: unknown;
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
		healMinIntervalMs = 1000,
	} = options;

	let lastHealAt = 0;
	let healCount = 0;
	let selfHealDisabled = false;

	const stop = agentCtx.on("tools/change", () => {
		try {
			if (selfHealDisabled) return;
			// SAFETY: toolsSvc is the DSH tools service — shape is `layers.scoped: Map<agent, {tools}>` per cordis internals; narrow at boundary
			const layer = (toolsSvc as unknown as { layers?: { scoped?: Map<unknown, { tools?: unknown }> } })
				?.layers?.scoped?.get?.(agent)?.tools as
				| { get?: (name: string) => unknown; data?: Map<string, unknown> }
				| undefined;
			const currentRead = layer?.get?.("read") ?? layer?.data?.get?.("read");
			const currentEdit = layer?.get?.("edit") ?? layer?.data?.get?.("edit");
			const readOk = currentRead === hashReadDef;
			const editOk = currentEdit === hashEditDef;
			if (readOk && editOk) return;
			const now = Date.now();
			if (now - lastHealAt < healMinIntervalMs) return;
			if (healCount >= 2) {
				selfHealDisabled = true;
				try {
					rootCtx.logger.error(
						`dsh-better-edit: repeated takeover of edit detected; self-heal disabled for agent ${agentId} \u2014 edit will remain built-in for this session \u2014 see Rianico/dsh-better-edit#43`,
					);
				} catch {
					// ignore — logger may throw in mock
				}
				return;
			}
			healCount++;
			lastHealAt = now;
			const restoreRead = !readOk;
			const restoreEdit = !editOk;
			const restoreCount = healCount;
			queueMicrotask(() => {
				try {
					// SAFETY: re-read layer inside microtask — same shape as above
					const currentLayer = (toolsSvc as unknown as { layers?: { scoped?: Map<unknown, { tools?: unknown }> } })
						?.layers?.scoped?.get?.(agent)?.tools as
						| { get?: (name: string) => unknown; data?: Map<string, unknown> }
						| undefined;
					if (restoreEdit) {
						try {
							currentLayer?.data?.delete?.("edit");
						} catch {
							// ignore — best-effort delete of intruding entry
						}
						try {
							agentCtx.tools.register(hashEditDef);
						} catch (e) {
							rootCtx.logger.warn(
								`dsh-better-edit: self-heal failed for agent ${agentId}: ${e instanceof Error ? e.message : String(e)} \u2014 see Rianico/dsh-better-edit#43`,
							);
							return;
						}
						rootCtx.logger.warn(
							`dsh-better-edit: restored hash-anchored edit after external takeover \u2014 agent ${agentId} (${restoreCount}/2) \u2014 see Rianico/dsh-better-edit#43`,
						);
					}
					if (restoreRead) {
						try {
							currentLayer?.data?.delete?.("read");
						} catch {
							// ignore — best-effort delete of intruding entry
						}
						try {
							agentCtx.tools.register(hashReadDef);
						} catch (e) {
							rootCtx.logger.warn(
								`dsh-better-edit: self-heal failed for agent ${agentId}: ${e instanceof Error ? e.message : String(e)} \u2014 see Rianico/dsh-better-edit#43`,
							);
							return;
						}
						rootCtx.logger.warn(
							`dsh-better-edit: restored hash-anchored read after external takeover \u2014 agent ${agentId} (${restoreCount}/2) \u2014 see Rianico/dsh-better-edit#43`,
						);
					}
				} catch (error) {
					rootCtx.logger.warn(
						`dsh-better-edit: self-heal failed for agent ${agentId}: ${error instanceof Error ? error.message : String(error)} \u2014 see Rianico/dsh-better-edit#43`,
					);
				}
			});
		} catch (error) {
			try {
				rootCtx.logger.warn(
					`dsh-better-edit: self-heal failed for agent ${agentId}: ${error instanceof Error ? error.message : String(error)} \u2014 see Rianico/dsh-better-edit#43`,
				);
			} catch {
				// ignore — logger may throw in mock
			}
		}
	});
	return stop;
}
