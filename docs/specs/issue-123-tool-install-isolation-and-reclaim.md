# Design Specification: Agent-Layer Tool Install Isolation & Reclaim

**Ticket:** Resolves #123 (`[BUG] agent-layer install drops every tool after a peer plugin claims edit`)  
**Related ADRs:** ADR-0015, ADR-0032  
**Status:** Approved by Reviewer (`reviewer@wG:p50`)  
**Author:** Antigravity (dsh-better-edit maintainer / `author@wG:p5X`)  
**Reviewer:** `reviewer@wG:p50` (`pi` on `opencode-go/muse-spark-1.3-contributor`)  
**Review History:**

- Run 1 (`34f7dcec`): `REWORK` (2x P1 blockers, 5x P2, 3x P3).
- Run 2 (`d9bc1b3f`): `REWORK` (2x P1: self-heal identity break + disposal race, 3x P2: stale layer capture, toolset fallback shape, resolver arity).
- Run 3 (`2a25fd91`): All P1s verified PASS. Residual P2 (undo reclaim coverage) and P3s addressed in this final version.

---

## 1. Problem Statement & Grounding Evidence

In a multi-plugin deployment (specifically reproducing under DSH `0.2.2-rc.1` with `dsh-sol-pi` and `dsh-better-edit` co-installed in profile `web`), agents fail to initialize properly:

- Only `read` and `dsh-sol-pi`'s fused `edit` are exposed to the agent.
- `str_replace_editor`, `undo_last_edit`, the `write` observation hook, the self-heal watcher, and all `tool:*` system prompt guidance sections are missing completely.

### Grounding Evidence in Codebase:

1. **Async Yield in `installAgentTools` (`src/index.ts:131-140`):**

   ```ts
   function installAgentTools(rootCtx: Context, agent: Agent): void {
     agent.ctx.effect(async () => {
       const toolset = await resolveToolset(rootCtx, agent.ctx);
   ```

   `resolveToolset` awaits `agentPresets.acquireScope` (ADR-0032 Decision 6). Because the effect function is `async`, it immediately yields control on the first microtask. A peer plugin registering synchronously inside `agent/created` finishes first and claims names in `agent.ctx.tools`.

2. **DSH Scoped Layer Uniqueness (`NamedEntries.insert`):**
   In DSH (`packages/core/src/registry.ts`, `NamedEntries`), the tool registry maintains scoped layers. While an agent scope layer shadows preset and global layers, **a duplicate name in the same scope layer throws unconditionally**:
   `Error: tool "edit" is already registered in this scope`

3. **Sequential Pipeline Failure (`src/index.ts:148-185`):**
   `installAgentTools` runs a single unbroken sequence:
   - `buildReadTool` succeeds (since `dsh-sol-pi` did not register `read`).
   - `buildEditTool` calls `agent.ctx.tools.register(hashEditDef)` and throws because `edit` is already registered.
   - The unhandled rejection terminates the entire callback. Every subsequent tool registration (`str_replace_editor`, `undo_last_edit`, `writeHook`), the self-heal watcher, and the prompt guidance registrations never execute.

4. **No Ownership Reclaim Protocol:**
   Unlike the self-heal watcher (`src/self-heal.ts:108-116`), `installAgentTools` has no logic to delete an intruding same-layer definition (`layer.data.delete(name)`). A name taken remains permanently blocked.

---

## 2. Architectural Design & Invariants

### Invariant 1: Synchronous Outer Effect & Guaranteed Disposal with `disposed` Gate

Cordis `ctx.effect(async () => ...)` returns a `Promise<disposer>`. In Cordis 4.x / DSH 0.2.x, async effect promises are not unwrapped into synchronous disposal hooks (`cordis/lib/index.js:1145 effect.then(safeCollect)`). Furthermore, if an agent is disposed while `resolveToolset` is in flight, late-arriving registrations would leak.

**Design:**

1. `installAgentTools` establishes a **synchronous outer effect** returning an immediate cleanup closure over a shared `disposers: Array<() => void>` array.
2. An explicit `disposed` boolean flag gates the lifecycle:
   - When the agent is disposed, `disposed = true`, and all existing disposers are executed.
   - If the asynchronous IIFE completes after disposal, any newly created registration is immediately disposed and discarded via `registerDisposer`.

### Invariant 2: Self-Heal Identity Anchor Preserved

`src/self-heal.ts` checks ownership via `currentRead === hashReadDef`.

- The installer preserves the Step 1 `hashReadDef` reference constructed by `buildReadTool(io)` in the outer scope and passes that exact reference to `createSelfHealWatcher`. Under no circumstances is `hashReadDef` read from `layer.get("read")` (which could ratify an intruding peer definition).

### Invariant 3: Guarded Reclaim on All Contested Names (`read`, `edit`, `str_replace_editor`, `undo_last_edit`)

Reclaim must never blindly delete peer tools on arbitrary errors. Deletion is executed **only on verified name collisions**:

