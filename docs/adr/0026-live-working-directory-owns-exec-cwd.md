# ADR-0026 — The live working directory owns the execution cwd

Status: Accepted (issue #82 — dsh `0.2.1-rc.2` alignment).
Lane: `feat/dsh-020`, with the dependency baseline `@deepseek-ai/dsh-*@0.2.1-rc.2`.

## Context

Before dsh `0.2.1`, a session's directory was a single immutable fact: the session
header (`exec.agent.session.header.cwd`). `execCwd` read it, and every hashline
tool used it to resolve relative paths and to key the per-workspace store.

`0.2.1` splits that fact in two:

- `@deepseek-ai/dsh-working-directory` owns the session's **effective** directory
  (host service `workingDirectory`, a session projection). The shipped
  `working_directory` tool can move a live session; the movement is committed as
  a session event and survives replay.
- The session header keeps only the directory the session was **created** in —
  the original project, not the operation target.

The built-in fs tools already follow the new seam
(`ctx.workingDirectory.ensure(exec.agent, signal)` before resolving a path), so
leaving `execCwd` on the header would make a `cd` split the plugin from the
built-ins: `read`/`edit` would resolve against the original project and write the
original project's store while the built-in `read` and `write` operated in the
new directory.

Considered options:

1. **Keep the immutable header** — rejected: the wrong file after a directory
   move, and a store identity that disagrees with the model's reported cwd.
2. **`workingDirectory.ensure(agent, signal)`** — the built-ins' call; validates
   the directory and may commit a recovery. Rejected for this seam because it is
   asynchronous while `execCwd` is synchronous and read by every tool entrypoint
   before any I/O; threading a promise through ten call sites would make the
   context module own an I/O decision it does not need.
3. **`workingDirectory.get(session)`** — a total, synchronous, no-I/O read of the
   committed projection. Chosen.
4. **Boot-time version gate** — rejected: the plugin deliberately declares no
   peer range and does no runtime version probing; compatibility rides the stable
   surface plus optional-service fallbacks.

## Decision

`execCwd(exec)` reads the effective directory from the agent's own scope —
`agent.ctx.get('workingDirectory')`, typed structurally — and calls its
`get(session)`. When the service is absent (a pre-`0.2.1` deployment, or a lean
composition that mounts no working-directory row) the header remains the
fallback, then `process.cwd()` for an agent-less call. The service is never
injected: a missing service is a supported composition, not a broken one.

Relative-path resolution, the per-workspace store key, and the sandbox policy
root therefore all follow the live directory.

## Consequences

- A session that changes directory keeps one canonical store per directory,
  matching the built-ins' path resolution and the model-visible
  "Current working directory" context.
- The preference is read per call; there is no cache to invalidate on a move.
- `ensure()`'s recovery-from-a-deleted-directory is intentionally not
  replicated: a vanished cwd surfaces as the ordinary path error
  (`FS_NOT_FOUND`), and prompt assembly (which validates the directory before
  every turn) remains the recovery path. This trades recovery for a synchronous
  seam, and the failure is loud rather than silently redirected.
- Compositions without the service keep the pre-`0.2.1` behaviour byte for byte,
  so the upgrade adds no hard runtime dependency.
- The header stays the creation-time fact — tests and diagnostics that need the
  original project must keep reading it directly, not through `execCwd`.
