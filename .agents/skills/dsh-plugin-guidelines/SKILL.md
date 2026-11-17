---
name: dsh-plugin-guidelines
description: Authoring DeepSeek Harness (dsh) plugins. Use when creating or editing a dsh bundle/plugin, configuring plugins with Schemastery, registering tools with defineTool, replacing or shadowing built-in tools (edit, read, write, bash), isolating and reclaiming contested tools, wiring system-prompt sections, handling ctx.fs mutations, or debugging a dsh tool that doesn't shadow another, fails with FS_NOT_OBSERVED/FS_STALE_VERSION, or whose edits don't stick.
---

# dsh plugin guidelines

Reference for writing a DeepSeek Harness (`dsh`) plugin — the parts of the
model that the official tutorials assume you know. Two mental models carry the
whole surface: the **two planes** (where your code runs) and **own layer wins**
(how tools and prompt sections shadow each other). Every rule below is
checkable against the running deployment: if a tool fails to appear, fails to
shadow, or breaks the next built-in tool, one of these rules was missed.

**Baseline:** `@deepseek-ai/dsh-*@0.2.x` (`0.2.1-rc.2`–`0.2.2-rc.1`) + `@deepseek-ai/cordis@4.0.5`.
Official documentation and guides:
- [Your first plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/index.md)
- [Build a tool](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool.md)
- [Plugin configuration](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config.md)
- [Package and install](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish.md)
- [Plugin lifecycle & framework](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/index.md)
- [Services and dependencies](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/service.md)
- [Event system](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/events.md)
- [Agent lifecycle](https://deepseek-harness.github.io/deepseek-harness/en/reference/agent-lifecycle.md)
- [Tool execution pipeline](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-execution-pipeline.md)

This skill owns the underlying runtime invariants, scope mechanics, failure modes,
and registration isolation patterns they do not confess.

---

## 1. The two planes

A plugin row runs on one of two planes, and the plane decides what it can do:

- **Host plane** — the deployment composition built from bundle patches. Owns
  the core services and registries: `tools`, `fs`, `systemPrompt`, `sessions`,
  `agents`, `llm`. A bundle's `cordis.patch.yml` inserts host-plane rows only.
- **Agent plane** — per-session compositions (the **presets**), mounted once
  under a standing scope; every session that names a preset joins it by scope
  parentage. The model-facing tools (`edit`, `read`, `write`, `bash`, …) live
  **here**, not on the host. A preset is a `@deepseek-ai/dsh-agent-preset` row (an
  id plus child plugin rows) served by the `agentPresets` service; the shipped
  ids are `standard`, `ptc`, `minimal`, `cordis`.

**Consequence:** A bundle patch **cannot add rows directly to a preset**, and a host-plane
registration of a tool name that a preset already registers does not replace
it — the preset's nearer layer wins. To change what the model sees, either
patch the preset's composition (a user-authored `@deepseek-ai/dsh-agent-preset` row) or
shadow per-agent on `agent.ctx` (see [Shadowing a built-in](#5-shadowing-a-built-in-the-pattern)).

---

## 2. Own layer wins

The tool registry and the system-prompt registry are both **scope-layered**:
each scope owns a layer, and a scope's view resolves `agent → preset → global`
with the **nearest** layer shadowing the farther ones — and a scope's **own**
registrations shadow every ancestor, regardless of order. A child scope never
sees into a sibling.

- The registry's global layer is deliberately **empty of model tools** (they
  all live on the agent plane), so "register globally to replace X" cannot
  work — the preset's X shadows it.
- Registering a name twice **in the same layer throws**: `tool "X" is already
  registered in this scope (for a per-agent variant, register through that
  agent's agent.ctx instead)`. In DSH's `@deepseek-ai/dsh-scope` (`NamedEntries`),
  the scope layer rejects collisions unconditionally.
- **`run_code` is reserved** and can neither be registered nor shadowed.
- Prompt sections shadow exactly the same way: `ctx.systemPrompt.section({ name, order, text })`
  with a duplicate name in the same layer throws, and a same-name section on a
  nearer scope replaces the farther one (this is how a preset shadows the
  deployment persona).

---

## 3. Plugin forms & configuration

### Three plugin forms

A plugin can be authored in function, object, or service class form:

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

// 1. Function form (standard for most plugins)
export const name = 'my-tool-plugin'
export const inject = ['tools']
export function apply(ctx: Context, config: Config) {
  // ctx.tools is ready here
}

// 2. Object form
export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context, config: Config) { /* ... */ },
}

// 3. Class form (when providing a new service to other plugins)
declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
}

