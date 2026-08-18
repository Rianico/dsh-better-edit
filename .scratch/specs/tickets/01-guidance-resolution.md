## Parent

# 7 ([Enhancement] Support Configurable Prompts to Improve Plugin Flexibility) · Spec: #8

## What to build

The core resolution module: given an agent's preset id (or none) and the plugin's shared home directory, produce the final `{ order, text }` for each of the four tool sections, walking the fallback chain `<preset>/<section>.md` → `_default/<section>.md` → compiled constant. Override files are plain markdown with an optional YAML `order` front-matter; filename is the section name minus the `tool:` prefix. This is the seam all later work builds on — no plugin wiring yet.

## Acceptance criteria

- [ ] A pure, unit-testable module exists (`src/guidance.ts` or similar) exporting: compiled-section render, front-matter parsing, per-section resolution, and a four-section composition given `(presetId | undefined, homeDir)`.
- [ ] Section files: `read.md`, `edit.md`, `batch_edit.md`, `undo_last_edit.md` map to `tool:read` (100), `tool:edit` (102), `tool:batch_edit` (103), `tool:undo_last_edit` (104).
- [ ] `order` front-matter (`---\norder: N\n---`) overrides the default order; a file without front-matter is pure prose; malformed front-matter degrades to pure prose.
- [ ] Fallback chain works per section: preset file → `_default/` file → compiled constant; any level optional; partial override (only some sections overridden) works.
- [ ] `presetId === undefined` resolves straight to compiled defaults (no preset layer).
- [ ] Unit tests cover resolution, parsing, and fallback against temp directories; the existing vitest suite stays green.