1. **Pre-check:** Query `layer.get(name)`. If `current === def`, the tool is already our registered instance (returns a no-op disposer `() => {}`).
2. **Collision Signal:** A reclaim is initiated _only_ if:
   - `current != null` (entry is occupied by a foreign definition), OR
   - The initial `register` call throws an error matching `already registered` / `NamedEntries` collision.
3. **Non-collision Failures:** If `register` throws for non-collision reasons (e.g. invalid schema, runtime error), do NOT touch `layer.data`. Log a descriptive warning citing #123 and return `undefined`.
4. **All Contested Tools Protected:** In addition to `read`, `edit`, and `str_replace_editor`, `undo_last_edit` is also constructed via `buildUndoTool(io, sandbox)` and routed through `registerWithReclaim`.
5. **Write-Hook Exemption:** `registerWriteHook` registers pre/post execution event listeners (`tools/pre-execute`, `tools/post-execute`) on the agent context, not a named tool in `agent.ctx.tools`. It carries no name collision surface and requires no reclaim.

### Invariant 4: Reclaim Sufficiency, Post-Delete Assertion & Lazy Resolution

- In DSH `packages/core/src/registry.ts`, `NamedEntries.prototype.delete` operates on `this.data.delete(name)`.
- **Lazy Layer Resolution:** Layer lookups are resolved dynamically at the moment of registration via `getAgentScopedToolLayer(toolsSvc, agent)` to prevent stale layer references.
- **Post-delete verification:** `reclaimToolEntry` verifies `layer.data.delete(name)` and checks that `layer.get(name) === undefined`. If the layer is unresolvable or deletion fails, it logs an explicit warning citing `#123` and skips re-registration.
- **Single Retry & Self-Heal Fallback:** Reclaim performs a single retry. If an install-time reclaim loses a race, the definition is retained and passed to the self-heal watcher, which will attempt restoration on subsequent `tools/change` events.

### Invariant 5: Build-Time & Factory Fault Isolation

Both tool construction (`buildEditTool`, `buildStrReplaceEditorTool`, `buildUndoTool`) and registration are isolated per step. If a factory throws, subsequent tools and guidance continue to install.

### Invariant 6: Timing Contract Clarification

- `read` is unconditional (ADR-0032 §2.1) and is registered **synchronously** during `agent/created` without awaiting preset resolution.
- Named mutating tools (`edit`, `str_replace_editor`, `undo_last_edit`) register _after_ awaiting `resolveToolset` (since `agentPresets.acquireScope` is asynchronous in DSH `0.2.x`), and rely on **guarded entry reclaim** to win ownership over eager peer plugins.
- Write hooks register post-resolution as context listeners (`tools/pre-execute`, `tools/post-execute`) without reclaim, since they attach to events rather than registering named tools. Note that `buildUndoTool(io, sandbox)` arity pins to `src/tool-undo.ts:78`.

### Invariant 7: Wire Contract Invariant

`src/contract.ts` and the `{file, edits: [...]}` payload contract are completely untouched. All modifications reside on the install and lifecycle plane.

---

## 3. Concrete Implementation Modules

### `src/reclaim.ts`

```ts
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
  if (current === def) return () => {}; // Already registered with same ref; return no-op disposer

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
```

### `src/index.ts` Refactoring Pattern

