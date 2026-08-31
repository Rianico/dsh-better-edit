# 05 — Seal AnchorPipeline entry point

**What to build:** `hashline/` exposes only `anchor-pipeline` as the public seam so every hash anchor ordering concern goes through one interface — `hash-assign`/`hash`/`hasher`/`served` become `@internal` with an `eslint no-restricted-imports` guard preventing direct imports. No behavior change, just a sealed seam that keeps the `swapReversed → stripBare → stripDiff → valEdit → boundaryDups → verifyServed → resToSpan` invariant discoverable.

**Blocked by:** 03 — Finish Mutation deepening: own the transaction

**Status:** ready-for-agent

- [ ] `hashline/` callers import only `from "./hashline/anchor-pipeline.js"`; direct imports of `hashline/resolve`/`hash-assign` are guarded by lint
- [ ] No behavior or payload contract change; `pnpm test` and `npm run typecheck` green
