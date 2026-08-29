# Session-Keyed Served State; Global Undo and Snapshots

Date: 2026-08-12

## Status

accepted

## Context

Served state is the tool's record of which file lines it delivered into the model's context, used to verify edit ranges. It was stored as a global per-path namespace and wiped entirely at every session start. Because every pi process that loads the extension — main session, sub-agents, nested runs — fires `session_start`, any process start destroyed every other process's served record, and `pi -c` (continue) lost the rows the restarted session still needed.

## Decision

We decided to **key the served table by session id** (`(session_id, path)`), scope every served-state operation to the session's own rows, and **remove the session-start wipe**; GC is a TTL sweep on store open (no shutdown delete, so `pi -c` continuity holds). Session identity is `ctx.sessionManager.getSessionId()` — never `process.env.PI_SESSION_ID`, which a nested pi process inherits from its parent's bash spawn env (verified unreliable).

### Considered Options

- **Per-agent store files (physical isolation via `XDG_CONFIG_HOME` or a store override)** — rejected: requires launcher env injection into sub-agents (the subagent tool exposes no env field); fractures snapshot reuse and undo sharing, which are file-derived facts, not session knowledge; file sprawl plus GC; and it papers over the wrong global-wipe semantics instead of partitioning by the correct authority.
- **Session-keyed rows in one store** — accepted: the store's fact authority is *what this session's context has been shown*, so the partition is the session. pi already hands every process a unique, stable session id (`ctx.sessionManager.getSessionId()`; distinct per process, stable across `pi -c` — both verified), so isolation is automatic with no launcher cooperation and no env injection.
- **Session-keyed undo** — rejected. Undo's fact authority is *the file's previous state before the last edit* — a property of the file's edit history, not of the session. Its semantics is "revert the last edit to this file", and the file is workspace-global. Keying undo by session would make the parent's undo either refuse forever (the file never matches the parent's `resultContent` after an intervening sub-agent edit) or — without the guard — silently clobber newer work with older content. Global undo already carries the correct safety mechanism: before restoring, the tool verifies the current file content still equals the recorded `resultContent` and refuses with `[E_UNDO_STALE]` when the file moved on (edit-undo.ts). So global undo reverts the actual last edit and refuses on drift; session-keyed undo would be fragmented and refuse-mostly. Worktree isolation (separate paths → separate rows) is the answer if sub-agents ever need full edit separation.
- **Session-keyed snapshots** — rejected. Snapshots are a content-addressed cache keyed by `(path, checksum, line_count)`: validity is guaranteed by the checksum matching the file bytes, with no session dependence and no staleness hazard. Sharing them across sessions is a pure win (no re-hashing unchanged files); keying by session would fragment the cache with zero correctness gain.

## Consequences

- Any pi process loading the extension no longer wipes other sessions' served rows; the main model's anchors survive sub-agents and nested runs.
- `pi -c` keeps the same session id (verified), so the continued model can verify edits against rows served before the restart — the previous `[E_RANGE_UNVERIFIED]`-after-continue failure mode is gone.
- Drift-notice "once per episode" is per-session: each session's context receives its own notice for a drift it has not been told about.
- Dead sessions' served rows linger until the TTL sweep (7 days); rows are small and bounded by files read.
- Undo and snapshots keep their file-global semantics and their existing safety guards; no behavior change for single-session use.

## Amendment 2026-08-26 — Store seam deepening (Candidate 4)

### What changed

- **Schema ownership moved to domains.** `hash-store.ts` no longer owns `CREATE TABLE` for `snapshots` / `undo` / `served`. Each domain now exports `ensure*Schema(db)` and registers it via `onStoreOpen` — the Store lifecycle (`hash-store.ts`) only owns `PRAGMA` + `meta` + version handling. A fallback `CREATE IF NOT EXISTS` remains in `buildStore` for isolated tests that import only `hash-store`.
- **Unified busy-retry + statement cache.** `withBusyRetry` and `getCached` are now single helpers in `hash-store.ts` (re-exported via `src/store.ts` for the port). Per-module `WeakMap` caches still exist but go through `getCached`, replacing three duplicated retry wrappers.
- **Paths private inside Store.** `hashStorePath`, `hashStoreDir`, `legacyHashStorePath`, `configDir` are now defined privately in `hash-store.ts` (the Store lifecycle). `src/paths.ts` re-exports them for backward compatibility but is now a thin facade; `toCwd` stays in `paths.ts` (used by `edit`/`read`/`file-reader`).
- **withStore now fails loud.** Previously `withStore(fn)` silently ran `fn` without a transaction when `cachedDb` was null, losing atomicity for `pruneMissing`'s cross-table deletes. It now throws `Error("withStore requires an open SQLite store …")` if no DB is open. Tests that need no-DB behaviour use `MemorySnapshotStore`.
- **MemoryStore adapter.** `src/store.ts` introduces the Store port `SnapshotStore { get/put/delete/allHashes/allPaths }` with two adapters: `SQLiteSnapshotStore` (prod, wraps `DatabaseSync`) and `MemorySnapshotStore` (tests, pure `Map`). The two adapters justify the seam; existing SQLite tests keep passing, new `store-memory.test.ts` exercises the port contract without touching `fs` or `node:sqlite`.
- **hashline coupling is now explicit.** `snapshot-store.ts` still installs `setDefaultHashSnapshotIO` at import time for early cache availability, but also re-installs it via `onStoreOpen` — the Store lifecycle is the authority, not a hidden import side-effect. Callers that pass an explicit `store` via `snapshotIOFor(store)` bypass the default entirely (as `edit`/`file-reader`/`edit-pipeline` already do).

### Why session-keyed served was kept

The Store deepening is a structural refactor, not a semantic one. Session-keyed `served` (ADR-0002) remains correct: served state tracks *what this session's context has been shown*, while `undo` and `snapshots` track *file-derived facts*. The TTL sweep that was previously registered by `served-state` via `onStoreOpen` is now explicitly owned by `ensureServedSchema`'s `onStoreOpen` hook — unified opening, same GC semantics (7-day `SERVED_TTL_MS` sweep on open, no shutdown wipe, so `pi -c` continuity holds).

### Consequences of this amendment

- `buildStore` is no longer a god function; adding a new domain requires only a new `ensureSchema` + `onStoreOpen` — no lifecycle edit.
- `withStore` callers that previously relied on the silent no-op now fail fast; `pruneMissing` and served `upsert` paths already ensure a store is open before calling it, so no behaviour change in prod.
- `MemorySnapshotStore` lets unit tests for snapshot logic run without `HOME`/`XDG_CONFIG_HOME` temp dirs or real SQLite files.
- `ADR-0002`'s decision (session-keyed served) is unchanged; only the opening/ownership mechanics were deepened.