export default class MetricsService extends Service {
  static inject = ['llm']
  constructor(ctx: Context) {
    super(ctx, 'metrics') // registers ctx.metrics
  }
  record(event: string, value: number) { /* ... */ }
}
```

### Configuration with Schemastery

Accept configuration from `cordis.yml` via Schemastery (`@deepseek-ai/schemastery`). Export both a TypeScript `interface Config` and a same-named `Config` schema. Do **not** export a plain object; Cordis requires a Standard Schema implementation:

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export interface Config {
  greeting: string
  timeoutMs: number
  mode?: 'fast' | 'accurate'
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  timeoutMs: Schema.number().default(30000),
  mode: Schema.union(['fast', 'accurate']).default('fast'),
})

export function apply(ctx: Context, config: Config) {
  // config is validated at load time; invalid values fail the load loudly
}
```

- **No hardcoded tunables:** Anything two deployments might set differently must be a configuration field.
- **HMR aware:** Configuration edits reload the plugin via `@deepseek-ai/dsh-hmr`; old effects and event listeners are automatically disposed before the new configuration applies.

---

## 4. The event system & modes

Events communicate across plugins. Cordis supports four execution modes on `ctx`:

1. **`ctx.emit(event, ...args)` — broadcast:** Every listener runs synchronously; return values are ignored.
2. **`ctx.bail(event, ...args)` — short-circuit:** Listeners run in order; the first value other than `null`, `false`, or `undefined` stops execution and becomes the return value.
3. **`ctx.serial(event, ...args)` — ordered async execution:** Listeners run sequentially in registration order, awaiting promises. The first non-falsy result stops execution.
4. **`ctx.waterfall(event, ...args, fallback)` — pipeline transformation:** Each listener receives a `next()` callback wrapping downstream handlers. **Calling `next()` is mandatory** to delegate downstream; omitting it intentionally short-circuits the pipeline:
   ```ts
   ctx.on('my-plugin/transform', async (input, next) => {
     const downstream = await next()
     return downstream.trim()
   })
   ```

### Cordis events vs Session events

- **Cordis events** (`namespace/action`, e.g. `agent/pre-step`, `agent/request-error`, `tools/result`) live on `ctx`.
- **Durable session records** (`turn/*`, `step/*`, `tool/call`, `tool/result`, `compaction/*`) are not Cordis events; observe them by listening to `session/event` and inspecting `event.type`.

---

## 5. Shadowing a built-in (the pattern)

To replace `edit`/`read`/`write` for a session, register on the **agent's own scope** via its scoped context (`agent.ctx`).

### The four trapdoors & best practices (derived from Issue #123)

1. **The Async Effect Trap (Cordis Disposer Race):**
   Cordis does **not** unwrap `Promise<disposer>` returned from an `async effect` callback into synchronous disposal hooks (`effect.then(safeCollect)`). An `agent.ctx.effect(async () => ...)` risks leaking registrations or listeners if the agent is terminated during in-flight async resolution.
   *Fix:* Make the outer `agent.ctx.effect` **strictly synchronous**, returning an immediate cleanup closure that drains a shared `disposers` array and sets a `disposed` flag.
2. **Synchronous `read` Anchor:**
   `agent.ctx.effect(async () => { await resolveToolset(); ... })` yields to the microtask loop, allowing synchronous peer listeners (e.g. `dsh-sol-pi`) in `agent/created` to claim tool names first.
   *Fix:* Unconditional tools like `read` (per ADR-0032) must be registered **synchronously** in the `agent/created` turn before yielding.
3. **Per-Step Fault Isolation:**
   `NamedEntries.insert` throws when a name collision occurs in the same scope layer. If registrations run in an unhandled linear chain, a collision on `edit` will abort all downstream tools (`str_replace_editor`, `undo_last_edit`, `writeHook`, self-heal watcher, and prompt guidance).
   *Fix:* Wrap every tool registration and guidance mount in an isolated `try/catch` block.
4. **Guarded Reclaim (`reclaimToolEntry`):**
   When a peer plugin pre-claims an agent-layer tool, re-registration throws unless the occupied entry is cleared.
   *Fix:* Use a guarded reclaim primitive that verifies collision (`layer.get(name) !== undefined` or matching collision error message), deletes the entry from `layer.data`, and re-registers once. Non-collision errors must never delete peer tools blindly.
5. **Self-Heal Anchor Hygiene:**
   Self-heal watchers must anchor to owned definition references stored in closure variables (e.g. `hashReadDef`), never snapshotting `layer.get("read")` during late resolution, which would ratify an intruder.

### The Canonical Installation Pattern

