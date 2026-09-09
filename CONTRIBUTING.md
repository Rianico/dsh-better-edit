# Contributing to dsh-better-edit

## Conventional commits

- `feat[(scope)]: description` → MINOR, `fix[(scope)]:` → PATCH, `feat!:` / `BREAKING CHANGE:` → MAJOR
- Other types `docs|style|refactor|perf|test|build|ci|chore|revert` hidden unless `!`
- Scope is noun, description imperative present, lowercase, no period, ≤72 chars
- Enforced by `commitlint` + `husky` (`npx commitlint --from=origin/main --to=HEAD`)

## Changelog

`CHANGELOG.md` `## [Unreleased]` guarded by `pre-push` hook (`warn+block`, `uv run python scripts/changelog-unreleased.py update`) and `changelog-check.yml` (`pull_request` required, `diff -q` vs generated); `release.yml` runs `scripts/changelog-unreleased.py clear` then `semantic-release` owns versioned sections. Do not hand-edit versioned sections. Commit the sync as a hidden type (e.g. `chore: sync changelog unreleased section`) — a visible type (`feat`/`fix`/`docs` etc.) re-triggers the guard and loops forever. Hidden types `style|chore|refactor|test|build|ci` only appear when `!`/`BREAKING CHANGE`.

## Reporting Issues

Pick the template that matches your intent — see `.github/ISSUE_TEMPLATE/` (blank issues disabled, `config.yml` links #38):

| Intent      | Template                 | Structure                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Bug**     | `01-bug_report.yml`      | **Exemplar #38**: Summary → Environment (Version/Module/Trigger) → Steps to Reproduce (paste-complete file + operation map + exact payload) → Expected vs Actual (quote diff/logs) → Impact & Trigger Conditions → Root Cause / Suggested Fixes (optional, numbered tradeoffs) |
| **Feature** | `02-feature_request.yml` | Problem → Proposal → Alternatives → Additional context                                                                                                                                                                                                                         |

- Bugs: paste-complete, prefer text over screenshots, include `read` hashes / payload and `autoFixes`/balance delta. Link #38 as style reference.
- Features: state problem + proposal at minimum; alternatives optional.
  Prompt rule: when the model helps file an issue, infer `bug` vs `feat` from intent, ask for any missing `body` field of that form, and render via `gh issue create --template <file>`. View exemplar with `gh issue view 38 --json title,body --repo Rianico/dsh-better-edit`.

## Before PR

`pnpm run lint && pnpm run format && pnpm run typecheck && pnpm test` must pass. See `AGENTS.md` for agent rules.

## Pull Requests

Prefer topic branch → PR → squash merge. Keep one concern per PR; link the issue with `Closes #NN` in the description or commit footer.

### Description

PR body is auto-populated from `.github/pull_request_template.md` (GitHub PR template). Keep the four headings — delete `Architecture` when no structural change:

- **Summary** — 2-3 sentences on _why_, not what line changed. Include `**Impact**: X files (Y +, Z -) · **Risk**: Low | Medium | High` (Low = docs/tests only; Medium = isolated feature/fix; High = cross-module contract, migration, or `BREAKING CHANGE`).
- **What Changed** — grouped by system/feature (`hashline`, `anchors`, `session`, `payload`, `docs`, `ci`), not by file list. Flag migrations / API / `ADR-0007` payload `{path, edits:[[h,h,t]]}` / `CANON_VERSION` touches.
- **Architecture** — Mermaid `graph LR` / `sequenceDiagram` before → after only for structural seams, layering, or data-flow changes.
- **Checklist** — derived from change categories; start from the template checklist and add items as needed (e.g., benchmarks for perf, absorption notes for upstream sync).
  CI (`changelog-check.yml`, `verify`) must be green before requesting review.
