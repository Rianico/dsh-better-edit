# Contributing to dsh-better-edit
## Conventional commits
- `feat[(scope)]: description` → MINOR, `fix[(scope)]:` → PATCH, `feat!:` / `BREAKING CHANGE:` → MAJOR
- Other types `docs|style|refactor|perf|test|build|ci|chore|revert` hidden unless `!`
- Scope is noun, description imperative present, lowercase, no period, ≤72 chars
- Enforced by `commitlint` + `husky` (`npx commitlint --from=origin/main --to=HEAD`)
## Changelog
`CHANGELOG.md` `## [Unreleased]` guarded by `pre-push` hook (`warn+block`, `uv run python scripts/changelog-unreleased.py update`) and `changelog-check.yml` (`pull_request` required, `diff -q` vs generated); `release.yml` runs `scripts/changelog-unreleased.py clear` then `semantic-release` owns versioned sections. Do not hand-edit versioned sections. Hidden types `style|chore|refactor|test|build|ci` only appear when `!`/`BREAKING CHANGE`.
## Before PR
`npm run lint && npm run typecheck && npm test` must pass. See `AGENTS.md` for agent rules.
