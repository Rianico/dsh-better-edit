# dsh-better-edit — notes for agents

A DeepSeek Harness (`dsh`) plugin: hashline-anchored `read`/`edit`/`undo_last_edit` tools (`read_skill` for plain skill loads) plus per-preset guidance overrides. TypeScript, vitest. Checks: `npm run typecheck`, `npm test`, `npm run build`.

## Releasing & publishing the npm package

Release is **tag-first**: the git tag creates the GitHub release, and `npm publish` is blocked until the tag exists.

1. **Release (headless-safe): `npm run release -- X.Y.Z`** — bumps the version in `package.json`/`package-lock.json`, moves the CHANGELOG `[Unreleased]` section to `[X.Y.Z] - <date>`, commits `chore: release vX.Y.Z`, creates annotated tag `vX.Y.Z`, and pushes branch + tag (pushing the tag triggers the GitHub Actions release workflow). It demands a **clean working tree** (an untracked artifact at the repo root blocks it — remove or commit it first) and a version newer than the current one.

2. **Publish: must run under the interactive shell.** `npm login` and `npm publish` print "Press ENTER to open in the browser…" and need a **browser 2FA/OTP step that a headless agent cannot complete** — hand that step to the user. Use `interactive_shell`:
   - `npm login --registry https://registry.npmjs.org` — run first when the stored token is stale. The machine's `~/.npmrc` defaults to the `npmmirror.com` mirror and its npmjs token expires, producing a 401/`ENEEDAUTH` (publish then fails with a misleading `E404 … do not have permission`).
   - `npm publish --registry https://registry.npmjs.org` — always pass the registry explicitly (the mirror is not write-accessible). The `prepublishOnly` gate re-runs typecheck + tests + `scripts/assert-tagged.mjs`, which refuses to publish until tag `vX.Y.Z` exists; `postpublish` (`scripts/tag-current.mjs`) is a harmless no-op when the tag already exists.
   - Verify success: `npm whoami --registry https://registry.npmjs.org` returns `rianico`, and `curl -s https://registry.npmjs.org/dsh-better-edit` shows `"latest": "X.Y.Z"`.

## Working with Git

Prefer issues + pull requests. See [`.agents/skills/git-std.md`](.agents/skills/git-std.md) for the repo's PR-first rule and `Closes #NN` convention.

## Upstream sync — absorbing pi-better-edit

Upstream: <https://github.com/Rianico/pi-better-edit> — local checkout `../pi-better-edit` if present; add remote when needed: `git remote add upstream https://github.com/Rianico/pi-better-edit.git`.

Last absorbed checkpoint: `87a17ebf14a1d980015b721a4fc7082d4c3b9635` (2026-09-05 — v1.6.0; absorbed as #45–#48 via absorb/t1-audience, t2-drift-canon, t3-gemma, t4-epoch). Previous: `7b9195851037623484fe2840d081dab09f9f29d1` (2026-08-21 — fix: dense post-edit servedRows, post-v1.1.4). Previous checkpoint `c1f080048cc28c6b9cc5bb7ede2f3f572dc8b450` (v1.1.4) was absorbed from base `6a9cefca6c6e7011f5a20f058f9e17e3375419da` (1.1.3) as `v0.3.0` via `absorb/t1`–`t7` worktrees (54 commits, ADRs 0002–0004 + payload break). Next absorb starts from `7b9195851..HEAD` (or `7b9195851..upstream/main`).

Procedure — repeat every sync and record the new hash here:

1. Fetch: `git fetch upstream` or `git -C ../pi-better-edit fetch origin && git -C ../pi-better-edit log <last>..HEAD --oneline`.
2. Diff the range: `git -C ../pi-better-edit diff <last>..HEAD --stat` + `docs/adr/` scan + `benchmarks/results/` if present.
3. Plan: refresh `docs/absorption-plan.md` with Basis (`pi-better-edit@<last>..HEAD`), Decisions, Phases — preserve deep seams (HashAssign, SessionView, FileView, Mutation, AnchorPipeline), no flatten.
4. Port: per-ticket worktrees `absorb/tN-*` on seams, then integration `absorb/tN-integration`; keep payload contract `{path, edits:[[h,h,t]]}` (ADR-0007) and whitespace-insensitive canon `CANON_VERSION=2`.
5. Verify each worktree and integration: `npm run typecheck && npm test` (integration also `npm run build`).
6. Record: update this section's `Last absorbed checkpoint` to the new upstream HEAD hash (full 40-char), append to `Checkpoint history` below and to `CHANGELOG.md` absorbed-range note.
7. Commit/PR: `absorb: pi-better-edit <short> — <summary>`, branch `absorb/<topic>`, PR with `Closes #NN`.

Checkpoint history (newest first):

- 2026-08-21 — `7b9195851037623484fe2840d081dab09f9f29d1` — fix: dense post-edit servedRows to keep chained edits verifiable (1 commit post-v1.1.4) — absorbed as 0.3.x fix.
- 2026-08-20 — `6a9cefca6c6e7011f5a20f058f9e17e3375419da` → `c1f080048cc28c6b9cc5bb7ede2f3f572dc8b450` (v1.1.4, 54 commits) — absorbed as `v0.3.0` via `absorb/t1-canon` … `absorb/t7-integration` (see `docs/absorption-plan.md`, ADRs 0002–0004, 0007–0008).

- 2026-09-05 — `7b9195851..87a17eb` (v1.2.1 → v1.6.0, 64 commits) — absorbed as #45 (audience split + code renames, dd1a779), #46 (canon-deficit drift, 95c4703), #47 (Gemma bleed hardening, e67f493), #48 (epoch full-read gating, 3918292); v1.4.0/v1.5.0 arch deepening + scaffold/CI ignored by design (see docs/absorption-plan.md).

If upstream has no new commits since the last checkpoint, leave the hash unchanged and note "no new commits as of YYYY-MM-DD".

### Contribution

Conventional commits & changelog: see CONTRIBUTING.md
