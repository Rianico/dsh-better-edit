# 03 — Finish Mutation deepening: own the transaction

**What to build:** `Mutation` owns the full file mutation lifecycle end-to-end — `applySequence → branch (single/batch × noop/applied) → commit → buildBatchResult → recordServedTruncated` — with two explicit `commitSingle`/`commitBatch` paths replacing the boolean `restoreUnwrittenUndos` seam. `edit-engine` becomes a private `mutation/engine.ts` implementation detail (`applyOne`/`runFileEdits` only), `edit-pipeline.ts` shim is deleted, and tools import only `mutation.execute` as the single interface.

**Blocked by:** 02 — Split SessionView: extract workspace-context seam

**Status:** ready-for-agent

- [ ] `persistUndoAndWrite` transaction lives inside `Mutation` as private `commitSingle`/`commitBatch` with per-caller `undoUnavailableMessage` and restore policy; no boolean flag crosses the seam
- [ ] `edit-engine` demoted to private implementation (or `src/mutation/engine.ts`) exporting only `applyOne`/`runFileEdits`; `edit-pipeline.ts` deleted and `mutation` re-exports of `enforceNoopLoop`/`collectRemovedHashes`/`countLineChanges` removed
- [ ] Write-failure restore (persist-undo → write → restore-on-failure) covered by `Mutation`-level tests with fake `FileIO`; `pnpm test` and `npm run typecheck` green, tool payloads unchanged
