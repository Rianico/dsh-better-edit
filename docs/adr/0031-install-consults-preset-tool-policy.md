# ADR-0031 — The install consults the composed preset's own tool policy

Status: Accepted (fix for #110, lane `i110`).
Downstream records: `src/preset-toolset.ts` (`HashlineToolset`, `toolsetFor`,
`sectionsForToolset`, `resolveToolset`), `src/index.ts` (`installAgentTools`), `src/self-heal.ts`
(the heal set is the installed set), `test/core/preset-tools-gate.test.ts` (the pins).
Upstream: none — `pi-better-edit` has no preset layer, so this decision is downstream-only and
moves no sync cursor.

## Context

On `agent/created` the plugin registers `read`, `edit`, `str_replace_editor` and
`undo_last_edit` on the agent's **own** scope layer, unconditionally. That is how it shadows the
preset's built-ins, but it also bypasses the preset's policy: a preset that composes `tool-fs`
with `edit: false` / `write: false` / `applyPatch: false` still ends up with working
write-capable hashline tools. `str_replace_editor` is registered even when the preset never
composed that package at all.

The registry cannot fix this for the plugin. A `ToolRestriction` filters only what a scope
**inherits** — the global layer and ancestor layers — and never what the scope's **own** layer
registers (`ToolRuntime.view`, 0.2.1-rc.2). The plugin's four tools are exactly that exempt
layer, so a preset's `allow`/`deny` cannot hide them.

The self-heal watcher hardened the defect instead of fixing it: it re-registered a fixed
`read` / `edit` / `str_replace_editor` set on every `tools/change`, so a gate applied only at
install time would be defeated on the next registry change.

## Decision

1. **`read` is unconditional.** It is the plugin's core capability and the source of every
   anchor; no preset policy removes it. A preset that disables `read` while enabling `edit`
   therefore cannot orphan `edit` — the catalog always pairs them, with `read` present.
2. **Every mutating tool is gated on the preset's own layer.** `edit` is installed only when the
   composed preset resolves `edit`; `str_replace_editor` only when the preset resolves
   `str_replace_editor` — the plugin shadows only what the preset actually composed.
3. **`undo_last_edit` follows `edit`.** It reverts only hashline edits, so installing it beside no
   `edit` would advertise a history that can never exist.
4. **The write hook follows `write`.** It guards the preset's own built-in `write` and
   auto-reads after it; a composition without `write` has nothing to guard.
5. **Guidance follows the catalog.** `tool:edit` and `tool:undo_last_edit` are registered only
   when their tool is installed, so the prompt never advertises an absent tool.
6. **The probe is an optional-service seam, never an injected dependency.**
   `ctx.get("agentPresets")` supplies `composedPreset(agentCtx)`; the preset's scope key comes
   from the feature-detected scope read — `acquireScope(id)` (0.2.x, a `{ key }` lease that must
   be released) first, `standingKeyFor(id)` (older, unleased) next. `tools.get(name, scopeKey)`
   then answers what that preset layer registers.
7. **The fallback is today's install, not a smaller set.** No `agentPresets` service, no composed
   preset (preset-free composition), no scope-read API (pre-0.2.1), or any error during the probe
   installs all four tools and warns. The gate may only remove a tool it has positively seen the
   preset decline; a broken probe must never silently disable `edit`.
8. **One predicate feeds install and self-heal.** The index handler passes the definitions it
   actually registered to `createSelfHealWatcher`; an absent definition is the watcher's
   "never heal this" signal. A `tools/change` on a read-only preset can therefore not resurrect
   `edit` or `str_replace_editor`, and the two sets cannot drift apart.
9. **Fail-open on the lease.** A failed `acquireScope` release warns and does not change the
   probe's answer — the scope read has already happened.

## Consequences

- A read-only preset now sees exactly the hashline `read`. A `read`+`write` preset sees only
  `read` plus the write hook. A `read`+`edit` preset sees `read`, `edit` and `undo_last_edit`.
  Preset-free compositions and hosts without the preset service keep all four tools.
- The gate honours **composition**, not agent-scope `ToolRestriction`. A preset that composes
  `edit` while a child scope restricts `edit` away still receives the hashline `edit` on the
  agent's own layer, for the same registry reason the defect existed: own-layer registrations are
  restriction-exempt. Making restrictions bind would need a registry-level answer, not a plugin
  one; this ADR does not claim it.
- A pre-0.2.1 host (no scope-read API) keeps the unconditional install, and with it the original
  over-install. That is the recorded compatibility floor, matching the plugin's existing
  `getSectionOrder` fallback pattern.
- Cost per install: one optional `ctx.get`, one scope read, three `tools.get` calls, and one
  lease release. No new injected service and no new hard dependency.

## Alternatives considered

- **Let the registry enforce the preset policy.** Impossible for this plugin: scope restrictions
  filter inherited tools only (see Context). Rejected as unavailable, not as undesired.
- **Probe with the agent's own scope key (the agent object).** A viable registry call, but it
  answers with the agent's own layer (empty at install time) and applies agent restrictions to
  inherited tools in the same view — a narrower question than the preset's composition. The
  decision above adopts the preset scope the ticket specifies and records the restriction gap
  under Consequences rather than half-implementing it.
- **Gate only at install time.** Rejected: the watcher re-registers a fixed set on every
  `tools/change`, so the gate would be defeated (Decision 8).
- **Gate `read` too.** Rejected: the plugin's anchors come from `read`; hiding it leaves the
  deployment with no hashline capability at all, and the brief makes `read` unconditional.