```ts
import type { Context, Agent } from '@deepseek-ai/dsh-core'
import { defineTool } from '@deepseek-ai/dsh-tools'

const installed = new WeakSet<Agent>()

export function installAgentTools(rootCtx: Context, agent: Agent): void {
  if (installed.has(agent)) return
  installed.add(agent)

  agent.ctx.effect(() => {
    let disposed = false
    const disposers: Array<() => void> = []

    const registerDisposer = (dispose: (() => void) | undefined): void => {
      if (!dispose) return
      if (disposed) {
        try { dispose() } catch {}
        return
      }
      disposers.push(dispose)
    }

    const toolsSvc = rootCtx.get('tools')

    // Step 1: Synchronous unconditional claim in agent/created turn
    const hashReadDef = buildReadTool()
    try {
      registerDisposer(registerWithReclaim({
        toolsSvc, agent, agentCtx: agent.ctx, name: 'read', def: hashReadDef,
      }))
    } catch (err) {
      rootCtx.logger.warn(`failed to install synchronous read: ${err}`)
    }

    // Detached async IIFE for policy resolution, mutating tools, and guidance
    void (async () => {
      const toolset = await resolveToolset(rootCtx, agent.ctx)
      if (disposed) return // Gate after async lease

      // Step 2: Isolated mutating tools
      if (toolset.edit) {
        try {
          registerDisposer(registerWithReclaim({
            toolsSvc, agent, agentCtx: agent.ctx, name: 'edit', def: buildEditTool(),
          }))
        } catch (err) {
          rootCtx.logger.warn(`failed to install edit: ${err}`)
        }
      }

      // Step 3: Self-heal watcher anchored to owned definition closure
      try {
        registerDisposer(createSelfHealWatcher({
          agent, hashReadDef, // anchored on owned ref, not layer snapshot
        }))
      } catch (err) {
        rootCtx.logger.warn(`failed to mount self-heal: ${err}`)
      }

      // Step 4: System prompt guidance
      try {
        registerDisposer(agent.ctx.systemPrompt.section({
          name: 'tool:edit',
          order: agent.ctx.systemPrompt.getSectionOrder('TOOL_EDIT'),
          text: ({ scope }) => agent.ctx.tools.get('edit', scope) ? editGuidance : '',
        }))
      } catch (err) {
        rootCtx.logger.warn(`failed to mount guidance: ${err}`)
      }
    })()

    // Immediate synchronous teardown closure
    return () => {
      disposed = true
      while (disposers.length > 0) {
        try { disposers.pop()?.() } catch {}
      }
    }
  })
}
```

### Probing and Context Resolution

- **Probe with the agent's scope, not just the agent:** `systemPrompt.assemble({ agent })` resolves the **global** view and ignores agent-layer shadows. The real assembly carries the scope key: `systemPrompt.assemble(assembleContextFor(agent))` (`@deepseek-ai/dsh-agent`), returning `{ agent, scope: agent }`. Likewise, `tools.get(name, agent)` and `tools.schemas(agent)` take that key.
- **Render guidance conditionally:** The built-ins pass a function: `text: ({ scope }) => ctx.tools.get('read', scope) ? ... : ''`. A static string renders even when a preset or restriction policy hides the tool.
- **Declare `inject` for every service touched:** Cordis refuses property access to undeclared services (`cannot get property "fs" without inject`). List `tools`, `systemPrompt`, and `fs` in the plugin's `inject` export.
- **Resolve host-plane services on `rootCtx`, not `agent.ctx`:** The agent's fiber chain does not inherit your plugin's `inject` declarations. `agent.ctx.fs` throws even when declared. Use `rootCtx.fs` and pass per-call session state (`exec.agent.session.header.cwd` or `workingDirectory.get(session)`) through tool arguments.

---

## 6. System prompt section order

Assembly merges every layer's sections and concatenates them in ascending `order`:

- **The bands are convention, not enforcement:** `-1000` harness identity, `0` persona prefix, `500` plan policy, `600` team policy, `800` PTC-only, `900` file reference, `1000–3100` tool guidance, `5000` SDK, `9900` structured output.
- **Do not hard-code band numbers:** Call `ctx.systemPrompt.getSectionOrder('TOOL_READ')` to get the installed build's slot (`TOOL_BASH` 1000, `TOOL_READ` 1100, `TOOL_WRITE` 1200, `TOOL_EDIT` 1300, `TOOL_GLOB` 1400, `TOOL_GREP` 1500, … in `0.2.x`). Always provide a static fallback for registries predating the API.
- **Tie-breaks:** Equal `order` values tie-break deterministically by section name.

