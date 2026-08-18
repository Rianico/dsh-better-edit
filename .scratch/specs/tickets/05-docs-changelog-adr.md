## Parent

# 7 ([Enhancement] Support Configurable Prompts to Improve Plugin Flexibility) · Spec: #8

## What to build

The user-facing documentation: a "Configuring guidance per preset" section in README.md and README.zh.md (where files live, `_default/` auto-creation, `cp -r _default <preset>`, front-matter `order`, fallback chain, read-once semantics), a CHANGELOG entry, and ADR-0001 recording the decision (per-preset guidance via override files in the plugin home; rejected: cordis row config and preset-composition shadowing — the latter is impossible because the plugin registers sections on the agent's own scope layer).

## Acceptance criteria

- [ ] README.md and README.zh.md document the override flow with a concrete example.
- [ ] CHANGELOG.md gains an entry describing the feature.
- [ ] `docs/adr/0001-*.md` records the decision and the scope-layering reason preset rows can't work.
- [ ] CONTEXT.md is consistent with the final vocabulary (guidance, section, order, preset).

## Blocked by

#11 — wire per-preset guidance · #12 — simplify guidance content
