# Contributing to dsh-better-edit

## Conventional commits

- `feat[(scope)]: description` → MINOR, `fix[(scope)]:` → PATCH, `feat!:` / `BREAKING CHANGE:` → MAJOR
- Other types `docs|style|refactor|perf|test|build|ci|chore|revert` hidden unless `!`
- Scope is noun, description imperative present, lowercase, no period, ≤72 chars
- Enforced by `commitlint` + `husky` (`npx commitlint --from=origin/main --to=HEAD`)

## Changelog

`CHANGELOG.md` `## [Unreleased]` gated by `scripts/changelog-gate.py` in `changelog-check.yml` (a PR run reads the `Landing:` declaration from the PR body; the `main` run is the durable one); `release.yml` runs `scripts/changelog-unreleased.py clear` then `semantic-release` owns versioned sections. Do not hand-edit versioned sections. Commit a sync as a hidden type (e.g. `chore: sync changelog unreleased section`) so it mints no ledger entry. Hidden types `style|chore|refactor|test|build|ci` only appear when `!`/`BREAKING CHANGE`. Local read-only probe: `python3 scripts/changelog-unreleased.py check` (exit-only, never amends) — the pre-push guard is retired, so a stale `## [Unreleased]` is no longer auto-amended; curation replaced projection.

## Release

Cut a release from `main` with the release workflow; five phases run in order, and each exits `0` before the next starts.

1. Check — working tree clean, on `main`, conventional commits.
2. Verify — `pnpm run verify` passes; it is the same gate CI runs.
3. Preview — a dry run prints the next version and its release notes.
4. Dispatch — run the release workflow and wait for it to succeed.
5. Confirm — the tag is reachable from `main` and `CHANGELOG.md` has the versioned section.

The ledger decides the bump. A user-facing feature needs a `feat` title; a breaking entry needs `!` in the title. A `fix` title licenses a patch and cannot publish a `### Features` entry.

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

PR body is auto-populated from `.github/pull_request_template.md` (canonical gh-router template — keep byte-identical via `skills/gh-router/scripts/install-template.sh --target . --force`; drift is reported by `--check`). Keep the contract headings — delete `Root Cause` for non-`fix` titles:

- **Summary** — lead with the visual that carries the change; brief supporting text on intent and user-visible effect, not a line-by-line narration.
- **Root Cause** — fix-only: one line naming why the bug happened. The squash gate requires it for `fix` titles.
- **Blast Radius & Safety** — `Door:` one-way/two-way first, then downstream consumers, breaking changes, data/state invariants, rollback/containment.
- **Evidence** — verbatim before/after commands + outputs; link the CI run.
- **Checklist** — start from the template checklist and add items as needed (e.g., benchmarks for perf, absorption notes for upstream sync).
- Include a `Landing: squash` line (or `merge`) — read by the PR run of `scripts/changelog-gate.py`; the squash gate strips it from the commit message.
  CI (`changelog-check.yml`, `verify`) must be green before requesting review.
