# dsh-better-edit — notes for Claude Code

A DeepSeek Harness (`dsh`) plugin: hashline-anchored `read`/`edit`/`batch_edit`/`undo_last_edit` tools plus per-preset guidance overrides. TypeScript, vitest. Checks: `npm run typecheck`, `npm test`, `npm run build`.

## Releasing & publishing the npm package

Release is **tag-first**: the git tag creates the GitHub release, and `npm publish` is blocked until the tag exists.

1. **Release (headless-safe): `npm run release -- X.Y.Z`** — bumps the version in `package.json`/`package-lock.json`, moves the CHANGELOG `[Unreleased]` section to `[X.Y.Z] - <date>`, commits `chore: release vX.Y.Z`, creates annotated tag `vX.Y.Z`, and pushes branch + tag (pushing the tag triggers the GitHub Actions release workflow). It demands a **clean working tree** (an untracked artifact at the repo root blocks it — remove or commit it first) and a version newer than the current one.

2. **Publish: must run under the interactive shell.** `npm login` and `npm publish` print "Press ENTER to open in the browser…" and need a **browser 2FA/OTP step that a headless agent cannot complete** — hand that step to the user. Use `interactive_shell`:
   - `npm login --registry https://registry.npmjs.org` — run first when the stored token is stale. The machine's `~/.npmrc` defaults to the `npmmirror.com` mirror and its npmjs token expires, producing a 401/`ENEEDAUTH` (publish then fails with a misleading `E404 … do not have permission`).
   - `npm publish --registry https://registry.npmjs.org` — always pass the registry explicitly (the mirror is not write-accessible). The `prepublishOnly` gate re-runs typecheck + tests + `scripts/assert-tagged.mjs`, which refuses to publish until tag `vX.Y.Z` exists; `postpublish` (`scripts/tag-current.mjs`) is a harmless no-op when the tag already exists.
   - Verify success: `npm whoami --registry https://registry.npmjs.org` returns `rianico`, and `curl -s https://registry.npmjs.org/dsh-better-edit` shows `"latest": "X.Y.Z"`.

## Working with Git

Prefer issues + pull requests. See [`.agents/skills/git-std.md`](.agents/skills/git-std.md) for the repo's PR-first rule and `Closes #NN` convention.
