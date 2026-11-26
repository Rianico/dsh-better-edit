# ADR-0056 — Session-scoped, per-workspace store lifecycle

Date: 2026-11-26

## Status

accepted (amends the process-lifetime handle ownership left implicit by upstream `pi-better-edit` ADR-0005, the store-janitor two-root lifecycle; relates to [ADR-0016](0016-store-version-flap-guard.md))

## Context

`src/hash-store.ts` caches ONE sqlite handle per `storePath` in `stores` and opens it lazily on the first tool call in that workspace. Nothing in production ever closed it: `shutdownHashStore()` existed, but only tests called it, so a handle lived as long as the process did. That leaks in a way users see: on Windows an open handle blocks deleting the workspace store directory or the central `runtime/<name>-<hash8>/` cache, and the central janitor deliberately skips directories that a live handle still holds. A user who deletes a workspace cannot reclaim its cache until the host process exits.

Upstream `pi-better-edit#362` (its ADR-0020) tied store lifetime to agent lifetime instead of process lifetime. Downstream has no singleton store — one process serves many workspaces through `workingDirectory` — so the invariant cannot be taken as written. This record states the form it takes here.

## Decision

- **Per-path lifecycle slots.** `src/store-lifecycle-slot.ts` owns one `Slot` per `storePath`: the owner set, the in-flight counter and the single pending drain. A token→paths reverse index (`byToken`) lets one agent release every workspace it touched. The module is a leaf — it imports `node:async_hooks` and nothing else under `src/` — so `hash-store ↔ store-lifecycle` stays acyclic.
- **Attach is a lazy, idempotent claim.** The token is the agent id string (`exec.agent.id`), attached on every tool execution that resolves a store path: the `read`/`edit`/`undo_last_edit` bodies through `src/agent-store.ts`, and the preset `write` hook around its guard and its auto-read (`str_replace_editor` stays undecorated because its body never touches the store). An attach never opens a database; it only records the claim, and a claim that lifts the owner set off zero cancels a still-cancellable drain. It is idempotent, so the same agent re-attaches on every call without counting.
- **Detach is the one release point.** The agent's Cordis effect teardown calls `detachAgent(agent.id)` without awaiting it. Every path the token touched is detached before the first `await`, so the idle `1 → 0` close — checkpoint, `db.close()`, entry delete — runs synchronously inside the call; a path with work in flight finishes its drain at the end of the last scope instead.
- **The open path is scoped and reopen-aware.** `loadHashStore` waits a pending drain out, opens inside the path's `withStoreScope`, and `reopenIfDrained` re-opens when the opening scope was the one the drain was waiting on, so a resolved open is never mistaken for a live handle.
- **Close owns map deletion order.** A path's entry leaves `stores` only after a successful close, so the central janitor's live-directory set keeps shielding a draining directory. A throwing close keeps the entry — and `isOpen` — so the next release retries; a throw raised after the handle really closed drops the dead entry so no later shutdown re-visits it.
- **Host escape hatch and root teardown.** `releaseHashStore(cwd?, { force? })` closes one workspace or every open path. The all-paths form enumerates the open map itself because a bare open prunes its registry slot as its scope ends, leaving a held handle invisible to the registry. Root plugin disposal rides `ctx.effect` and force-releases everything, contained per path: one failing handle cannot strand the rest.
- **Persistence is untouched.** Closing deletes no snapshot, served row, lease or undo record. A resumed session's `undo_last_edit` restores across the closed handle on a cold reopen.
- **Releases are fenced per path.** A release that can actually close a path bumps that path's release epoch; a load that overlapped it fails loudly with `hash store: released while the store was opening` instead of reopening the handle the host asked to close. A refused path closes nothing and keeps its epoch, so no overlapping load is poisoned.

Downstream deviations from the referent:

- The multi-store map replaces upstream's singleton slot, and the in-flight marker is per slot, so a detach issued from inside A's scope still closes an idle B synchronously; only A's own drain wait rejects.
- String agent ids replace upstream's per-activation `Symbol`s, because one downstream agent must attach idempotently across many calls and detach once from a teardown that holds no symbol.
- The preset `write` hook takes the same seam as the named tools, so a guarded `write` keeps its workspace open exactly as an `edit` does.
- The store janitor is NOT absorbed: `onStoreOpen`/`onAppStart`/`onSessionStart` are intact and still own row TTL, `pruneMissing` and the central LRU, now reading the same live set this lifecycle feeds.
- There is no cut transaction and no `raw_pre` — this repo never absorbed the cut path.

## Consequences

- Store release is deterministic per agent: a workspace's handle closes when its last agent tears down, and a directory becomes deletable as soon as that close lands.
- A path shared by two agents — or one with a tool call still in flight — stays open, and deleting that directory stays blocked until the last claim's close. This is the designed limit, not a leak.
- Root disposal is fire-and-forget from the effect disposer: idle handles close synchronously, drains finish afterwards, and an unreleased path is reported as one warning rather than a failed unload.
- An overlapping load rejects with `hash store: released while the store was opening`. The host contract follows: force-release only when no new store calls will start.
- A close that fails while it ends a tool call's scope rejects that call — the registry's documented contract — and the entry stays retryable for the next release.
- The schema, the version boundary and the canon/generation constants are unchanged: this record moves WHO decides a close, never what a close writes.

## What this deliberately does not do

- It does not absorb the store janitor or upstream's two-root storage model; that stays outside the cursor.
- It does not give the store a process-wide "close everything on idle" policy: only an agent teardown, a host release, or plugin disposal closes a path.
- It does not make attachment a session concept: the token is the agent id, while served rows, leases and undo stay keyed by the session.
- It does not change `shutdownHashStore()`, the payload contract or the v6 shell shapes.
- It does not move the absorption cursor. `#362` is a targeted port, not a range absorb.

## References

- #152 — this change.
- upstream `pi-better-edit` ADR-0005 (`docs/adr/0005-store-janitor-two-root-lifecycle.md`) — the store-janitor lifecycle whose `session_shutdown` maintenance assumed a handle held for the life of the process; this record amends that ownership.
- [ADR-0016](0016-store-version-flap-guard.md) — the version boundary a close must not disturb: closing writes no migration and leaves the store stamp untouched.
- [README §Configuration](../../README.md#configuration) — the user-facing lifecycle, escape hatch and limits.
- `test/core/store-lifecycle-slot.test.ts`, `test/core/agent-store-lifecycle.test.ts`, `test/core/release-hash-store.test.ts`, `test/integration/store-lifecycle-e2e.test.ts` — the slot rules, the attach/detach seam, the host escape hatch and the undo-across-close claim.
