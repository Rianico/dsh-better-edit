# 04 — Consolidate Store tenancy

**What to build:** One Store seam answers "which store, where, and is it open?" end-to-end — `store-tenancy` + `store-lifecycle` + `hash-store`'s `openDb`/`buildStore`/`quarantine`/`busy-retry` plumbing collapse into `store/index.ts` (tenancy + lifecycle private), leaving `hash-store` with only schema + row-family domain logic and `store-config` calling the Store seam for its path. YAGNI-gated: do this when the next store/config feature lands.

**Blocked by:** 03 — Finish Mutation deepening: own the transaction

**Status:** ready-for-agent

- [ ] Single Store seam owns tenancy + lifecycle + path resolution; `hash-store` keeps only schema + row families (~400 lines) and `store-config` calls the Store seam for its path
- [ ] Corruption quarantine / WAL / busy-retry / legacy JSON migration co-locate and are testable without importing hash-store domain helpers
- [ ] `pnpm test` and `npm run typecheck` green; no store path or config contract change
