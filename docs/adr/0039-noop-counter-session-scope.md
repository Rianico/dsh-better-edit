# ADR-0039 — The noop-loop counter is scoped by `(session, file)`

Status: Accepted (ticket arch-T7, lane `arch-impl-candidates`).
Related: [ADR-0013](0013-pos-free-roundtrip-optimization.md) §1 — the served epoch is already
`per (session,path)`; [ADR-0014](0014-user-model-audience.md) §Amendment (#116) — `W_NOOP` is
`MODEL`-routed, the audience this counter's tiers feed.
Downstream records: `src/noop-guard.ts` (`trackNoopPayload`, `clearNoopLoop`, `trackerKey`),
`src/mutation/engine.ts` (`runFileEdits`), `src/domain-errors.ts` (`noopLoopFormat`).

## Context

`noopLoopTracker` was a `Map<absolutePath, {payload, count}>`. The file was the whole identity, so
the loop counter was process-global across sessions: session A's repeats advanced the count that
session B read on its _first_ submission of the same unchanged edit. At `NOOP_LOOP_THRESHOLD` (3)
that first submission is refused — B is rejected for a loop it never ran.

Measured on the pre-fix tree (`trackNoopPayload`, session-A ×2 then session-B, same file, same
payload): `session-A=1, session-A=2, session-B=3` — B is already at the threshold.

The loop a refusal describes is "this session keeps resubmitting this edit" — the same per-session
reasoning ADR-0013 §1 gives for the served epoch, where a per-file epoch would let one agent's
`read` clear another's hazard. The file already sat in the payload, so the identity was incomplete.

## Decision

**The counter identity is `(sessionKey, absolutePath)`.** `trackerKey` renders it as
`JSON.stringify([sessionKey, absolutePath])`; `noopLoopTracker` is keyed by that string, and
`trackNoopPayload(sessionKey, absolutePath, payload)` / `clearNoopLoop(sessionKey, absolutePath)`
take it. Both call sites live in `runFileEdits`, where `opts.sessionKey` was already in scope.

The key is an **identity, not a second copy of the payload**: `noopPayloadKey` already carries the
path first, so the entry's `payload` equality check is scoped by the same file the key names.

Nothing else in the noop flow changes — count semantics, the `2`-warn / `3`-reject tiers, the
message text and the `MODEL` audience stay byte-identical (ADR-0014). `runNoopPolicy`,
`runNoopPolicySync`, `NoopPolicyInput` and `NoopPolicyOutcome` are deleted: dead copies of the live
`enforceNoopLoop` decision with zero `src/` callers.

## Consequences

- One counter per `(session, file)`: a session's repeats can no longer reject another session's
  first submission. Pinned by `test/core/coverage-agent-a-noop-guard.test.ts` (`noop-loop counter is
scoped by session`), which asserts both the counter values and `enforceNoopLoop`'s decision.
- `clearNoopLoop` clears one session's entry only — the applied branch's retirement no longer resets
  a peer session's loop state, and a peer's count continues from its own value.
- The tracker stays in-process and unbounded, as before: entries are `(session, file)`-small, cleared on
  a successful apply, and never persisted, so a restart forgives an abandoned loop.
- With the dead copy gone, the only `E_NOOP_LOOP` producer is `enforceNoopLoop`, which always passes
  `batch: true`; the payload's declared-only `path?: string` field and its formatter arm were
  unreachable and are deleted with the type field.
