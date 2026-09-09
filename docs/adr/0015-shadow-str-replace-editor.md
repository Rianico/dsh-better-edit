# ADR-0015 — Shadow `str_replace_editor` on the Agent Layer

Date: 2026-09-08
Status: accepted
Related: ADR-0012 (VS Code encoding model), CONTEXT.md `File Encoding`
(`encoding governance`, `governed edit path`, `ungoverned edit path`)

## Context

Deployments compose the preset's built-in `str_replace_editor`
(`@deepseek-ai/dsh-tool-str-replace-editor`: `view` / `str_replace` /
`insert` / `create` / `undo_edit`) alongside this plugin's hashline
`read`/`edit`. The built-in is an **ungoverned edit path**: it reads and
writes through `ctx.fs` without `file encoding state`, so GBK/Big5/Shift-JIS
files are mojibaked or rejected as `FS_NOT_TEXT`, and UTF-8-BOM files lose
their BOM — silently, mid-task, after the model already saw content.

## Decision

Shadow the built-in at the **agent layer** (`src/index.ts`
`installAgentTools` via `agent.ctx.tools.register`, mirroring `read`/`edit`):
nearest-layer-wins routes the agent's `str_replace_editor` calls to
`src/tool-str-replace-editor.ts`, which keeps **contract parity** (same
commands, same params, no new `encoding` param; read-first invariant holds)
while enforcing **encoding governance**:

- `view` is observation: BOM → strict UTF-8 → `autoGuessEncoding` gate →
  Top-3 via `decodeForOpen`; records `file encoding state`, emits
  `fs/observed`, never records `served state`.
- `str_replace`/`insert` without prior `view`/`read` fail loud with
  `E_BLIND_REPLACE` — no disk write. Undecodable bytes fail loud with
  `E_UNSUPPORTED_FILE` + Top-3.
- `create` defaults to UTF-8 without BOM. `undo_edit` is out of scope →
  `E_UNSUPPORTED` (use `undo_last_edit`).

The self-heal watcher also covers the shadow: an external preset takeover of
`str_replace_editor` is restored like `read`/`edit`.

## Why hard to reverse

Shadowing replaces a built-in the model already knows. Rolling back changes
agent-visible behavior (BOM loss returns, GBK breaks again) and invalidates
the `E_BLIND_REPLACE` retry vocabulary the model learned. The shadow's
identity check in self-heal pins the exact def reference — a silent upstream
contract change (new command/param) would surface as drift, not compat.

## Why surprising

A tool named exactly like the built-in that rejects calls the built-in would
accept (blind `str_replace`, `undo_edit`). The surprise is deliberate and
loud (`E_BLIND_REPLACE` / `E_UNSUPPORTED` carry the retry instruction), never
a silent behavior change: every accepted call does what the built-in promises.

## Trade-off: agent layer vs upstream

- Agent-layer shadow (chosen): zero upstream coordination, per-agent unwind
  on dispose, preset guidance untouched. Cost: we own contract parity — every
  upstream command/param addition must be ported (see `tests/contract/`).
- Upstream fix (rejected for now): enriching `FS_NOT_TEXT` / teaching the
  built-in governance helps every consumer, but `dsh-fs` is `0.1.0-rc`
  (breaking changes allowed) and the harness team has not committed to the
  VS Code model. Proposed upstream as complementary (ADR-0012 references).

## Consequences

- `src/tool-str-replace-editor.ts` (new, isolated): reuses `ctxFsIO` +
  `file-encoding-state.ts` (`decodeForOpen` via `io.readText`,
  `recordOpenState`, `prepareForSave` via `io.writeText`,
  `invalidateIfStale`, `getEncodingState`).
- `src/index.ts` + `src/self-heal.ts`: register and watch the third shadow.
- Contract tests (`tests/tool-str-replace-editor.test.ts`,
  `tests/contract/str-replace-editor.test.ts`) pin parity: name, params, no
  `encoding` param, range slicing, `E_BLIND_REPLACE`, BOM round-trip.
