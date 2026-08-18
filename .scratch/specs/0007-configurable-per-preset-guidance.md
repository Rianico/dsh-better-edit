# Spec — Configurable per-preset tool guidance (issue #7)

Parent: #7 ([Enhancement] Support Configurable Prompts to Improve Plugin Flexibility)

## Problem Statement

The guidance text and ordering of the plugin's four system-prompt sections (`tool:read`, `tool:edit`, `tool:batch_edit`, `tool:undo_last_edit`) are hardcoded in `src/prompts.ts` and `src/index.ts`. Users running the plugin under different agent presets — or alongside other tool guidance — cannot adapt the text the model reads. The result is guidance that is fixed, verbose, and identical for every preset.

## Solution

Let the user override any section's guidance and `order` with plain markdown files, keyed by agent preset. The plugin resolves, per agent, the preset it is composed on (`agentPresets.composedPreset`) and reads `<section>.md` override files from the plugin's shared home (`$DSH_HOME/plugins/dsh-better-edit/<preset>/`, default `~/.dsh/plugins/dsh-better-edit/`). A `_default/` directory is auto-created from the compiled guidance on first run — it is both the copy source ("copy `_default` to `<preset>`") and a live global fallback layer. The fallback chain per section is `<preset>/<section>.md` → `_default/<section>.md` → compiled constant.

## User Stories

1. As a dsh user, I want the guidance text of each hashline tool section to be overridable, so that I can adapt it to my agent preset.
2. As a dsh user, I want the `order` of each section to be overridable, so that my sections sit where I want them in the assembled system prompt.
3. As a dsh user, I want overrides keyed by preset id, so that different presets can show different guidance.
4. As a dsh user, I want to override only the sections I care about, so that the rest keep their defaults.
5. As a dsh user, I want a global override that applies to every preset, so that I can customize once without per-preset copies.
6. As a dsh user, I want the default guidance materialized as files on first run, so that I can copy and edit them without hunting through node_modules.
7. As a dsh user, I want the override files to be plain markdown, so that I can edit prose without YAML escaping.
8. As a dsh user, I want the `order` expressed as optional front-matter, so that a pure-prose file still works.
9. As a dsh user, I want a preset that has no override files to keep the compiled defaults, so that nothing breaks when I don't customize.
10. As a dsh user, I want deployments without presets to keep working unchanged, so that enabling the plugin never requires presets.
11. As a dsh user, I want guidance files read once per agent, so that edits apply to new sessions without a watcher or hot reload.
12. As a dsh subagent, I want to inherit my parent's preset guidance automatically, so that delegation shows the same tool contract.
13. As a dsh user, I want the shipped default guidance simplified, so that the system prompt is tighter.
14. As a maintainer, I want the naming unified on "guidance" (not "guidelines"), so that the vocabulary stays consistent.
15. As a maintainer, I want the feature documented in README (EN and zh) with a CHANGELOG entry, so that users can discover it.

## Implementation Decisions

- **Per-preset keying**: at `agent/session-start` the plugin reads `rootCtx.get("agentPresets")` (optional — never a hard inject) and calls `composedPreset(agent.ctx)` to learn the live preset id. A preset-less agent (undefined id) uses the compiled defaults.
- **File location**: `$DSH_HOME/plugins/dsh-better-edit/<preset>/<section>.md` — the plugin's existing shared home (same dir as `hash-store.sqlite`). Guidance is per-user-per-preset, NOT per-workspace (the workspace `.dsh_better_edit/` dir is untouched).
- **Section file names**: the section name minus the `tool:` prefix — `read.md`, `edit.md`, `batch_edit.md`, `undo_last_edit.md`. Mechanical mapping, no translation table.
- **Fallback template dir name**: `_default` (NOT `default` — `default` is a valid preset id, and a preset id can never start with `_`, so collision is impossible by construction).
- **File shape**: optional YAML front-matter (`---\norder: N\n---`) followed by the full rendered section text. A file without front-matter is treated as pure prose. Malformed front-matter degrades to pure prose.
- **Fallback chain per section**: `<preset>/<section>.md` → `_default/<section>.md` → compiled constant in `src/prompts.ts`. Each level optional; partial override works.
- **Materialization**: on first run, if `_default/` is absent, write the four section files rendered from the compiled constants plus a short `README.md` explaining the convention. Idempotent; never rewrites existing files.
- **Read-once semantics**: guidance is resolved once per agent at session-start and never re-read while the agent runs (matches dsh's prefix-stability/KV-cache discipline — same as presets and persona). File edits affect new sessions only.
- **Compiled defaults stay the source of truth** for section text; the `_default/` files are rendered from them by construction (no drift).
- **Content**: the four sections are simplified per the writing-for-agents principles (shorter, imperative, no redundancy); the `*_GUIDELINES` constants are renamed to `*_GUIDANCE`.
- **Boundaries**: tool `_DESCRIPTION`/`_SNIPPET` strings stay hardcoded; section names are fixed; only text and `order` are overridable.
- **No cordis config plumbing**: the plugin's row `config` remains unused; no `Config` schema is added.

## Testing Decisions

- **Test seam (single)**: a pure module that takes `(presetId | undefined, homeDir, section)` and returns the resolved `{ order, text }` (and the composition of all four sections). All fallback/front-matter/materialization behavior is exercised through this seam against temp directories — no cordis harness boot needed.
- **Modules tested**: the new guidance module (resolution, parsing, materialization) plus the existing vitest suite must stay green.
- **Prior art**: existing unit tests in `test/` (vitest) with temp-dir fixtures (e.g. `test/core/edit-engine.e2e.test.ts`, `test/support/`).

## Out of Scope

- Per-workspace guidance overrides (workspace `.dsh_better_edit/`).
- Overriding tool `_DESCRIPTION`/`_SNIPPET` strings.
- Renaming sections (`tool:edit`, etc.) from config.
- Hot reload / file watchers.
- Cordis row `config` plumbing or a `Config` schema.
- Overriding guidance via preset-composition rows (`agent.cordis.yml`) — impossible anyway: the plugin registers sections on the agent's own scope layer, which always shadows preset-layer rows.

## Further Notes

- **Why not preset rows**: dsh's system-prompt registry is scope-layered (`agent → preset → global`, nearest wins). The plugin registers its sections on the agent's own layer, so a preset row declaring the same section name cannot override them — only the plugin reading config can. This is the key constraint that makes file-based, plugin-read overrides the right shape.
- An ADR recording this decision (files over cordis config; why preset rows can't work) will accompany the implementation.
- README (EN and zh) gains a "Configuring guidance per preset" section; CHANGELOG entry on release.
