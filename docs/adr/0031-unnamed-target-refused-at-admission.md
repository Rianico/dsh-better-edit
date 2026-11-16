# ADR-0031 — An unnamed target is refused at admission, never inferred from the hash store

Status: Accepted (fix for [#117](https://github.com/Rianico/dsh-better-edit/issues/117), lane `i117`).
Upstream referents: `pi-better-edit@efd7f25` (2026-08-09) added "resolve missing path from anchors";
`pi-better-edit@3b22008` (2026-09-20, #148) retired it in its
`docs/adr/0021-unified-error-and-warning-contract.md`: `resolveMissingPath` "is retired together with
the file-specific message, and `NormalizedEditRequest.file` narrows to `string`", on Keel Principle 4
— naming the target belongs to the caller, not the tool.
Downstream records: `src/contract.ts` (`editRequestFrom`, `assertEditRequest`, `EditRequest.file`),
`src/tool-edit.ts` (`resolveNullPath` deleted), `src/mutation/engine.ts` (`resolveMissingPath`
deleted), [ADR-0003](0003-merged-edit-payload-hoisted-path.md) §Amendment (2026-11-16),
`test/tools/edit-null-file-rejection.test.ts` (the pins).

## Context

The hoisted-path payload kept a legacy `null` file admissible and resolved it from the snapshot
store: the only file whose stored hashes contain both anchors. This repository reintroduced that
behaviour in `9c660d8` (`resolveNullPath` in `tool-edit`, `resolveMissingPath` in the mutation
engine), and issue #117 reports the consequence — `edit` with `file: null` guesses a target file and
applies the mutation there.

The three arms before this record, measured on the tree at `5717cd5`:

| anchors           | outcome                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| one matching file | edit **applies** to that file; output carries `[TO MODEL] [E_BAD_PAYLOAD] Autocorrected: …` |
| several files     | `E_BAD_PAYLOAD` ("the anchors match multiple known files")                                  |
| none              | `E_BAD_PAYLOAD` ("could not be inferred from anchors")                                      |

Only the ambiguity arm fails closed. The single-match arm writes to a file the caller never named,
and its "Autocorrected" line is an `E_*` header attached to a successful mutation — the warning and
error tiers say the opposite thing about the same call.

## Decision

1. **An unnamed target is an admission error.** `editRequestFrom` folds a `null` or absent
   `file` (including the `path` / `file_path` alias spellings) to `undefined`, so `assertEditRequest`
   refuses with `E_BAD_PAYLOAD` before any IO: "Edit request file must be a non-empty string; name
   the file to edit." `EditRequest.file` narrows to `string`.
2. **Delete both inference seams.** `resolveNullPath` (`src/tool-edit.ts`) and `resolveMissingPath`
   (`src/mutation/engine.ts`) go with their `findSnapshotPathsByHashes` / `parseHashRef` imports.
   `PreparedItem.fileWarning` is removed together with its `warnings.unshift` carrier — the slot
   had no other producer.
3. **The wire schema keeps the undocumented `null` branch.** Dropping it made dsh's argument
   validation answer `ToolArgsError INVALID_ARGS` before the contract ran, so the domain would not
   own the rejection code. `null` stays admissible and untaught — the same admit-but-not-teach
   posture as before — but nothing resolves it. The runtime refusal is ours, and it is
   `E_BAD_PAYLOAD`.
4. **Legacy _name_ folds stay.** `path` / `file_path` → `file` and legacy tuple items remain
   pre-validation conveniences; they are spellings of the caller's intent, not guesses about it.
   Only the null/inference arm is retired.

## Rejected alternatives

- **Warn and keep inferring (`W_FILE_INFERRED`).** A `W_*` line reports an _applied_ mutation;
  emitting one here would institutionalise exactly the harm #117 reports — a silent wrong-file
  write with a notice attached. Once the guess is gone there is nothing left to warn about.
  Rejected by ruling.
- **Keep inference behind a confirmation step.** The tool contract has no confirmation channel, and
  "the only file whose stored hashes contain both anchors" is not evidence of intent: a duplicated
  snippet or a stale snapshot makes the match coincide, not correct.
- **Scope the guess to a workspace root.** Shrinks the blast radius but keeps the write outside the
  caller's naming; the wrong-file class survives.

## Consequences

- An `edit` that names no file now costs one round trip — the refusal states the obligation — where
  a lucky single match used to succeed. That is the intended trade: a wrong-file write is
  irreversible for the user, a retry is cheap.
- Hooks that fire before validation still see `file: null`, because the wire schema admits it; they
  must tolerate a non-string path, but may no longer assume it resolves. ADR-0003's Consequences
  line is amended rather than rewritten.
- No new warning code, no new error code, no payload-shape change beyond the retired interpretation.
  The `E_BAD_PAYLOAD` vocabulary and `[TO MODEL]` audience are unchanged.
- `README.md`'s tools table no longer advertises `path: string | null` inference.

## Evidence

- `rg -n 'resolveNullPath|resolveMissingPath|resolveOne|Autocorrected' src/` → no matches (at `baa3076`).
- `rg -n 'warning: formatError' src/` and `rg -n '"null infers|infers it from anchors' src/` → no matches.
- `test/tools/edit-null-file-rejection.test.ts` — `file: null`, `path: null`, `file_path: null`
  reject `E_BAD_PAYLOAD` and leave the matching file byte-identical; the named-alias folds and the
  no-`[E_` success pin stay green.
- `test/core/coverage-agent-b-tool-edit.test.ts` — the rewritten null-path cells reject with no
  inference wording; `test/core/coverage-agent-c-contract.test.ts` and `path-sanitize.test.ts` pin
  the fold returning `undefined`; `test/core/edit-payload-fold.test.ts` pins the still-admissible,
  still-undescribed wire `null` branch.
- `pnpm run typecheck` and `pnpm test` — green: `Test Files 167 passed (167)`,
  `Tests 1728 passed (1728)`.

## References

- [ADR-0003](0003-merged-edit-payload-hoisted-path.md) — hoisted path payload; §Amendment (2026-11-16)
  retires the "tolerate `null` paths (anchor inference)" parenthetical.
- `pi-better-edit@efd7f25` — inference added and first released in `v1.0.0`.
- `pi-better-edit@3b22008` (upstream ADR-0021, #148) — inference retired, `file` narrowed to `string`.
- `9c660d8` — downstream reintroduction of `resolveNullPath` / `resolveMissingPath`.
- [#117](https://github.com/Rianico/dsh-better-edit/issues/117) — the defect report this record closes.
