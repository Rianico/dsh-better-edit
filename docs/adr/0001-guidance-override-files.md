# ADR-0001 — Per-preset guidance via override files in the plugin home

The four `tool:*` guidance sections are configured with plain-markdown override files in the plugin's shared home, keyed by agent preset id — not through the plugin's Cordis row `config`, and not through preset-composition rows. Override files win by content, not by scope layering: the plugin reads them itself at `agent/session-start`.

## Status

Accepted (issue #7, spec #8). Amended (issue #17): reset-on-empty/delete semantics and malformed-fence fast fail.

## Considered Options

1. **Cordis row `config`** (patch layers). Native and inspectable via `--dump-config`, but long guidance prose is miserable in YAML (escaping, indentation), a patch replaces the whole `config` with no deep merge, and there is no per-preset granularity without extra plumbing.
2. **Preset-composition shadowing** (rows in `agent.cordis.yml`). Rejected as impossible: the plugin registers its prompt sections on the agent's OWN scope layer, and dsh's scope-layered system-prompt registry resolves `agent → preset → global` with the nearest layer winning — a preset row declaring a same-named section sits on a farther layer and can never override the plugin's.
3. **Override files in the plugin home** (chosen). Prose-friendly, per-preset by construction (the directory name IS the preset id), a `_default/` copy source plus global fallback, and zero Cordis-config plumbing. The cost: the convention is plugin-owned — dsh has no generic "default + override file" facility for plugin prompts.

## Consequences

- Overrides are global to the user per preset id, not per workspace; tool descriptions/snippets stay hardcoded; section names are fixed.
- Files are read once per agent at session-start, matching dsh's prefix-stable KV-cache discipline; edits affect new sessions only.
- The fallback directory is `_default`, an id no preset can take (`[a-z0-9][a-z0-9-]*` cannot start with `_`), so it can never collide with a real preset.

## Amendment — Reset & fast-fail on malformed fences (issue #17)

Two exceptions to "override files win by content":

- **Blank without a fence = absent (reset).** A file with no front-matter fence and a whitespace-only body is treated as absent: the compiled default renders at session-start, and the file is re-seeded at next boot — for any preset directory, shipped or custom.
- **Broken fence = rejected (fast fail).** A file that opens with a `---` fence that does not parse (missing closing `---`, non-integer `order`, unknown key) is rejected outright: its text is never injected into the context, the compiled default renders, a warning names the file and the parse reason, and the file is left untouched on disk for repair. A well-formed fence — even a keyless `---\n---\n` or an empty body — is a deliberate-intent signal: explicit content, never reset, never re-seeded.

Reset semantics:

- Emptying or deleting an override file — or deleting its whole `<preset>/` directory — restores the compiled default at render time; the physical re-seed happens only at boot, never mid-session.
- Granularity is per file, per preset directory (a deleted directory re-seeds all four section files), or per preset.
- Shipped presets are re-seeded at boot; a deleted custom-preset override stays absent — absence is no override, and custom files are never fabricated.
- Reset restores the **current** bundle defaults; a plugin upgrade yields new defaults.
- Read-once is preserved: resolution stays pure and read-only — it renders defaults, it never writes — and the physical re-seed happens only at boot.

**Reversal of the prose-fallback rationale.** The original spec (#8) recorded that a malformed fence degrades the whole file to prose so the mistake stays visible in the rendered section. That rationale is reversed: a malformed fence now fast-fails — the file is ignored with a warning naming file and reason, never rendered as prose, and left untouched on disk for repair. The mistake stays visible in the boot-time warning instead of the rendered section.

## Amendment — dsh 0.2.1: tool-band order, shipped roster, and the event name (issue #82)

The decision stands; three of its historical details moved with the harness:

- **Three sections, not four.** `tool:read`, `tool:edit`, `tool:undo_last_edit` — the fourth (`tool:batch_edit`) was retired with the merged payload contract (ADR-0003). Files are read once per agent at `agent/created` (the old `agent/session-start` event no longer exists).
- **Default order follows the harness band.** A section without a front-matter `order` now takes the harness's own slot for that tool — `systemPrompt.getSectionOrder('TOOL_READ'|'TOOL_EDIT')` (1100/1300 in 0.2.1) — with `1100`/`1300`/`1310` as the static fallback for a registry that predates the API. The old `130`/`131`/`133` literals belonged to the `0.1.0-rc.6` band (`100–199`) and sorted the guidance ahead of the entire 1000-band tool guidance after dsh moved the band (by `0.1.5-rc.2`). Explicit front-matter still wins, and a seeded file keeps the order it was written with until it is reset.
- **Shipped presets are `standard`, `ptc`, `minimal`, `cordis`** — declared as `@deepseek-ai/dsh-agent-preset` rows, not `agent.cordis.yml`. `code` is gone (its role is `ptc`), so the seed roster and README list follow the ids the harness actually ships.