```ts
import { UNCONDITIONAL_TOOLSET, resolveToolset, sectionsForToolset } from "./preset-toolset.js";
import { buildUndoTool } from "./tool-undo.js";
import { getAgentScopedToolLayer, registerWithReclaim } from "./reclaim.js";

function installAgentTools(rootCtx: Context, agent: Agent): void {
  agent.ctx.effect(() => {
    let disposed = false;
    const disposers: Array<() => void> = [];
    const registerDisposer = (d: (() => void) | undefined) => {
      if (!d) return;
      if (disposed) {
        try {
          d();
        } catch {
          /* ignore best-effort disposal */
        }
      } else {
        disposers.push(d);
      }
    };

    const toolsSvc = rootCtx.get("tools");
    const io = ctxFsIO(rootCtx.fs as FileSystem, rootCtx);
    const sandbox = new FsSandboxController(rootCtx);

    // Step 1: Synchronous read registration (unconditional, with reclaim)
    // Anchored definition kept in outer scope for self-heal identity verification
    const hashReadDef = buildReadTool(io);
    try {
      const disposeRead = registerWithReclaim({
        toolsSvc,
        agent,
        agentCtx: agent.ctx,
        name: "read",
        def: hashReadDef,
        logger: rootCtx.logger,
      });
      registerDisposer(disposeRead);
    } catch (err) {
      rootCtx.logger.warn(
        `dsh-better-edit: failed to install synchronous read tool: ${err} (#123)`,
      );
    }

    // Async IIFE for preset-gated mutating tools and prompt guidance
    (async () => {
      let toolset;
      try {
        toolset = await resolveToolset(rootCtx, agent.ctx);
      } catch (err) {
        rootCtx.logger.warn(`dsh-better-edit: resolveToolset failed, using default: ${err} (#123)`);
        toolset = UNCONDITIONAL_TOOLSET;
      }
      if (disposed) return;

      // Step 2: edit
      let hashEditDef: unknown;
      if (toolset.edit) {
        try {
          hashEditDef = buildEditTool(io, sandbox);
          const disposeEdit = registerWithReclaim({
            toolsSvc,
            agent,
            agentCtx: agent.ctx,
            name: "edit",
            def: hashEditDef,
            logger: rootCtx.logger,
          });
          registerDisposer(disposeEdit);
        } catch (err) {
          rootCtx.logger.warn(`dsh-better-edit: failed to build/register edit: ${err} (#123)`);
        }
      }
      if (disposed) return;

      // Step 3: str_replace_editor
      let hashStrReplaceDef: unknown;
      if (toolset.strReplaceEditor) {
        try {
          hashStrReplaceDef = buildStrReplaceEditorTool(io, sandbox);
          const disposeStr = registerWithReclaim({
            toolsSvc,
            agent,
            agentCtx: agent.ctx,
            name: "str_replace_editor",
            def: hashStrReplaceDef,
            logger: rootCtx.logger,
          });
          registerDisposer(disposeStr);
        } catch (err) {
          rootCtx.logger.warn(
            `dsh-better-edit: failed to build/register str_replace_editor: ${err} (#123)`,
          );
        }
      }
      if (disposed) return;

      // Step 4: undo_last_edit (built and registered with reclaim)
      if (toolset.undo) {
        try {
          const hashUndoDef = buildUndoTool(io, sandbox);
          const disposeUndo = registerWithReclaim({
            toolsSvc,
            agent,
            agentCtx: agent.ctx,
            name: "undo_last_edit",
            def: hashUndoDef,
            logger: rootCtx.logger,
          });
          registerDisposer(disposeUndo);
        } catch (err) {
          rootCtx.logger.warn(`dsh-better-edit: failed to register undo tool: ${err} (#123)`);
        }
      }
      if (disposed) return;

      // Step 5: write hook (pre/post listeners on agent context; no tool name collision surface)
      if (toolset.writeHook) {
        try {
          registerDisposer(registerWriteHook(rootCtx, agent.ctx, io));
        } catch (err) {
          rootCtx.logger.warn(`dsh-better-edit: failed to register write hook: ${err} (#123)`);
        }
      }
      if (disposed) return;

      // Step 6: self-heal watcher (receives the exact owned hashReadDef from Step 1)
      try {
        registerDisposer(
          createSelfHealWatcher({
            agentId: agent.id,
            rootCtx,
            agent,
            agentCtx: agent.ctx,
            toolsSvc,
            hashReadDef, // Owned reference preserved!
            hashEditDef,
            hashStrReplaceDef,
          }),
        );
      } catch (err) {
        rootCtx.logger.warn(
          `dsh-better-edit: failed to initialize self-heal watcher: ${err} (#123)`,
        );
      }
      if (disposed) return;

      // Step 7: system prompt guidance
      try {
        const sections = sectionsForToolset(await resolveAgentSections(rootCtx, agent), toolset);
        if (disposed) return;
        for (const section of sections) {
          registerDisposer(agent.ctx.systemPrompt.section(section));
        }
      } catch (err) {
        rootCtx.logger.warn(
          `dsh-better-edit: failed to register system prompt guidance: ${err} (#123)`,
        );
      }
    })().catch((err) => {
      rootCtx.logger.warn(`dsh-better-edit: unhandled async install failure: ${err} (#123)`);
    });

    return () => {
      disposed = true;
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* ignore best-effort disposal */
        }
      }
      disposers.length = 0;
    };
  });
}
```

---

## 4. Verification & Testing Strategy

1. **Unit Test Suite (`test/core/tool-install-isolation.test.ts`):**
   - **Simulated Peer Collision:** Pre-register dummy `edit` and `undo_last_edit` tools in `agent.ctx.tools`. Verify `dsh-better-edit` reclaims them, registers its own hashline tools, and completes registration of `read`, `str_replace_editor`, `undo_last_edit`, write hooks, self-heal, and guidance.
   - **Self-Heal Anchor Identity Check:** Confirm that `createSelfHealWatcher` receives the owned `hashReadDef` reference from Step 1, rather than a snapshot from `layer.get("read")`.
   - **Disposal on In-Flight Teardown:** Simulate agent disposal while `resolveToolset` is pending. Confirm that late-resolving tool registrations are immediately disposed and do not leak into the dead scope.
   - **Non-Collision Registration Failure:** Trigger a throw on an invalid tool definition; verify `reclaimToolEntry` is NOT called and existing peer tool remains untouched.
   - **Fault Isolation:** Stub `buildEditTool` to throw; verify remaining tools and guidance still install successfully.
2. **Quality Gates:**
   - `pnpm run typecheck && pnpm test && pnpm run build`.
