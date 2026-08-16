# Changelog

All notable changes to the `dsh-better-edit` plugin will be documented in this file.

Entries link to the originating spec issue in [pi-hashline-edit-lsz](https://github.com/Rianico/pi-hashline-edit-lsz) where one exists.

## [Unreleased]

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
