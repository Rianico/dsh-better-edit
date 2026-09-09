<!-- markdownlint-disable MD041 -->

## Summary

<!-- 2-3 sentences: why this change, user-visible effect. -->

**Impact**: <!-- X files (Y +, Z -) --> · **Risk**: <!-- Low | Medium | High -->
<!-- Risk: Low = docs/tests only; Medium = isolated feature/fix; High = cross-module contract, migration, or BREAKING CHANGE -->

## What Changed

<!-- Grouped by system/feature, not file list. Flag migrations / API / payload-contract changes. -->
<!-- Example: - hashline: ... -->

-

## Architecture

<!-- Mermaid before/after only when structural seams, layering, or data-flow changes; delete section otherwise. -->

```mermaid
graph LR
  A --> B
```

## Checklist

- [ ] `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm test` green
- [ ] Conventional Commits (`commitlint` + `husky`) — `npx commitlint --from=origin/main --to=HEAD`
- [ ] `CHANGELOG.md` `## [Unreleased]` updated (if user-facing)
- [ ] Docs / `docs/adr/` updated when seams or contracts change
- [ ] No generated artifacts committed outside `.lsz/tmp`
- [ ] Linked issue with `Closes #NN` (if applicable)
