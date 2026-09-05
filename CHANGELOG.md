## [Unreleased]

### Features

- **session-view:** canon-deficit drift instead of hash rotation (Closes #46) (#50)
- user/model audience split + glossary error codes (#49) (BREAKING CHANGE)

### Fixed

- **edit:** Gemma-4 tool-call bleed hardening + prompt channel wording (Closes #47)

### Documentation

- migrate CLAUDE.md to AGENTS.md with symlink

## [0.6.3](https://github.com/Rianico/dsh-better-edit/compare/v0.6.2...v0.6.3) (2026-09-05)

### Bug Fixes

* **self-heal:** restore hash-anchored read/edit after external takeover ([#43](https://github.com/Rianico/dsh-better-edit/issues/43)) ([#44](https://github.com/Rianico/dsh-better-edit/issues/44)) ([b53fc75](https://github.com/Rianico/dsh-better-edit/commit/b53fc753bcd71f1950bde61ad81e1b7b94758273))

## [0.6.2](https://github.com/Rianico/dsh-better-edit/compare/v0.6.1...v0.6.2) (2026-09-03)

### Bug Fixes

* **deps:** upgrade dsh dependencies to 0.1.1-rc.2 ([30e6029](https://github.com/Rianico/dsh-better-edit/commit/30e6029888fa517f20c640b7a38523a8a6148ccd))

### Documentation

* **readme:** compact rewrite — pos-free hero, round-trips, tokens ([dc468c5](https://github.com/Rianico/dsh-better-edit/commit/dc468c5ce9799ddf9578d92e715905701b2a95a1))

## [0.6.1](https://github.com/Rianico/dsh-better-edit/compare/v0.6.0...v0.6.1) (2026-09-01)

### Bug Fixes

* **hashline:** prevent freed anchor reuse ([#31](https://github.com/Rianico/dsh-better-edit/issues/31)) ([#42](https://github.com/Rianico/dsh-better-edit/issues/42)) ([19724a4](https://github.com/Rianico/dsh-better-edit/commit/19724a4083afcfc104172d5ce71bb6ab198026b7)), closes [GH#41](https://github.com/Rianico/GH/issues/41)

## [0.6.0](https://github.com/Rianico/dsh-better-edit/compare/v0.5.1...v0.6.0) (2026-08-31)

### Features

* **edit:** render diff card after tool calling ([df7712c](https://github.com/Rianico/dsh-better-edit/commit/df7712cef265dfec424feefb60c19f833d380f9f))
* **hashline:** remove boundaryDups auto-fix (Closes [#38](https://github.com/Rianico/dsh-better-edit/issues/38)) ([54d0bc6](https://github.com/Rianico/dsh-better-edit/commit/54d0bc6c9078fbcffa6f7a531e80e005774156a4))

### Bug Fixes

* **ci:** add neural version check to Verify and Release ([7f85b56](https://github.com/Rianico/dsh-better-edit/commit/7f85b5605e228d19bcde802ce2b10affc90fbde7))

## [0.5.1](https://github.com/Rianico/dsh-better-edit/compare/v0.5.0...v0.5.1) (2026-08-30)

### Bug Fixes

* **encoding:** support non-UTF-8 text files via VS Code model ([#34](https://github.com/Rianico/dsh-better-edit/issues/34)) ([#35](https://github.com/Rianico/dsh-better-edit/issues/35)) ([dd3e553](https://github.com/Rianico/dsh-better-edit/commit/dd3e553a3877e47b08aa2ba6336115e80b5d96f5))
* **lint:** address biome blockers for release ([00b9270](https://github.com/Rianico/dsh-better-edit/commit/00b92704ac4093a627754e698bb1968acdc3d4e8))
* remove unused exitHandlerRegistered ([f6a29f3](https://github.com/Rianico/dsh-better-edit/commit/f6a29f3f1dd694e4bb7c55a98d0eba80bc32a58f))
* **scripts:** map fix to Fixed for Keep a Changelog ([bcd1850](https://github.com/Rianico/dsh-better-edit/commit/bcd18501e280b10d5075108c034de7352ece6922))

# Changelog

All notable changes to the `dsh-better-edit` plugin will be documented in this file.

Entries link to the originating spec issue in [pi-hashline-edit-lsz](https://github.com/Rianico/pi-hashline-edit-lsz) where one exists.

## [0.5.0] - 2026-08-29

### Features

- **edit:** route drift signals to user-facing details (pi-better-edit@6ec52f2)
- scaffold verify→release with biome+coverage 80%

### Bug Fixes

- **ci:** lower coverage threshold to 75 and add SAFETY for hash-store cast
- **tests:** align drift expectations with user-facing routing (6ec52f2)
- **hashline:** add E_EDIT_HASH_ECHO guard for served echo (pi-better-edit@65b8eb1)
- clarify HASH vs content without served
- **edit:** clarify HASH vs HASH│content and downgrade bare prefix warnings (pi-better-edit@a837e9d)
- **fs-write:** log stale-temp and sync failures (pi-better-edit@671c66d)
- **hashline:** heal multi-line staleness and stable anchoring (f94fb88)
- **git:** wire pre-push hook via husky path

## [0.4.1] - 2026-08-27

### Fixed

- Refuse a built-in `write` before dispatch when a candidate line starts with the exact hashline anchor served for the same session, canonical path, and line. This prevents copied `HASH│` preview chains from entering Markdown while leaving the file byte-identical; unrelated hash-like text is not generically stripped (#29).

## [0.4.0] - 2026-08-24

### Added

- Configurable store tenancy with central default (`$DSH_HOME/plugins/dsh-better-edit/runtime/<name>-<hash8>/`), `workspace` legacy opt-in, and custom `/abs` root — yaml at `$DSH_HOME/plugins/dsh-better-edit/config.yaml` (`storeDir` — where the store lives, `autoGitignore` — workspace .gitignore handling, `undo_ttl_s` — undo TTL in seconds (-1 = forever), `storeMaxAgeS` — central janitor max idle age in seconds (default 30 days), `storeMaxTotalBytes` — central janitor max total bytes) + god envs `DSH_BETTER_EDIT_STORE_DIR`/`DSH_BETTER_EDIT_AUTO_GITIGNORE` (`env > yaml > central`) with malformed fallback to central and warnings. DB files are disposable caches — safe to delete, rebuilt on next `read` ([#24](https://github.com/Rianico/dsh-better-edit/issues/24)). Thanks to [@MrWeiCodes](https://github.com/MrWeiCodes) for the proposal and design discussion.
- Readable `runtime/<name>-<hash8>/` with `.wsPath` sidecar for collision proof.

### Changed

- Default store location moved from workspace-co-located to central `runtime/` to eliminate git pollution and zip privacy leakage — `workspace` now requires explicit `storeDir: workspace`.
- Store lifecycle now plugin-owned for central/custom (throttled janitor on `apply` + `agent/session-start` >24h, `mtime>storeMaxAgeS` (default 30 days / 2592000 s, unified to seconds with `undo_ttl_s`) then LRU to `count<100 && sum<500MB`, never deleting live `hash(workspaceCwd)`), `wal_checkpoint(TRUNCATE)` on close/janitor, `undo` TTL `undo_ttl_s` (default 7d, `-1` = forever, seconds), `pruneMissing` batch 64 — workspace mode remains user-owned with row TTL only. DB files are disposable caches — safe to delete, rebuilt on next `read`.

### Fixed

- `.gitignore` pollution warning for `workspace` mode and idempotent `autoGitignore` opt-in (yaml+env `true|false`).

## [0.4.0-rc.1] - 2026-08-24

### Added

- Configurable store tenancy with central default (`$DSH_HOME/plugins/dsh-better-edit/runtime/<name>-<hash8>/`), `workspace` legacy opt-in, and custom `/abs` root — yaml at `$DSH_HOME/plugins/dsh-better-edit/config.yaml` (`storeDir` — where the store lives, `autoGitignore` — workspace .gitignore handling, `undo_ttl_s` — undo TTL in seconds (-1 = forever), `storeMaxAgeS` — central janitor max idle age in seconds (default 30 days), `storeMaxTotalBytes` — central janitor max total bytes) + god envs `DSH_BETTER_EDIT_STORE_DIR`/`DSH_BETTER_EDIT_AUTO_GITIGNORE` (`env > yaml > central`) with malformed fallback to central and warnings. DB files are disposable caches — safe to delete, rebuilt on next `read` ([#24](https://github.com/Rianico/dsh-better-edit/issues/24)). Thanks to [@MrWeiCodes](https://github.com/MrWeiCodes) for the proposal and design discussion.
- Readable `runtime/<name>-<hash8>/` with `.wsPath` sidecar for collision proof.

### Changed

- Default store location moved from workspace-co-located to central `runtime/` to eliminate git pollution and zip privacy leakage — `workspace` now requires explicit `storeDir: workspace`.
- Store lifecycle now plugin-owned for central/custom (throttled janitor on `apply` + `agent/session-start` >24h, `mtime>storeMaxAgeS` (default 30 days / 2592000 s, unified to seconds with `undo_ttl_s`) then LRU to `count<100 && sum<500MB`, never deleting live `hash(workspaceCwd)`), `wal_checkpoint(TRUNCATE)` on close/janitor, `undo` TTL `undo_ttl_s` (default 7d, `-1` = forever, seconds), `pruneMissing` batch 64 — workspace mode remains user-owned with row TTL only. DB files are disposable caches — safe to delete, rebuilt on next `read`.

### Fixed

- `.gitignore` pollution warning for `workspace` mode and idempotent `autoGitignore` opt-in (yaml+env `true|false`).

## [0.3.2] - 2026-08-23

### Fixed

- Preserve a stripped UTF-8 BOM across `ctx.fs`-backed `edit` and `undo_last_edit` writes while retaining the file's original line endings (#23).

## [0.3.1] - 2026-08-21

### Changed

- Deepen `Mutation` owns edit lifecycle (C01, #21): collapse `tool-edit` orchestrator (260→121 lines) into `mutation.ts:execute()` deep seam — one interface owning `applySequence → commit → buildBatchResult → recordServedTruncated` with correct `undoUnavailableMessage`/`restoreUnwrittenUndos` branching; `tool-edit` thin adapter `validate → execute`.

- Heal guidance ghost (C02, #21): remove `batch_edit` seam — `GUIDANCE_SECTIONS` 4→3, `materialize.ts` ghost `batch_edit.md` cleanup (shipped + custom presets, `ENOENT`-tolerant), keep `BATCH_EDIT_*` as `@deprecated` aliases; order gap `132` preserved.

### Fixed

- Dense `servedRows` port `pi-better-edit@7b91958` (post-v1.1.4): `edit-response:buildChanged/buildBatchResult` and `tool-undo` now emit dense `0..n-1` `servedRows` instead of sparse diff rows; `firstChangedLine` fallback to `undoDiffResult` — fixes `E_RANGE_UNVERIFIED` on chained edits.

- Fix `tool-undo` SAFETY cast `canonical as unknown as FsEscalationArgs` + `withWorkspace` indentation (2→4 tabs) and `edit-response` biome fixes (no behavior change).

- Fix `guidance/resolve.ts` double-tab indent left by `batch_edit` removal on `tool:undo_last_edit` entry.

### Added

- Docs: `CLAUDE.md` upstream sync section — last absorbed checkpoint `7b91958` (dense `servedRows`), procedure, checkpoint history, `upstream` remote.

## [0.3.0] - 2026-08-20

### Changed

- **BREAKING** — `edit` now requires `{ path, edits: [[remove_from, remove_to, replacement_text], ...] }` tuple payload (ADR-0003); `batch_edit` removed — single `edit` covers single and batched edits via `edits` arity (ADR-0007). `EDITS_MAX_ITEMS=32`, path nullable (`null` infers from anchors). Old top-level `{remove_from,remove_to,replacement_text}` shape now fails with `[E_BAD_SHAPE]`.
- Whitespace-insensitive anchors (ADR-0002): `canon()` strips all ASCII whitespace `[ \t\r\n]` (`CANON_VERSION=2`, memoized `getCanon`), snapshot cache versioned so pre-upgrade caches invalidate; formatter-only drift (prettier/black) no longer rotates anchors. String-internal whitespace caveat documented.
- Orphaned serve healing & served robustness (ADR-0004): `SessionView.patchServed` eagerly heals stale duplicates, `verifyServedRange` disambiguates candidate spans, truncation on rejection-echo/external-shrink ends the `E_RANGE_UNVERIFIED` self-loop.
- Hashline purity & store seams (ARCH C1-C4): `HashSnapshotIO` injection keeps hashing pure, `recordDiffServes` helper, one `applyOneEdit` composition, `DebouncedPreview` (150ms) extracted, noop-loop folded, per-domain stmt slices.
- Notices & prompts hygiene: Zed-style terse drift/noop/rejection notices (codes unchanged), lean guidelines (dedupe tool descriptions), tool schema descriptions trimmed to one-liners.
- README brooks-lint reorg + CONTEXT glossary merge: hook, shining points, Why Hashline before Tools, benchmark section referencing `pi-better-edit/benchmarks/results/` (same hashline algorithm).

## [0.2.2] - 2026-08-19

### Added

- Guidance reset & restore defaults (issue #17): emptying or deleting an override file — or deleting its whole `<preset>/` directory — restores that section's compiled default guidance and order: the default renders at session-start and the file re-seeds at next boot (shipped presets; a deleted custom-preset override stays absent). A whitespace-only file with no front-matter fence means "I want the default"; any well-formed fence (even keyless, even an empty body) is a deliberate-intent signal and is never reset. Malformed fences now fast-fail instead of degrading to prose: a missing closing `---`, a non-integer `order`, or an unknown key rejects the file — the compiled default renders, a warning names the file and the reason, and the file is left untouched on disk for repair.

## [0.2.1] - 2026-08-18

### Added

- Configurable per-preset tool guidance (issues #7, #8; tickets #9–#13): the four `tool:*` prompt sections resolve from plain-markdown override files keyed by agent preset — `$DSH_HOME/plugins/dsh-better-edit/<preset>/<section>.md` — with an optional `order` front-matter. On first boot the plugin seeds each shipped preset (`standard`, `code`, `minimal`, `cordis`) with its guidance as editable files plus a root README documenting the scheme. Per section the chain is `<preset>/<section>.md` → compiled default; files are read once per agent at session-start, so edits apply to new sessions. Deployments without the `agentPresets` service keep the compiled defaults untouched.
Default orders sit at 130–133, above the built-in tool-guidance band (100–116 in the shipped
dsh), so a same-order section merge with unrelated tool guidance cannot occur out of the box; the
seeded preset files expose that `order` as editable front-matter.
- Default guidance text simplified per the writing-for-agents principles; the `*_GUIDELINES` constants unified on `*_GUIDANCE`.
- Thanks to [@R-LEI2536](https://github.com/R-LEI2536) for requesting configurable per-preset prompts and for the design input that shaped this release (issue [#7](https://github.com/Rianico/dsh-better-edit/issues/7)).

### Changed

- Benchmark extended to a third arm, `@oh-my-pi/hashline`: same corpus, same 12 replacements, two modes (per-edit `seq` with renumbered lines + one-document `batch` fixed to original line numbers). Payloads are built from the package's published grammar and validated before counting (the package is Bun-only, so it cannot run under the Node benchmark). Honest result, reported as such: hashline saves 31% vs `str_replace` on the session (43% on multi-line ranges) and remains the plugin's claim; the compact patch language saves 42% per edit / 53% batched — and this README says so. `npm run benchmark` stays byte-deterministic (verified over repeated runs).
- READMEs (English and 中文) refined along ponytail-style lines: "How It Compares" gains an `@oh-my-pi/hashline` column plus a same-lineage/different-jobs comparison; the Benchmark section documents all three arms, adds an honest "regenerate, don't trust" reproducibility note, and widens the scope-and-honesty block with what the payload numbers do *not* capture (renumber/tag-chase cost, block ops, Bun-vs-Node, tool-pair vs patcher library).
- `package.json` keywords now include `oh-my-pi` alongside `hashline`.
- Roadmap gains a first-class decision item: close or justify the gap vs `@oh-my-pi/hashline` (payload-lighter by 42%/53% vs 31%, with block ops / registers / `REM`/`MV` / multi-hunk documents / pluggable fs we do not support — against correctness costs: unverified line numbers, renumber-per-edit, best-effort merge on stale tags, model skill floor). A reference record lives at `../oh-my-pi.md` (workspace-level, outside this repo): the token comparison, the correctness asymmetry, the ability-by-ability status, and the decision rationale.

## [0.2.0] - 2026-08-16

### Changed

- Architecture deepening across six refactors (GitHub issues #1–#6), with the model-facing contract unchanged — every `[E_…]` code and message byte-identical, full suite green (615 → 626 tests):
  - Served state (what the model has been shown) now lives in one async module: the doubled sync/async store interface (whose sync half had zero production callers) is gone, and the served-row merge invariant — stale tail / duplicate anchors — is one shared helper with a regression test.
  - `edit` and `batch_edit` run on one edit-sequence engine — apply-one, the multi-edit sequencer, the noop-loop guard, and the persist-undo → write → restore transaction — replacing `batch_edit`'s duplicated 685-line pipeline with a thin orchestrator. Batch apply, atomic batch rejection, and undo revert are now covered by end-to-end tests.
  - The hashline anchor math is a pure module (no store imports); persistence is a thin wrapper over it. The public hashline interface shrank to the consumer call surface.
  - The `read` tool and the write auto-read share one read-and-serve operation; canonical path resolution moved out of the write module into the path helpers.
  - All four tools validate requests through one contract module — field sets and the `[E_BAD_SHAPE]` vocabulary declared once.
  - The hash store exposes domain APIs (snapshots / undo / served) instead of raw prepared statements; corruption handling and cross-table cleanup are owned by the store, and the import graph is acyclic.

## [0.1.9] - 2026-08-15

### Changed

- READMEs (English and 中文): added a concise "Why you need this" opening section — the transcription cost and 46–51% patch-failure rate of `str_replace`, the 31%/43% edit-token savings, verified landing, and the leaner-context benefit (the model's attention stays on the code, not on re-transcribing it) — placed before Quick Start so the demo stays immediately visible. Fixed the stale static version badge.

## [0.1.8] - 2026-08-15

### Added

- This CHANGELOG (Keep-a-Changelog style, following the pi-interactive-shell layout), shipped in the npm tarball.
- Git tag / GitHub release automation: a `postpublish` hook (`scripts/tag-current.mjs`) reads the version from `package.json`, creates an annotated `vX.Y.Z` tag at HEAD and pushes it, so every successful `npm publish` stays in sync with git; a GitHub Actions workflow (`.github/workflows/release.yml`) turns any `v*` tag push into a release with auto-generated notes.
- Backfilled `v0.1.0`–`v0.1.7` git tags and GitHub releases at their version-bump commits.

## [0.1.7] - 2026-08-15

### Added

- `assets/logo.svg` and `assets/banner.svg` (file.ts → read → hashed lines → edit by hash → diff), shipped in the npm tarball.
- READMEs (English and 中文) restyled in a centered, image-led layout: badge row, harness-problem pull-quote, example-driven Quick Start, a hashline-vs-`str_replace`-vs-line-number comparison table, project-structure tree, roadmap, acknowledgments, and a star-history chart.

### Changed

- The published tarball now includes `assets/` alongside `README.md` and `README.zh.md`.

## [0.1.6] - 2026-08-15

### Added

- Chinese README (`README.zh.md`) — a full translation mirroring the English one (pillars, diagrams, benchmark, tools, error codes, lineage).
- Reciprocal language links at the top of both READMEs; `README.zh.md` shipped in the npm tarball.

## [0.1.5] - 2026-08-15

### Added

- Reproducible token-cost benchmark (`benchmark/run.mjs` + frozen 103-line corpus + methodology): hashline vs `str_replace` on the same file with the same 12 replacements — 31% fewer output tokens over the session (43% on multi-line ranges), ~1.4× cheaper on effective cost at the 5× output-token rate. Deterministic: content-addressed self-checking edit script, pinned `js-tiktoken` `cl100k_base` devDependency. Run with `npm run benchmark`.
- README rewritten around the three pillars — token-saving, correctness, and the modern content-addressed edit pattern — with Mermaid diagrams, a `str_replace` comparison table, and an inspiration/lineage section (The Harness Problem, pi-hashline-edit, pi-hashline-edit-pro, pi-hashline-edit-lsz).

## [0.1.4] - 2026-08-15

### Fixed

- `E_RANGE_UNVERIFIED` ("served at N positions") on edits after a shrinking write: the served-state array was upserted by position but never truncated to the file's current line count, so a stale tail kept a surviving line's hash at its OLD position while the current serve held it at its new one. `recordServed`/`recordServes` now take the current line count and truncate before upserting, threaded from every whole-file serve — read, write auto-read, drift rows, and all rejection-echo sites. Regression test covers the 8-line→2-line write case ([Rianico/pi-hashline-edit-lsz#27](https://github.com/Rianico/pi-hashline-edit-lsz/issues/27)).
- The fix is a candidate to upstream into pi-hashline-edit-lsz / upstream, whose `upsertServed` has the same never-truncate behavior (tracked in [Rianico/pi-hashline-edit-lsz#27](https://github.com/Rianico/pi-hashline-edit-lsz/issues/27)).

## [0.1.3] - 2026-08-15

### Fixed

- Sandboxed sessions rejected in-workspace edits while the built-in `write` succeeded: the shadowed mutating tools called `fs.writeText` without the per-call sandbox policy, so a confined backend fell back to the deployment root. Tools now mirror `@deepseek-ai/dsh-tool-fs`'s `FsSandboxController` — resolve the policy with the session cwd as the workspace root, advertise `sandbox_permissions`/`justification`, pass the policy to `fs.writeText`, and map `FS_SANDBOX_DENIED` to the shared `[sandbox: …]` marker.

## [0.1.2] - 2026-08-15

### Changed

- The hash store moved from `$DSH_HOME/plugins/dsh-better-edit` to a per-workspace location: `<workspace>/.dsh_better_edit/hash-store.sqlite`, carried per tool call via an AsyncLocalStorage workspace context (`src/workspace.ts`). Parallel sessions in different workspaces no longer share anchors or undo history. The shared home path remains the fallback for tests/previews.
- Undo history from before 0.1.2 is not migrated to the new layout.

## [0.1.1] - 2026-08-15

### Fixed

- Shadowed tools silently never registering, leaving sessions on the built-ins: per-agent installation failed with `cannot get property "fs" without inject` at `session-start`. The plugin now declares `inject = ['tools', 'systemPrompt', 'fs']` and resolves the host `fs` service from the plugin's own `rootCtx` (the agent fiber chain does not carry the plugin's inject list).

## [0.1.0] - 2026-08-14

### Added

- Initial dsh port of pi-hashline-edit-lsz: hash-anchored `read` / `edit` / `batch_edit` / `undo_last_edit` tools for DeepSeek Harness. Every line gets a unique 3-character content hash; edits target `remove_from`/`remove_to` hashes. The hashline core is ported byte-for-byte; the tool layer is rewritten on dsh's plugin API ([batch_edit spec: Rianico/pi-hashline-edit-lsz#19](https://github.com/Rianico/pi-hashline-edit-lsz/issues/19)).
- Built-in replacement via scope-layered registry shadowing: on `agent/session-start` the tools and the `tool:read`/`tool:edit` prompt sections are registered on the agent's own layer (own-layer-wins), unwinding automatically on disposal; a `tools/post-execute` listener appends the auto-read to built-in `write` results.
- Served-state range verification with reject-and-serve: every line of the resolved range is checked against what the model was shown; stale/never-served/unverified ranges are hard-rejected with the current `HASH│content` rows echoed back (retry needs no `read`). Drift notices report served territory changed outside the edit range ([reject-and-serve spec: Rianico/pi-hashline-edit-lsz#13](https://github.com/Rianico/pi-hashline-edit-lsz/issues/13)).
- Chained edits without re-reading: post-edit diff rows and rejection echoes count as serves, so follow-up edits verify cleanly.
- Error-code contract (`[E_*]` codes, README-documented and test-enforced) including the noop-loop guard ([Rianico/pi-hashline-edit-lsz#18](https://github.com/Rianico/pi-hashline-edit-lsz/issues/18)); `undo_last_edit` surviving restarts; and safe writes preserving permissions, line endings, BOMs, symlinks, and hard links via `ctx.fs`.
- Test suite ported from pi-hashline-edit-lsz (614 tests at release), driving the dsh tool builders directly over a local filesystem bridge.
