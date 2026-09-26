# dsh-better-edit — notes for agents

A DeepSeek Harness (`dsh`) plugin: hashline-anchored `read`/`edit`/`undo_last_edit` tools (`read_skill` for plain skill loads) plus per-preset guidance overrides. TypeScript, vitest. Checks: `pnpm run typecheck`, `pnpm test`, `pnpm run build`.

## Working with Git

Prefer issues + pull requests. See `CONTRIBUTING.md` for Conventional Commits (commitlint + husky) and `Closes #NN` convention.

### Runtime

TypeScript: pnpm v12 + .nvmrc (24) + TS v7 + Vite v8, verify via oxlint/oxfmt/tsc/vitest; see package.json

## Upstream sync — absorbing pi-better-edit

Upstream: <https://github.com/Rianico/pi-better-edit> — local checkout `../pi-better-edit` if present; add remote when needed: `git remote add upstream https://github.com/Rianico/pi-better-edit.git`.

Last absorbed checkpoint: `00f8c341574de69a980b3d8de168a080a860e42e` (2026-09-23 — v2.2.0-1-g00f8c34; absorbed as the v2 absorb on `map/absorb-v2`: T1–T6b line-identity rewrite, S1 changelog/CI scaffold, T7 docs truth, S2/S3 scaffold refresh, P0-61 #62/#63; 33 upstream commits `87a17eb..00f8c34`). Previous: `87a17ebf14a1d980015b721a4fc7082d4c3b9635` (2026-09-05 — v1.6.0; absorbed as #45–#48 via absorb/t1-audience, t2-drift-canon, t3-gemma, t4-epoch). Previous checkpoint `c1f080048cc28c6b9cc5bb7ede2f3f572dc8b450` (v1.1.4) was absorbed from base `6a9cefca6c6e7011f5a20f058f9e17e3375419da` (1.1.3) as `v0.3.0` via `absorb/t1`–`t7` worktrees (54 commits, ADRs 0002–0004 + payload break). Next absorb starts from `00f8c34..HEAD` (or `00f8c34..upstream/main`) — inspected `00f8c34..4213a72` (2026-09-26 `4213a72e2b26076f00ff61d3bf4868f647c33095` chore(scaffold) git-contract refresh) — scaffold/CI only, no semantic changes; cursor stays at `00f8c34` (scaffold/CI ignored by design, see `docs/absorption-plan.md`).

Deliberately NOT ported: upstream `windows: ReadWindow[]` (multi-window read, `pi-better-edit@00f8c34:src/file-content/preview.ts` `buildWindowedPreview`, cap `MAX_READ_WINDOWS = 16`) — ADR-0023 declines it: `buildWindowedPreview` unions rows by position under one shared line budget, and local `_mergeServedRows` already merges served rows across sequential `offset`/`limit` reads, so the port's whole delta is call-count convenience (ADR-0023: parity/convenience never justifies). Do not re-propose it without ADR-0023's predicate trigger firing.

Procedure — repeat every sync and record the new hash here:

1. Fetch: `git fetch upstream` or `git -C ../pi-better-edit fetch origin && git -C ../pi-better-edit log <last>..HEAD --oneline`.
2. Diff the range: `git -C ../pi-better-edit diff <last>..HEAD --stat` + `docs/adr/` scan + `benchmarks/results/` if present.
3. Plan: refresh `docs/absorption-plan.md` with Basis (`pi-better-edit@<last>..HEAD`), Decisions, Phases — preserve deep seams (HashAssign, SessionView, FileView, Mutation, AnchorPipeline), no flatten.
4. Port: per-ticket worktrees `absorb/tN-*` on seams, then integration `absorb/tN-integration`; keep payload contract `{path, edits:[[h,h,t]]}` (ADR-0003) and whitespace-insensitive canon `CANON_VERSION=2` (ADR-0002).
5. Verify each worktree and integration: `pnpm run typecheck && pnpm test` (integration also `pnpm run build`).
6. Record: update this section's `Last absorbed checkpoint` to the new upstream HEAD hash (full 40-char), append to `Checkpoint history` below and to `CHANGELOG.md` absorbed-range note.
7. Commit/PR: `absorb: pi-better-edit <short> — <summary>`, branch `absorb/<topic>`, PR with `Closes #NN`.

Checkpoint history (newest first):

- 2026-09-26 — `87a17eb..00f8c34` (v1.6.0 → v2.2.0-1-g00f8c34, 33 commits) — absorbed as the v2 absorb on `map/absorb-v2` (T1–T6b line-identity rewrite + S1 changelog/CI scaffold + T7 docs truth + S2/S3 scaffold refresh + P0-61 #62 dense-mirror gate and #63 0-matched write-through with the deliberate #24 supersession, ADR-0025); upstream v2 arc (2.0 tool-contract break through 2.2.0) + arch deepening + scaffold/CI (see docs/absorption-plan.md). Cursor holds at `00f8c34`: `00f8c34..4213a72` inspected (scaffold-only git-contract refresh) and held by design.
- 2026-09-05 — `7b9195851..87a17eb` (v1.2.1 → v1.6.0, 64 commits) — absorbed as #45 (audience split + code renames, dd1a779), #46 (canon-deficit drift, 95c4703), #47 (Gemma bleed hardening, e67f493), #48 (epoch full-read gating, 3918292); v1.4.0/v1.5.0 arch deepening + scaffold/CI ignored by design (see docs/absorption-plan.md).
- 2026-08-21 — `7b9195851037623484fe2840d081dab09f9f29d1` — fix: dense post-edit servedRows to keep chained edits verifiable (1 commit post-v1.1.4) — absorbed as 0.3.x fix.
- 2026-08-20 — `6a9cefca6c6e7011f5a20f058f9e17e3375419da` → `c1f080048cc28c6b9cc5bb7ede2f3f572dc8b450` (v1.1.4, 54 commits) — absorbed as `v0.3.0` via `absorb/t1-canon` … `absorb/t7-integration` (see `docs/absorption-plan.md`, ADRs 0002–0004, 0007–0008).

If upstream has no new commits since the last checkpoint, leave the hash unchanged and note "no new commits as of YYYY-MM-DD".

## Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues in `Rianico/dsh-better-edit`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Contribution

Conventional commits & changelog: see CONTRIBUTING.md
Git hooks: `.husky` runs `commit-msg` + `pre-commit` (wired by `npm install`). The CHANGELOG ledger is checked by the gate at BOTH CI boundaries (PR run and durable `main` run, `.github/workflows/changelog-check.yml`) — the pre-push amending guard is retired, see [ADR-0024](docs/adr/0024-changelog-prepush-guard-retired-gate-owns-boundaries.md); the local signal is the read-only `python3 scripts/changelog-unreleased.py check` (informational, never amends; baseline-aware local floor: `python3 scripts/changelog-gate.py ledger`).
