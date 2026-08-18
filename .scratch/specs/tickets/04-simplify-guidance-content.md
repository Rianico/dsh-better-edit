## Parent

# 7 ([Enhancement] Support Configurable Prompts to Improve Plugin Flexibility) · Spec: #8

## What to build

Rewrite the four sections' default guidance text following the writing-for-agents principles (`.agents/skills/writing-for-agents/`): shorter, imperative, no redundancy — the issue's complaint is partly that the current guidance is verbose. Rename the `*_GUIDELINES` constants to `*_GUIDANCE` per the domain glossary, updating all imports. The `_default/` template (materialized by the resolution work) reflects the tightened text automatically.

## Acceptance criteria

- [ ] The four guidance texts are simplified per writing-for-agents; each section's prose is visibly tighter with the essential contract (hash anchors, staleness rejection, all-or-nothing batch) preserved.
- [ ] `*_GUIDELINES` → `*_GUIDANCE` rename lands across `src/prompts.ts`, `src/index.ts`, and the guidance module; no stale references.
- [ ] Model-facing error codes and tool behavior are untouched (this is text-only).
- [ ] Nothing pins the old text (verified: no test/benchmark asserts section text) — suite stays green; CONTEXT.md glossary stays consistent.
- [ ] The materialized `_default/` files (see the template ticket) match the new text.

## Blocked by

#9 — guidance resolution core
