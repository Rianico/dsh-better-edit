# ADR-0030 — Post-write auto-read owns its fs observation (caller-owned emit)

Status: Accepted (issue #109, lane `i109`).
Downstream records: `src/write-hook.ts` (the `tools/post-execute` auto-read),
`src/read-and-serve.ts` (`readAndServe`'s emission-free contract),
`src/fs-bridge.ts` (`FileIO.emitObserved`, `ctxFsIO.emitObserved`), `src/tool-read.ts`
and `src/tool-str-replace-editor.ts` (the two pre-existing explicit emitters),
`test/core/fs-bridge.policy.test.ts` and `test/core/write-hook.hash-echo.test.ts`
(the pins).
Upstream: none — `pi-better-edit` has no `fs/*` observation gate, so this decision is
downstream-only and moves no sync cursor.

## Context

The deployment's filesystem layer gates mutations. Before a write, `ctx.fs` dispatches
`fs/write-intent`; an observation policy answers with a create-or-replace intent keyed
by session; the backend then rejects a replace whose version does not match what that
session observed (`FS_STALE_VERSION`) or a create over an existing file the session
never observed (`FS_NOT_OBSERVED`). A plugin path that shows the model fresh anchors
without recording an observation therefore hands the model a retry loop: the anchors
look usable, and the next edit dies in a gate the plugin never fed.

Five downstream paths hand the model anchors. The module invariant stated in
`src/fs-bridge.ts` — every successful read and mutation emits `fs/observed` — held for
four of them:

| path                                       | serves anchors        | writes through `ctxFsIO.writeText` | records an observation        |
| ------------------------------------------ | --------------------- | ---------------------------------- | ----------------------------- |
| `read` tool                                | yes                   | no                                 | yes — explicit `emitObserved` |
| `edit`                                     | yes (diff rows)       | yes                                | yes — `ctxFsIO.writeText`     |
| `undo_last_edit`                           | yes                   | yes                                | yes — `ctxFsIO.writeText`     |
| `str_replace_editor view`                  | no (observation only) | no                                 | yes — explicit `emitObserved` |
| post-write auto-read (`src/write-hook.ts`) | yes                   | no                                 | **no — the defect**           |

The auto-read is the only anchor-advertising path that performs no write, so it was the
only path the write seam's emit could not cover. It inherited the host `write`'s emit
instead — a host behaviour no contract guarantees, pinned to the write outcome's
version rather than to the version the auto-read re-read and rendered. Two symptom
pairs followed in the field:

1. On a host whose built-in `write` emits nothing, the next `edit` with an auto-read
   anchor failed `FS_NOT_OBSERVED` → `E_BLIND_REPLACE` ("has not been observed in this
   session") — a false statement about the session.
2. Where a formatter or watcher touched the file between the write and the auto-read,
   the recorded version was stale against the rows the model held →
   `FS_STALE_VERSION` → `E_STALE_RANGE`, with no writer visible to the model.

## Decision

1. **The observation obligation is caller-owned.** `readAndServe` stays emission-free;
   every caller that advertises its rows as anchors owns its own `emitObserved` call
   with its own `ToolExecution`. The write hook now emits immediately after
   `readAndServe` returns, inside its existing fail-open `try/catch`, mirroring the
   `read` tool.
2. **Shape A (hook-only) over Shape B (seam-owned emit).** Threading `exec` into
   `readAndServe` would make the invariant a property of the seam rather than of caller
   discipline, but an optional `exec` gives no static guarantee (a third caller can
   still forget), and a required `exec` couples a pure render-and-serve seam to the
   agent execution context and churns roughly twenty test call sites. The hook-only fix
   has zero interface churn and mirrors two existing emit sites; the residual risk (a
   future third anchor-advertising caller forgets) is accepted and pinned by the tests
   named above.
3. **The extra `stat` is an accepted cost.** `ctxFsIO.readText` does stat on the happy
   path: its BOM-restore step stats for the version that feeds the encoding memo. But
   `FileIO.readText` returns `Promise<string>` and discards that version, and returning
   it would break the `FileIO` contract while still leaving `emitObserved` needing its
   own `fs.resolve` to obtain an `FsTarget`. The two-RPC read+stat pair is the pattern
   already accepted for the `read` tool and `str_replace_editor view` (report #10), so
   the hook pays one `resolve`+`stat` per successful write and no seam changes.
4. **Emit unconditionally.** Served rows, `SERVE_NOT_RECORDED_NOTE` downgrade rows and
   empty files all emit. Observation and anchor-usability are orthogonal gates:
   suppressing the emit because the serve-store write failed would relabel the next
   failure as "never observed" and hide the real cause (the serve fault). Emitting
   keeps the rejection vocabulary honest — the next edit then fails at anchor
   verification (`E_UNKNOWN_ANCHOR`/`E_STALE_RANGE`), which is what actually happened.
5. **Emit after the auto-read, never with the write outcome's version.** The recorded
   version must be the one that produced the rendered rows. Recording the write's
   version leaves the observation stale whenever anything touches the file in the
   window, and a `tools/post-execute` listener is not handed the write outcome's
   version anyway.

## Consequences

- Every anchor-advertising path now records its own observation; the `fs-bridge`
  invariant holds of all five.
- A write can never fail because of the emit: `ctxFsIO.emitObserved` swallows and logs
  its own faults, `localIO.emitObserved` is a no-op, and the hook's emit sits inside
  the auto-read's `try/catch` — a fault costs the auto-read block and a `logger.warn`,
  never the write decision.
- Anchor verification is untouched: hash, canon, lease and epoch checks stay the
  plugin's own gates. The fs gate only records observation, so emitting cannot
  authorise a stale write.
- Pins: the policy-simulator regression (write → no re-read → plugin `edit` with an
  auto-read anchor succeeds under an observed-version map that rejects unobserved and
  stale replaces), the direct emit-arity assertion, the empty-file case, the
  serve-downgrade case, and the emission-fault fail-open case.
- A future caller that advertises anchors must emit. A future seam change that moves
  the emit into `readAndServe` supersedes decision 1 and must state why the caller
  obligation is no longer the cheaper contract.
