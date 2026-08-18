# ADR-0001 — Per-preset guidance via override files in the plugin home

The four `tool:*` guidance sections are configured with plain-markdown override files in the plugin's shared home, keyed by agent preset id — not through the plugin's Cordis row `config`, and not through preset-composition rows. Override files win by content, not by scope layering: the plugin reads them itself at `agent/session-start`.

## Status

Accepted (issue #7, spec #8).

## Considered Options

1. **Cordis row `config`** (patch layers). Native and inspectable via `--dump-config`, but long guidance prose is miserable in YAML (escaping, indentation), a patch replaces the whole `config` with no deep merge, and there is no per-preset granularity without extra plumbing.
2. **Preset-composition shadowing** (rows in `agent.cordis.yml`). Rejected as impossible: the plugin registers its prompt sections on the agent's OWN scope layer, and dsh's scope-layered system-prompt registry resolves `agent → preset → global` with the nearest layer winning — a preset row declaring a same-named section sits on a farther layer and can never override the plugin's.
3. **Override files in the plugin home** (chosen). Prose-friendly, per-preset by construction (the directory name IS the preset id), a `_default/` copy source plus global fallback, and zero Cordis-config plumbing. The cost: the convention is plugin-owned — dsh has no generic "default + override file" facility for plugin prompts.

## Consequences

- Overrides are global to the user per preset id, not per workspace; tool descriptions/snippets stay hardcoded; section names are fixed.
- Files are read once per agent at session-start, matching dsh's prefix-stable KV-cache discipline; edits affect new sessions only.
- The fallback directory is `_default`, an id no preset can take (`[a-z0-9][a-z0-9-]*` cannot start with `_`), so it can never collide with a real preset.
