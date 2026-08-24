# 04 — Lifecycle janitor (central GC + row TTL + WAL, multi-process safe)

**What to build:** throttled janitor + row TTL + pruneMissing + WAL checkpoint — central invisible stores bounded, workspace user-owned, no pid level, live DB never deleted.

**Blocked by:** 02 — tenancy paths

**Status:** ready-for-agent

- [ ] throttled janitor: `apply` `queueMicrotask` + `on("agent/session-start")` if `now-last>24h` → `readdir runtime`, `stat mtimeMs`, never delete live `hash(workspaceCwd)` (`Set<hash(liveStores.keys())>`), evict `mtime>30d` first then LRU by `mtime` until `count<100 && sum<500MB` (`storeMax*` from config)
- [ ] row TTL on throttled `openStore`: `DELETE FROM served WHERE updated_at < now-7d` (exists) + `DELETE FROM undo WHERE updated_at < now-undo_ttl_s*1000` (skip -1) + `pruneMissing()` batch 64, all `withStore`
- [ ] `wal_checkpoint(TRUNCATE)` on `shutdownDb` + janitor (not every write); cross-process safety via `withBusyRetry` + `existsSync` guard, no `pid` subdir
- [ ] multi-process: two `dsh` sharing `$DSH_HOME` never `rm -rf` live hash — mtime hot even with 2 writers