---

## 7. The fs event gate & sandbox policy

`ctx.fs` is the only sanctioned mutation seam (sandboxed and remote backends implement it; raw `node:fs` bypasses them). Calling `fs.writeText` alone is **not enough** — the `fs-observation-policy` derives write/edit guards from two events:

- **`fs/write-intent`** — single-slot waterfall; answers `createIfAbsent` / `replaceIfVersion` at the observed version.
- **`fs/observed`** — fire-and-forget emit recording the version just read or written, keyed by session.

A mutating tool MUST execute: **resolve → waterfall → mutate → emit**:

```ts
const target = await ctx.fs.resolve(path, { cwd, signal })
const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
const outcome = await ctx.fs.writeText(target, content, intent, signal, sandboxPolicy)
ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
```

### The sandbox policy

In confined deployments (`@deepseek-ai/dsh-fs-sandbox`, reported by `ctx.fs.sandboxMode`), mutations are fenced by policy:

1. **Resolve per-call policy with the session:** `sandboxPolicy.resolve({ session: exec.agent.session })`. Omitting it falls back to the deployment default root, denying edits inside session workspaces under `workspace-write`.
2. **Pass policy as 5th argument:** Pass to `ctx.fs.writeText(..., sandboxPolicy)`.
3. **Advertise escalation fields in tool schema:** When `ctx.fs.sandboxMode` is defined, expose `sandbox_permissions` (enum of `ESCALATION_TARGETS`) + `justification` in parameters so denials can escalate through `ctx.approval`.
4. **Map `FS_SANDBOX_DENIED`:** Map onto `[sandbox: file access denied under <mode> mode]` with same-turn escalation hints.

---

## 8. Tools DSL & content blocks

Register tools with `ctx.tools.register(defineTool({ ... }))`.

- **Parameters Schema:** Uses unified value-schema DSL (string, number, integer, boolean, array, object, oneOf). Array nodes support `items` only (**no `minItems`/`maxItems`**; validate cardinality in `execute`). In objects, each property specifies `required: true|false` and top-level `additionalProperties: false` is required.
- **`execute(args, exec)`:** `exec.signal` is cancellation; live directory is read via `ctx.workingDirectory.get(session)` (with fallback to `exec.agent.session.header.cwd`).
- **Canonical Output & Render:** `output.schema` declares the canonical JSON structure returned by `execute`. `output.render(_args, value)` maps it to model-facing `ContentBlock[]`:
  ```ts
  output: {
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', required: true },
        warning: { type: 'string' },
      },
      additionalProperties: false,
    },
    render: (_args, value) => [
      { type: 'text', text: value.text },
      ...(value.warning ? [{ type: 'text', text: value.warning }] : []),
    ],
  }
  ```
- **File Content vs Warnings:** **Never concatenate warnings/footers into normalized file text.** Concatenating a warning into hash-anchored lines turns the warning into editable file content and breaks line-identity tracking. Return warnings out-of-band and split them in `render`.

---

## 9. Bundles, packaging & installation

- **Bundle:** An npm package declaring `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`. The patch is a YAML array of plugin rows (`- insert: [{ id, name }]`).
- **Compatibility range:** Declare supported DSH versions in `package.json` under `"engines": { "dsh": ">=0.2.0 <0.3.0" }`.
- **Profile:** `$DSH_HOME/profiles/<name>/package.json` declares `"dsh": { "profile": { "bundles": [...] } }`. Managed via `dsh plugin --profile <name> add <pkg>`.
- **Loading Order:**
  1. Bundle patches in `bundles` list order (`@deepseek-ai/dsh-base` first).
  2. Profile's own `cordis.patch.yml`.
  3. Machine-level `$DSH_HOME/cordis.patch.yml`.
  4. `--patch <path>` command-line overlays.
- **Git-hosted packages:** Git installs fetch source without running `build`. Ship a `prepare` script that compiles `src/` → `lib/` self-contained. Note that pnpm ≥10 requires user approval via `allowBuilds: { <pkg>: true }` in `pnpm-workspace.yaml`.

### Local verification gotcha

pnpm's content store keys by `package@version`. Running `dsh plugin add <same-version.tgz>` reports "added 0" and serves **stale** cached bytes if only file contents changed. When testing locally:
- Either bump the version between iterations (`0.2.0-rc.0` → `0.2.0-rc.1`), or
- Force re-extraction: `rm -rf node_modules/<pkg> && pnpm install --force`.
- Note: `--dump-config` only displays host-plane rows; it does not boot agents or run `agent/created` hooks. Always test in a live throwaway profile.
