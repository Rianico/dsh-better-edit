# 02 — Split SessionView: extract workspace-context seam

**What to build:** `SessionView` keeps only the `served state` + `drift notice` invariant (merge + orphan healing + position reconstruction + `scanDrift` read-then-write) while a new `workspace-context` module owns execution context propagation (`withWorkspace`, `workspaceCwd`, `execCwd`/`execSessionKey`/`sessionKeyFor` + `AsyncLocalStorage`). The four shims (`workspace.ts`, `dsh-context.ts`, `served-store.ts`, `drift.ts`) are deleted so "where is served state?" vs "where does cwd come from?" each have one answer.

**Blocked by:** 01 — Deepen file encoding state seam

**Status:** ready-for-agent

- [ ] New `workspace-context` module propagates `cwd`/`sessionKey` from DSH execution into async chain; `session-view` no longer imports or re-exports context, path, or workspace helpers
- [ ] Four shims deleted and all imports updated (`tool-read`/`tool-edit`/`tool-undo`, `mutation`, `read-and-serve`, `hash-store`); no compat re-exports remain
- [ ] Drift tests run without mocking workspace and context tests run without importing drift; `pnpm test` and `npm run typecheck` green
