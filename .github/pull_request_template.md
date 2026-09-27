<!-- markdownlint-disable MD041 -->

## Summary

<!-- 2-3 sentences: why this change, user-visible effect. -->

**Impact**: <!-- X files (Y +, Z -) --> · **Risk**: <!-- Low | Medium | High -->
<!-- Risk: Low = docs/tests only; Medium = isolated feature/fix; High = cross-module contract, migration, or BREAKING CHANGE -->

## What Changed

<!-- Grouped by system/feature, not a file list. Flag migrations, contract, or payload changes. -->

-

## Architecture

<!-- Mermaid before/after only when structural seams, layering, or data-flow changes; delete the section otherwise. -->

```mermaid
graph LR
  A --> B
```

## Landing

Landing: squash <!-- or: Landing: merge — see git-convention §5 -->

<!-- Read by the PR run of scripts/changelog-gate.py — the repo's gate, not the global pr-land skill. -->

## Checklist

- [ ] Formatter, linter, typecheck, and tests green (exact commands in `CONTRIBUTING.md`)
- [ ] Conventional Commits (`commitlint` + `husky`) — `npx commitlint --from=origin/main --to=HEAD`
- [ ] `CHANGELOG.md` `## [Unreleased]` updated (if user-facing)
- [ ] Docs / `docs/adr/` updated when seams or contracts change
- [ ] No generated artifacts committed outside `.lsz/tmp`
- [ ] Linked issue with `Closes #NN` (if applicable)

<!-- Related issues: list each on its own line below (never comma-separated: "Closes #1, #2" fails to close #2).
Closes #123
Closes #456
-->
