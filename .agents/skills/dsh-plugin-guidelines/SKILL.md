---
name: dsh-plugin-guidelines
description: Authoring DeepSeek Harness (dsh) plugins. Use when creating or editing a dsh bundle/plugin, registering tools with defineTool, replacing or shadowing built-in tools (edit, read, write, bash), wiring system-prompt sections, handling ctx.fs mutations, or debugging a dsh tool that doesn't shadow another, fails with FS_NOT_OBSERVED/FS_STALE_VERSION, or whose edits don't stick.
---

# dsh plugin guidelines

Reference for writing a DeepSeek Harness (`dsh`) plugin — the parts of the
model that the docs' tutorials assume you know. Two mental models carry the
whole surface: the **two planes** (where your code runs) and **own layer wins**
(how tools and prompt sections shadow each other). Every rule below is
checkable against the running deployment: if a tool fails to appear, fails to
shadow, or breaks the next built-in tool, one of these rules was missed.

**Pinned to dsh `0.1.0-rc.6`.** The harness is in developer preview and its
docs promise compatibility-breaking changes. Every rule cites the mechanism
it derives from — the registry's scope layering, the `fs/*` event gate, the
bundle patch semantics. When a rule stops matching your installed dsh, the
mechanism is where it broke: read the package that owns it (`dsh-tools`,
`dsh-fs`, `dsh-agent-presets`) rather than the rule.

The tutorials own the copy-paste shapes: `docs/cookbook/adding-a-tool.md` for a
tool, `docs/cookbook/adding-a-package.md` for a bundle,
`docs/user/develop/basic/publish.md` for installation. This skill owns what
they don't confess.

## The two planes

A plugin row runs on one of two planes, and the plane decides what it can do:

- **Host plane** — the deployment composition built from bundle patches. Owns
  the registries themselves: `tools`, `fs`, `systemPrompt`, `sessions`,
  `agents`. A bundle's `cordis.patch.yml` inserts host-plane rows only.
- **Agent plane** — per-session compositions (the **presets**), mounted once
  under a standing scope; every session that names a preset joins it by scope
  parentage. The model-facing tools (`edit`, `read`, `write`, `bash`, …) live
  HERE, not on the host.

Consequence: a bundle patch **cannot add rows to a preset**, and a host-plane
registration of a tool name that a preset already registers does not replace
it — the preset's nearer layer wins. To change what the model sees, either
patch the preset's composition (user-authored preset, `dsh-agent-presets`) or
shadow per-agent (below).

## Own layer wins

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
  agent's agent.ctx instead)`. The error message is the rule.
- **`run_code` is reserved** and can neither be registered nor shadowed.
- Prompt sections shadow exactly the same way: `ctx.systemPrompt.section({ name, order, text })`
  with a duplicate name in the same layer throws, and a same-name section on a
  nearer scope replaces the farther one (this is how a preset shadows the
  deployment persona).

### Shadowing a built-in (the pattern)

To replace `edit`/`read`/`write` for a session, register on the **agent's own
scope** via its scoped context, once per agent, inside an effect so it unwinds
on disposal:

```ts
const installed = new WeakSet<Agent>()
ctx.on('agent/session-start', ({ agent }) => {
  if (installed.has(agent)) return
  installed.add(agent)
  agent.ctx.effect(() => {
    const disposers: Array<() => void> = []
    disposers.push(agent.ctx.tools.register(defineTool({ ... })))   // own layer → shadows preset's
    disposers.push(agent.ctx.systemPrompt.section({ name: 'tool:edit', order: 102, text }))
    return () => { for (const dispose of disposers) dispose() }
  })
})
```

`agent/session-start` is the first startup-driving extension point, so the
shadow is installed before the first request. A subagent is an agent too and
fires its own `session-start`; the child's own layer shadows whatever it
inherited. `agent.ctx` is agent-local, auto-unwound, and rejects registration
after disposal — do not hoist the registration to the plain context.

**Declare `inject` for every service the install touches.** Cordis refuses
property access to an undeclared service — `cannot get property "fs" without
inject` — and the failure is silent from the model's side: the install throws
at session-start, your tools never register, and the session quietly runs the
built-ins. List `tools`, `systemPrompt`, and `fs` (and anything else the
per-agent work uses) in the plugin's `inject` export.

**Resolve host-plane services on the plugin's own context, not `agent.ctx`.**
The agent's fiber chain does not carry your `inject` list, so `agent.ctx.fs`
throws even after you declare it. Services like `fs` live on the host plane —
use `rootCtx.fs` (covered by your inject) and let per-call session state
(`exec.agent.session.header.cwd`) flow through the tool arguments instead.
`agent.ctx.tools` / `agent.ctx.systemPrompt` DO resolve (the agent chain
declares them) — only host services that your plugin, not the agent layer,
declares must be read off `rootCtx`.

## The fs event gate

`ctx.fs` is the only sanctioned mutation seam (sandboxed and remote backends
implement it; raw `node:fs` bypasses them). But calling `fs.writeText` alone is
**not enough** — the `fs-observation-policy` (mounted in the default
composition) derives every write/edit guard from two events, and a tool that
skips them leaves the policy's observed state stale:

- **`fs/write-intent`** — single-slot waterfall; the policy answers
  `createIfAbsent` / `replaceIfVersion` at the observed version. The bare
  default `() => undefined` means unconditional when no policy listens.
- **`fs/observed`** — fire-and-forget emit recording the version a tool just
  read or wrote, keyed by session.

The failure mode is silent until the next built-in call: a plugin tool that
writes without the gate makes the policy believe the file was never observed,
so the very next built-in `write` fails `FS_NOT_OBSERVED` (it tries
`createIfAbsent` on a file that exists) or `FS_STALE_VERSION`. Mirror the
built-in tools exactly — resolve → waterfall → mutate → emit:

```ts
const target = await ctx.fs.resolve(path, { cwd, signal })
const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
const outcome = await ctx.fs.writeText(target, content, intent, signal, sandboxPolicy)
ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
```

A read must also emit: resolve → read → stat → `fs/observed` present at
`info.version`. Emit failures must never fail the tool that preceded them.
Mutation errors carry stable codes (`FS_NOT_FOUND`, `FS_PERMISSION_DENIED`,
`FS_NOT_TEXT`, `FS_STALE_VERSION`, `FS_NOT_OBSERVED`, `FS_SANDBOX_DENIED`, …) —
map them onto your own model-facing vocabulary rather than leaking raw
`FsError`s.

## The sandbox policy

A confined deployment (`@deepseek-ai/dsh-fs-sandbox`, reported by
`ctx.fs.sandboxMode`) fences every mutation against a per-call policy: a
**mode** (`read-only` / `workspace-write` / `danger-full-access`) and a
**workspace root**. Omitting the policy is not "unconfined" — the backend
falls back to `ctx.sandboxPolicy.resolve()` with the **deployment default
root**, so a write inside the session workspace is denied under
`workspace-write` even though the built-in `write` (which stamps the per-call
policy) succeeds. A mutating tool MUST:

1. **Resolve the per-call policy with the session** before mutating —
   `sandboxPolicy.resolve({ session: exec.agent.session })` — so the session
   cwd is the workspace root. This is what lets `workspace-write` edits land
   inside the session workspace. (Reuse the built-in's
   `FsSandboxController` shape — `@deepseek-ai/dsh-tool-fs` — or mirror it
   with `@deepseek-ai/dsh-sandbox`.)
2. **Pass the policy to the mutation** as the 5th arg of
   `ctx.fs.writeText` / `editText`; never omit it.
3. **Advertise the escalation fields** — `sandbox_permissions` (enum of
   `ESCALATION_TARGETS`) + `justification` — in the tool schema when
   `ctx.fs.sandboxMode` is defined, so a denied operation can be retried
   once at a wider mode through `ctx.approval` (strict-wider only; `read-only`
   is the floor, `danger-full-access` the ceiling). A tool that silently
   drops them turns a retryable denial into a hard `E_BAD_SHAPE` rejection.
   Honor the fields in your own arg validation (allow them through, pass them
   to the resolver).
4. **Map `FS_SANDBOX_DENIED`** onto the shared `[sandbox: file access denied
   under <mode> mode]` marker plus the same-turn escalation hint, so the model
   sees the same vocabulary bash and the built-in fs tools use.
## Tools

Register with `ctx.tools.register(defineTool({ ... }))`, which returns the
exact disposer.

- **Schema DSL, not TypeBox.** `parameters` uses the unified value-schema DSL
  (string/number/integer/boolean/array/object/oneOf). Array nodes support
  `items` only — **no `minItems`/`maxItems`**; validate cardinality inside
  `execute`. The implicit parameter root stays open, so enforce unknown fields
  yourself (an open root is how an alias like `file_path`→`path` survives
  validation).
- **`execute(args, exec)`** — `exec.signal` is the required cancellation;
  `exec.agent?.session.header.cwd` is the session workspace (never
  `process.cwd()`); `exec.agent?.session.id` keys per-session state. Non-agent
  callers (tests, previews) have neither — fall back gracefully.
- **Return one canonical JSON value** declared by `output.schema`; `output.render`
  converts it to the model-facing content blocks. `presentCall`/`presentResult`
  are pure functions of args (+ result) for UI cards — no I/O, no session
  reads, since they also run on replay.
- **Model-facing errors** — throw `Error` with a structured `[E_...]` code
  prefix; the loop renders `Error: <message>` and the code is the contract.

The policy extension points, in pipeline order: `tools/pre-execute`
(allow/deny/ask waterfall), `ctx.tools.guard()` (monotonic final denial),
`tools/execute` (wrap dispatch: deadlines, retries, metrics), `tools/post-execute`
(replace content or value, attach context), `tools/result` (observe the frozen
outcome only). Scope-filtered events on `agent.ctx` receive only that agent's
calls.

## Bundles and installation

- A **bundle** is an npm package whose manifest declares
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the patch is a
  YAML array of plugin rows. `- insert: [{ id, name }]` appends rows.
- A **profile** is `$DSH_HOME/profiles/<name>` — an ordered bundle list plus
  the user's own `cordis.patch.yml`. Layer order: bundle layers (in list
  order) → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays.
  A patch replaces a row's entire `config` by id (no deep merge) and can
  `disabled: true` a row an earlier layer inserted.
- Install with `dsh plugin --profile <name> add <pkg>` (a pnpm forwarder that
  reconciles the bundle list against installed state). A package without the
  `dsh.bundle` declaration installs as a plain dependency and activates
  nothing.
- Ship built `lib/` in `files` (plus `cordis.patch.yml`). Git-hosted installs
  run nothing at build time, so a TypeScript bundle needs a `prepare` script
  that transpiles self-contained — and the user must allow that build.
- Verify a layer without booting: `dsh --profile <name> --dump-config` shows
  each bundle's contribution under `# == <bundle>`.

## Session-scoped state

The store for per-session state belongs under the dsh home
(`resolveDshHome()` from `@deepseek-ai/dsh-home-paths`) keyed by
`exec.agent?.session.id` — never a global map, which leaks state across
sessions and dies on HMR. Registrations inside `agent.ctx.effect` unwind
automatically; registrations on the plain context live for the process.
