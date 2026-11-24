# ADR-0044 — Windows smoke gate on CI

Date: 2026-11-22

## Status

accepted (reverses the absorbed upstream `2588a32` removal of the Windows matrix; additive to the Linux `verify` job)

## Context

CI verified one platform. The `verify` job runs on `ubuntu-latest` with Node 26 and covers lint, format, typecheck and the full coverage suite. The published plugin ships Windows support, and most users run Windows, so a Windows-only failure class reaches users without any CI signal.

That class is real, not hypothetical. On Windows an open `DatabaseSync` blocks `unlink`/`rename`, so a teardown that removes a temp directory before closing the hash store fails with `EBUSY` and then skips the environment restore. Two unchanged-suite checkouts of v1.2.6 produced ten `EBUSY` failures; #140 fixed the ordering and moved the restore into an inner `finally`. None of those failures is visible on Linux, where unlinking an open file succeeds.

Upstream records the same lesson from the other direction: `18e31b8` added a `windows-latest` matrix, `9937e18` was a fix that matrix found, and `2588a32` removed the matrix as "wasteful". Downstream deliberately does not adopt that removal; the absorbed commit keeps its recorded disposition, and this ADR records the divergence. One OS, one Node version and a contract subset keep the focused cost small while covering the majority platform.

## Decision

`.github/workflows/ci.yml` gains a `windows-smoke` job next to the untouched Linux `verify` job. The job:

- runs on `windows-latest`, pins Node `26` (from `.nvmrc`), installs with `pnpm install --frozen-lockfile`, and sets `timeout-minutes: 15`;
- isolates `HOME`, `USERPROFILE` and `DSH_HOME` into a per-job directory under `runner.temp`, because Windows `os.homedir()` and the suite read different variables, and a leaked mutated home contaminates later steps;
- runs one real contract subset:

| File                                         | Contract proved                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `test/core/encoding-roundtrip.test.ts`       | encoding write path, `E_ENCODING_UNWRITABLE`, and the #140 store-before-`rm` teardown with the unconditional home restore |
| `test/core/undo-anchor-restore.test.ts`      | `read → edit → undo` restores the pre-edit anchors and retirement                                                         |
| `test/core/str-replace-create-guard.test.ts` | `create` create-or-fail through `O_EXCL` / `createIfAbsent`                                                               |
| `test/core/read-and-serve.test.ts`           | hashline read and served rows                                                                                             |
| `test/core/edit-engine.e2e.test.ts`          | hashline write and post-write evidence                                                                                    |
| `test/core/vacuum.test.ts`                   | store cleanup and retention                                                                                               |
| `test/core/hash-store.test.ts`               | store open/close lifetime and persistence                                                                                 |
| `test/integration/eol-matrix.test.ts`        | EOL effective-ending matrix, incl. the `system` rung on Windows                                                           |

The command is exactly `pnpm vitest run <eight files>`. There is no blanket skip and no encoding, BOM/CRLF, create-guard or stale-denial exemption. Only a privilege Windows does not grant may be narrowly guarded; this subset needs none. A future symlink-dependent case must guard the creation attempt only.

## Consequences

- A Windows-only filesystem or resource-lifetime regression now fails a PR check before release. The failure class #140 fixed is in the subset, so the gate is not vacuous for the incident that motivated it.
- Linux remains the release gate. The Windows job does not run the supply-chain audit, the full coverage suite or the mutation ledgers; it is additive, and a red Windows job blocks merge without replacing `verify`.
- Cost is one Windows runner per PR push and one per `main` push, bounded by `timeout-minutes: 15`.
- The job can be too narrow. Reopen condition: if a Windows regression escapes the subset, add its file here; never silently drop the job. A cost re-rule is an operator decision, and the default remains coverage over savings.

## What this deliberately does not do

- It does not restore upstream's full `windows-latest` matrix over every Node version.
- It does not duplicate `verify` (lint, format, typecheck, coverage, `pnpm run audit`).
- It does not treat Windows as a release gate.

## References

- #140 — close the hash store before temp-dir removal in the encoding fixture.
- #146 — this gate.
- upstream `pi-better-edit@18e31b8` (added `windows-latest`), `9937e18` (fix found by it), `2588a32` (removed it; not adopted).
