## Parent

# 7 ([Enhancement] Support Configurable Prompts to Improve Plugin Flexibility) · Spec: #8

## What to build

Wire the resolver into the plugin install: at `agent/session-start`, read `rootCtx.get("agentPresets")` (optional — never a hard inject), call `composedPreset(agent.ctx)` for the live preset id, resolve the four sections via the guidance module, and register them with their resolved `order`/`text`. Fast path preserved: no `agentPresets` service or undefined preset id → compiled defaults, byte-identical behavior to today for non-customizing users.

## Acceptance criteria

- [ ] The installer resolves guidance per agent from its preset id and registers sections with overridden text/order when override files exist.
- [ ] `agentPresets` is read optionally (via `ctx.get`) — a deployment without `dsh-agent-presets` still installs tools and uses compiled defaults (no hard-inject regression).
- [ ] Undefined preset id (roster-less agent, tests, previews) → compiled defaults.
- [ ] A pure composition seam (e.g. `composeSections(presetId, homeDir)` → the four `{ name, order, text }` configs) is unit-tested against temp dirs; no cordis harness boot required.
- [ ] The four section names and default orders are unchanged; existing behavior tests stay green.

## Blocked by

#9 — guidance resolution core
