# ADR-0049 — dry_run previews an edit without writing

Date: 2026-11-25

## Status

accepted

Upstream referent: `pi-better-edit@56047a30` — _feat(edit): support dry_run preview in edit payload and engine (#346)_ — one upstream commit split downstream across #183 (admission), #184 (execution) and #185 (disclosure); it lies outside the absorption cursor `0b1934c`, and this record states the downstream decision only.

Downstream records: `src/contract.ts` (`dryRunSchema`, the root/`edits` fold gates), `src/tool-edit.ts` (parameter, write-policy skip), `src/mutation.ts` (the `dryRun` gate on the commit steps), `src/mutation/engine.ts` (the withheld store writes and noop-tally gates), `src/edit-diff.ts` (blank added gutter, no served rows), `src/edit-response.ts` (`buildBatchResult` header, `details.dryRun`, `servedByPath` suppression), `src/prompts.ts` (guidance bullet), `test/tools/edit.dry-run.test.ts`, `test/integration/dry-run-verification.test.ts`.

## Context

A multi-range edit is atomic: one bad anchor refuses the whole batch. Without a preview the model must commit in order to learn whether a complex or high-value change resolves. That is a poor trade for the caller, so the question was whether to publish a rehearsal.

A preview that silently writes, that mints addressable anchors from bytes that never landed, or that consumes the noop-loop tally is worse than no preview. It would teach the model to trust a serve that cannot be honoured, or arm a refusal the live call never earned. The feature is therefore defined at the trust boundary: a preview must be indistinguishable from the live call's validation and rendering, and distinguishable from every commit effect.

## Decision

- `dry_run` is an optional boolean-or-null root key. Absent or null folds to `false`; `true` and `false` pass through; a non-boolean fails closed as `E_BAD_PAYLOAD`.
- A preview runs the same admission, anchor/lease verification and rendering as the live path, and withholds every commit effect: no byte write, no undo row, no anchor retirement, no EOL notice, no result-anchor snapshot, no served rows or leases, and no noop-tally advance or clear.
- Added rows render the blank gutter, so no anchor is printed for a row that never landed; context rows keep the anchors the session already holds.
- The response leads with `[DRY RUN]` and "would be applied" wording and sets `details.dryRun`, while metrics keep the applied/noop vocabulary because it names the outcome the bytes would have had. `details.dryRun` is the structured marker; on the downstream tool surface the result content is the string, so the flag is for programmatic callers and presenters, not the model.
- A preview resolves no write policy, so it never asks for a permission it cannot use.

## Consequences

- Hypothetical-result rows are never recorded. A refusal's reject-and-serve rows still are (ADR-0043): they describe the current file, and the refusal text stays byte-identical to the live refusal.
- Anchor-space exhaustion still clears retired anchors during a preview. The clear is what lets the allocation succeed at all, so parity wins over purity; the path is unreachable below `62^ANCHOR_LEN` lines.
- The `[W_EOL_REWRITTEN]` notice stays live-only (ADR-0047 scopes it to a write that landed, and its "Undo restores normalized content" clause is false for a preview). A preview therefore under-reports a terminator rewrite the live call would perform — the engine still computes the warning and the preview leaves it unsaid — so the silence is a recorded cost, not an oversight. The integration case pins both halves in one file.
- Downstream has no **edit-path** `noPersist`/preview route — ADR-0019 deleted it — so this is a new branch on the commit steps, not a restoration. The name does survive in `src/file-view.ts`: `normFromText` takes a `noPersist` that withholds hash-store persistence during a read-side hash assignment, so it is not a preview route for an edit.
- Regression coverage: `test/tools/edit.dry-run.test.ts` covers admission, the no-write/no-serve/no-lineage seams, fail-closed parity, the drift scan and the noop tally; `test/integration/dry-run-verification.test.ts` drives the public tools for the header, the live-diff row match, stale refusal, the no-reservation property (the served mirror never moves), the tally, and the EOL silence.

## References

- Issue #145 (downstream): T1 #183 admission, T2 #184 execution, T3 #185 disclosure; upstream #346 / `56047a30`.
- [ADR-0019](0019-lease-identity-served-span-resolution.md) — the deleted `noPersist` route.
- [ADR-0043](0043-rejection-rows-are-a-fresh-read.md) — a refusal's rows are current-file rows.
- [ADR-0047](0047-eol-normalization-normalized-undo-and-the-eol-config.md) — the EOL notice is scoped to a write that landed.
