# Spec — Issue #24 Store Tenancy (central default, configurable)

## Problem Statement

`dsh-better-edit` persists hash anchors, served rows and `undo` snapshots in `<workspace>/.dsh_better_edit/hash-store.sqlite`. Every first `read`/`edit` materializes a hidden directory in the user's project—untracked git pollution, archive/zip leakage of full-file undo clones (privacy), and per-workspace WAL growth. Location is hard-coded (`paths.ts:24` `configDir(cwd)`) with only a `$DSH_HOME` fallback outside a tool call. Users cannot opt-out without manual `.gitignore` edits and no central GC exists for invisible stores.

## Solution

Expose tenancy as a first-class yaml/env config with `central` as the new default.

* **Config file** `$DSH_HOME/plugins/dsh-better-edit/config.yaml` (single plugin config) + god envs `DSH_BETTER_EDIT_STORE_DIR` / `DSH_BETTER_EDIT_AUTO_GITIGNORE`. Precedence `env > yaml > default(central)`. Validation fails to `central` + `logger.warn`, never throws.
* **Tenancy** `storeDir: "workspace" | "central" | "/abs/path"` — `workspace` = legacy `<ws>/.dsh_better_edit/`, `central` = `$DSH_HOME/plugins/dsh-better-edit/runtime/<sanitizedBasename>-<hash8>/` (hash = `sha1(canonicalWs)[:8]` + sidecar `origPath`), `/abs` = custom central root `join(abs, hash8)`. File-per-workspace central keeps static `prepare() 4eX`, isolated WAL/lock, `rm -rf <hash>` eviction vs single-DB `workspace_id` column.
* **Git pollution** — `central` default eliminates pollution. `workspace` only warns once per ws if `.gitignore` lacks `^\.dsh_better_edit/` and optionally auto-appends when `autoGitignore:true` (yaml+env `true|false`).
* **Lifecycle** — plugin-owned for `central`/custom, user-owned for `workspace`. Throttled janitor on `apply` + `agent/session-start` (>24h), `readdir runtime` → `mtime>storeMaxAgeS` (default 2592000 s = 30 days) first, then LRU by `mtime` until `count<100 && sum<500MB` (`storeMaxAgeS/storeMaxTotalBytes`, both unified to seconds/bytes). Row TTL inside live DBs: `SERVED 7d` (exists) + `undo 7d` (`undo_ttl_s: 604800 int -1=forever`, seconds, unified with `storeMaxAgeS`) + `pruneMissing` batch 64 + `wal_checkpoint(TRUNCATE)` on close. DB files are disposable caches — safe to delete, rebuilt on next `read`. No `pid` level — cross-process via `withBusyRetry` + `mtime` (live DB mtime stays hot). Migration probe copies legacy `<ws>/.dsh_better_edit/` once on first central open.
* **Appreciation** — CHANGELOG entry links [#24](https://github.com/Rianico/dsh-better-edit/issues/24) and thanks [@MrWeiCodes](https://github.com/MrWeiCodes).

## User Stories

1. As a git user, I want no `.dsh_better_edit/` in my repo by default, so `git status` stays clean.
2. As a user who opted into `workspace`, I want a warning when `.gitignore` lacks the entry, so I don't commit it accidentally.
3. As a user who opted into `workspace` with `autoGitignore:true`, I want the plugin to append `.dsh_better_edit/` idempotently, so I don't hand-edit `.gitignore`.
4. As a privacy-conscious user, I want central stores invisible and not zipped with the project, so undo clones don't leak.
5. As an operator, I want `storeDir: central|workspace|/abs` in yaml, so tenancy is declarable.
6. As a CI operator, I want `DSH_BETTER_EDIT_STORE_DIR` to override yaml, so ephemeral jobs can use `/tmp`.
7. As a user who misconfigures `storeDir: ./relative` or `storeDir: ""`, I want fallback to `central` + warning, not a crash.
8. As a user who sets `DSH_BETTER_EDIT_AUTO_GITIGNORE=true|false`, I want it to mirror yaml `autoGitignore` semantics.
9. As a returning user with legacy `<ws>/.dsh_better_edit/`, I want first central open to copy it once, so anchors/undo survive the default flip.
10. As a central user, I want `ls runtime/` to be readable (`my-app-a1b2c3d4`), so I can map hash to project.
11. As a central user with many workspaces, I want old `runtime/<name>-<hash8>/` dirs GC'd after 30d / 500MB, so disk doesn't grow unbounded.
12. As a multi-process DSH user, I want two `dsh` processes sharing `$DSH_HOME` to not race-delete a live central DB.
13. As a long-lived editing user, I want `undo` to TTL 7d but be keepable forever via `undo_ttl_s: -1`, so privacy is bounded but power users can opt-out.
14. As a user who deletes a file, I want `pruneMissing` to reclaim its `snapshots/undo/served` rows, so store stays bounded.
15. As a user with WAL growth, I want `wal_checkpoint(TRUNCATE)` on close/janitor, so `-wal/-shm` don't linger.

## Implementation Decisions

* **Modules modified:** `paths.ts` (new `loadConfig/readConfig`, `resolveStoreDir`, `hash8`, `sanitizedBasename`, validation, fallback, migration probe), `hash-store.ts` (`storePathFor`, `openStore` throttled prune, `undo` TTL, janitor `readdir`), `session-view.ts`/`hash-store.ts` shared `loadHashStore`, `index.ts` (`apply` + `on("agent/session-start")` janitor install, `configDir()` reload with mtime cache), guidance docs.
* **Interfaces:** `configDir(cwd?)` stays but now reads merged `Config` (yaml+env) inside; new `storePathFor(cwd?)` remains the call seam — callers still pass `cwd`, now resolved via `resolveStoreDir`. No public API break.
* **Schema:** yaml Zod `storeDir: z.enum(["workspace","central"]).or(z.string().refine(isAbsolute))` — where the store lives (central/workspace/abs), `autoGitignore: z.boolean().default(false)` — workspace only: auto-append .dsh_better_edit/ vs warn, `undo_ttl_s: z.number().int().min(-1).default(604800)` — undo history TTL in seconds (-1 = forever), `storeMaxAgeS: z.number().int().min(1).default(2592000)` — central janitor max idle age in seconds (30 days), `storeMaxTotalBytes: z.number().int().min(0).default(524288000)` — central janitor max total bytes (500 MB). Unified to seconds: `undo_ttl_s` and `storeMaxAgeS` both use seconds. Deprecated aliases `storeMaxAgeDays`/`store_max_age_days` (days) and `store_max_age_s` (snake) are converted with a warning. Env `DSH_BETTER_EDIT_AUTO_GITIGNORE` parsed `toLowerCase()==="true"` else false + warn on other strings.
* **Path:** `canonicalWs = resolveTarget(ws)` before hash/basename; `hash8 = createHash("sha1").update(canonicalWs).digest("hex").slice(0,8)`; sidecar `join(dir, ".wsPath")` storing `canonicalWs` for collision proof.
* **Migration:** `loadHashStore` checks `!exists(centralPath) && exists(legacyWsPath)` then `cp -r legacyWsPath centralPath` (once, `fs.cp` with `recursive`), log `migrated legacy workspace store to central`.
* **Git warning:** inside `openStore` when `storeDir==workspace` && `exists(join(ws,".git"))` && `!gitignoreHasEntry` → `logger.warn` once per ws via `Set<ws>`.
* **Janitor:** `apply` `queueMicrotask(throttledJanitor)` + `agent/session-start` `if now-last>24h` → `readdir runtime`, `stat.mtimeMs`, never delete live `hash(workspaceCwd)` (`Set<hash(liveStores.keys())>`), evict `mtime>storeMaxAgeS` (seconds) then LRU. Row TTL: `DELETE FROM served WHERE updated_at < now-7d`, `DELETE FROM undo WHERE updated_at < now-undo_ttl_s*1000` (skip -1, both in seconds), `pruneMissing()` batch 64, all `withStore`. DB files are disposable — safe to delete, rebuilt on next `read`.

## Testing Decisions

* **Good test = external behavior on store path, not hash internals:** assert `storePathFor(ws)` with `central/workspace/abs` + env override + malformed fallback; assert `.gitignore` warning vs idempotent append; assert legacy copy once; assert janitor never deletes live; assert `undo` TTL delete vs `-1` keep.
* **Seams to test:** `paths.ts` pure `resolveStoreDir` + `sanitizedBasename/hash8`, `hash-store.ts` `openStore` pruning (stub `fs.stat`), `session-view.ts` `withWorkspace` integration. Reuse `test/core/paths.test.ts` stub-env pattern (`vi.stubEnv("DSH_HOME")`) and `test/support/fixtures.ts` `DSH_HOME` sandbox.
* **Prior art:** `paths.test.ts` `DSH_HOME` unset/empty cases, `edit-engine.e2e.test.ts` `bomStrippingCtxIO` double, `fs-bridge.policy.test.ts` `stat`/`readBytes` contract tests.

## Out of Scope

* Changing `SERVED_TTL 7d` value, `single DB + workspace_id` central, `pid` level per-process isolation, file watcher hot-reload (mtime cache only), `storeMaxTotalBytes` per-DB quotas, WAL `TRUNCATE` on every write.

## Further Notes

* Session isolation stays row-level `sessionKey` inside DB, not file-per-session — file-per-workspace central keeps WAL isolation.
* Flip default `workspace→central` is breaking for anchors/undo — migration probe makes it recoverable; keep `workspace` docs for opt-in.
* Central GC explains `runtime/<name>-<hash8>` `ls` readability requirement — `hash8.json` sidecar is the source of truth for prune logs.
