# Session-Keyed Served-State Isolation

## Problem Statement

The served-state store is a **global single namespace** (one row per path) with a **full-table wipe at every session start**. Every pi process that loads the extension — the main session, every sub-agent (`context: fresh` or `fork`), every nested `pi -p` run, every test harness — fires `session_start` → `wipeServedState()` (`DELETE FROM served`), destroying every other process's served record. Empirically verified: after any pi process starts, the store holds only that process's reads; the main session's serves are gone. Symptom: the main model edits with anchors it was served and gets `[E_RANGE_UNVERIFIED]` / `[E_RANGE_UNSERVED]` because a sub-agent's `session_start` wiped the record mid-work.

Separately, `pi -c` (continue) reuses the **same session id** and the same session file (verified), but the new process wipes the table at start — so the continued model cannot verify edits against content it read before the restart.

Served state's fact authority is *"what this session's model context has been shown"* — inherently session-private. The store models it as a global namespace, and the wipe is a blunt instrument.

## Solution

Partition the served table **by session id**. Every row gains a `session_id`; the key becomes `(session_id, path)`. All serve recording, verification reads, drift-reported sets, and wipes scope to the session's own rows. The session-start wipe is **removed entirely** (a fresh session has no own rows; a continued session keeps its rows — which is what fixes `pi -c`). GC for crashed sessions is a **TTL sweep on store open**; there is no shutdown delete (deleting at shutdown would break `pi -c` continuity). Undo and snapshots stay global — they have a different fact authority (file state, not session knowledge); see ADR-0002.

Session identity comes from `ctx.sessionManager.getSessionId()` — the same source pi's bash tool uses for `PI_SESSION_ID` — available on the `ExtensionContext` passed to every tool execute and every event handler (`session_start`, `tool_result`). It is **never** read from `process.env.PI_SESSION_ID`: verified unreliable — a nested pi process inherits the parent's value via the bash spawn env, so the extension would self-identify as the wrong session.

## User Stories

1. As the main model with sub-agents running, I want a sub-agent's session start to never wipe the served rows my edits verify against, so that my anchors keep working after a sub-agent ran.
2. As a model continuing a session with `pi -c`, I want the served rows from the previous process to survive the restart, so that I can edit ranges I read before the restart without an `[E_RANGE_UNVERIFIED]` roundtrip.
3. As a model in a fresh session, I want my served state to start empty and never include another session's serves, so that I never edit blind on lines shown to a different session's context.
4. As a model, I want the drift-notice "once per episode" rule to be per-session, so that a new session's context receives its own notice for a drift it has not been told about.
5. As a model using `undo_last_edit`, I want undo to keep its file-global semantics and its `[E_UNDO_STALE]` guard unchanged, so that "revert the last edit to this file" still works and refuses when the file moved on.
6. As a developer, I want session identity captured from the tool/event context, never from `process.env`, so that nested pi processes cannot misidentify themselves.
7. As a test maintainer, I want the isolation rules testable at the store seam with literal session keys, so that no fake-pi harness is needed to prove two sessions do not interfere.
8. As a maintainer, I want the version bump to rebuild the served table cleanly, so that the migration path is the existing gate rather than a bespoke ALTER.

## Implementation Decisions

- **Schema**: `served(session_id TEXT NOT NULL, path TEXT NOT NULL, hashes TEXT NOT NULL, reported TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path))`. Bump `HASH_STORE_VERSION`; the existing version gate already rebuilds `snapshots`/`undo`/`served` on upgrade (served is a recoverable cache — a clean rebuild is acceptable).
- **Statements** (`hash-store.ts`): `servedGet(session, path)`, `servedUpsert(session, path, hashes, updated_at)`, `servedReportedUpsert(session, path, '[]', reported, updated_at)`, `servedReportedClear(session, updated_at, path)`, `servedDelete(session, path)`, `servedWipe(session)` → `DELETE FROM served WHERE session_id = ?`, plus `servedPruneOlderThan(cutoff)` for the TTL sweep. `allStmt` (used by `pruneMissingAll`) still selects `path` — unchanged; missing-file pruning stays global (file-derived, true for every session).
- **Session identity**: a small helper — `sessionKeyFor(ctx)` → `ctx.sessionManager?.getSessionId() ?? crypto.randomUUID()` — called at the top of every served-state call site that has a context. The UUID fallback is defensive only (unreachable in practice: every handler and tool execute receives a session-bearing context).
- **Facade** (`served-store.ts`): every function takes an explicit `sessionKey` first parameter — `getServed(session, path)`, `upsertServed(session, path, entries)`, `recordServes(session, path, rows)`, `getReported(session, path)`, `addReported(session, path, hashes)`, `clearReported(session, path)`, `deleteServed(session, path)`, `wipeServed(session)`, and the async facades `loadServed(session, path)`, `recordServed(session, path, rows)`, `driftReported(session, path)`, `markDriftReported(session, path, hashes)`, `clearDriftReported(session, path)`, `wipeServedState(session)`. Explicit params keep the seam pure and unit-testable with literal keys.
- **Call sites**: `index.ts` `session_start` drops `wipeServedState()` (keeps `pruneMissingAll`); `index.ts` `tool_result` (write auto-read, edit diff) passes `sessionKeyFor(ctx)`; `read.ts` passes it to `recordServed`/`clearDriftReported`; `edit.ts` passes it to `loadServed` and threads it into `recordEchoServes` (via `hashline/served.ts`); `drift.ts` passes it to `driftReported`/`recordServed`/`markDriftReported`. `hashline/served.ts` `recordEchoServes(session, path, rows)`.
- **GC**: `SERVED_TTL_MS` constant (7 days) + sweep `DELETE FROM served WHERE updated_at < ?` in `openStore`, busy-retried. No `session_shutdown` delete — that would erase the rows a `pi -c` continuation depends on. Trade-off accepted: dead sessions' rows linger up to TTL; rows are small and bounded by files read.
- **Observable behavior unchanged within one session**: same reject codes, echo rows, drift notices, auto-read diffs. The suite and eval battery are the proof.

## Non-Goals

- Undo and snapshot stores stay global (ADR-0002).
- Cross-session visibility (a session intentionally reading another's serves) is out of scope; isolation is complete.
- Worktree isolation for sub-agents is out of scope for this change (separate paths already separate undo rows naturally).
