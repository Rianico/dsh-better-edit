# ADR-0034 — One authority restores the undo row when a write fails

Status: Accepted (ticket arch-T2, lane `arch-r1`).
Related: [ADR-0033](0033-retire-duplicate-name-shims.md) — the same lane's rule that a name with no
invariant of its own goes rather than gets a default; this record applies it to a flag.
[ADR-0027](0027-single-projection-collapse-contract.md) — the post-write retirement ordering this
record leaves untouched.
Downstream records: `src/mutation.ts` (`persistUndoAndWrite`, `execute`),
`test/core/coverage-agent-c-mutation-engine.test.ts` (the end-to-end pin and the seam pin),
`test/core/encoding-roundtrip.test.ts` (`E_ENCODING_UNWRITABLE` precedes every write).

## Context

`saveUndo` writes the undo row **before** the write. That ordering is what makes `undo_last_edit`
able to revert an edit at all, and it is also why the transaction already carried a restore-on-failure
loop for rows whose file was never written: a row describing content that is not on disk must not
outlive the failure that kept it off disk.

That loop was gated by `PersistWriteOptions.restoreUnwrittenUndos`, and the gate's value was decided
by the edit's **arity**, not by the failure. `execute` branched on `items.length === 1 &&
appliedCount + noopCount === 1` and forwarded to `commitSingle` (which passed the flag `true`) or
`commitBatch` (`false`) — two two-line wrappers that took a one-element option list and forwarded it.
Both branches commit exactly one file: `runFileEdits` returns a single `FileEditResult`, and
`files: [ … ]` was a one-element literal spelled out identically in both. So the same failure, on the
same single file, produced two different undo histories depending only on how many items the model
put in one call.

Symptom, measured on the pre-fix tree (`e6eb12b`) by the end-to-end cell
`keeps the previous edit's undo row when a multi-item write fails`: a two-item `edit` whose write
fails leaves the phantom row behind, and the next `undo_last_edit` returns

```
[TO MODEL] [E_UNDO_STALE] cannot undo on failed-batch-undo.txt: file modified after edit — undo would overwrite changes.
```

for a write **the tool itself had just failed** — blaming an external writer for the plugin's own
fault, while silently discarding the previous edit's undo.

## Decision

1. **The transaction is the one authority.** `persistUndoAndWrite` always restores the undo rows of
   the files it never wrote. The loop in the `catch` block is unconditional; it keeps its per-entry
   `try`/`console.error`, so a store fault during the restore is logged and the transaction still
   throws the mapped write error.
2. **The flag is deleted, not defaulted to `true`.** A flag with exactly one correct value is a
   defect waiting for its second caller: the arity gate above is precisely the caller that guessed
   wrong. Removing `restoreUnwrittenUndos` from `PersistWriteOptions` makes the wrong history
   unreachable rather than merely unused.
3. **`commitSingle` and `commitBatch` are deleted.** They carried no invariant beyond the flag —
   they were forwarding wrappers around `persistUndoAndWrite` with a one-element option list — so
   `execute` now calls the transaction directly in both branches. The one file literal both branches
   spelled is hoisted to a single `const commitFile`, passed as `files: [commitFile]`. The branches
   keep the message difference they own: the single branch renders
   `formatError("E_UNDO_UNAVAILABLE", { path })`, the batch branch adds `{ batch: true }`, and both
   keep `await retireFreedAnchors()` after the landed write.
4. **Single-item behaviour is unchanged, because it already restored.** The pre-fix single branch
   passed `true`; it now takes the same unconditional loop. No message, no ordering and no rollback
   path in that branch changes.

## Consequences

- A failed write leaves undo history equal to the pre-edit state, for both arities. `undo_last_edit`
  after a failed multi-item edit reverts the previous edit instead of reporting `E_UNDO_STALE`.
- The end-to-end pin is `keeps the previous edit's undo row when a multi-item write fails`
  (`test/core/coverage-agent-c-mutation-engine.test.ts`): it asserts no `E_UNDO_STALE` in the
  rendered undo and that the file returns to its pre-first-edit bytes — i.e. the pre-edit row was
  still the authority. The seam pin is the `r2` cell beside it,
  `restores the unwritten undo rows on a failed write (arity must not decide)`, which fails if the
  restore loop is ever gated again.
- **The restore stays best-effort.** Each unwritten row's `restore()` is wrapped in `try`/`catch`
  that logs and continues, so a _store_ fault during the restore can still leave the row behind
  while a _write_ fault cannot. That asymmetry is deliberate: the transaction's own failure is a
  write failure it can act on, and a store that cannot restore cannot be made to restore by
  throwing a second error over the first.
- The post-write retirement ordering from [ADR-0027](0027-single-projection-collapse-contract.md)
  (CAND-3, #98) is untouched: `retireFreedAnchors()` still runs only after the transaction returns,
  and a failed write still leaves freed anchors live.
- The thrown error is still `opts.sandbox.mapError(error, opts.sandboxPolicy)` — the restore loop
  runs before it and cannot replace it.
- The pre-write encoding verdict (`E_ENCODING_UNWRITABLE` decided for every file before any write,
  issue #112) is untouched; a refused round-trip still writes neither bytes nor undo rows.
- `rg -n 'restoreUnwrittenUndos|commitSingle|commitBatch' src test` → zero hits. One historical
  mention of the old flag survives in `CHANGELOG.md` under the released `[0.3.1]` section; that
  section is a record of what shipped, so it is not rewritten.

## References

- [ADR-0027](0027-single-projection-collapse-contract.md) — the single-projection collapse contract;
  its #98 post-write retirement ordering is preserved here.
- [ADR-0033](0033-retire-duplicate-name-shims.md) — "a name with no invariant of its own goes"; the
  flag and its two forwarders were exactly that.
- `docs/absorption-plan.md` §T3 CAND-3 — the review-track disposition that installed the
  retire-after-write ordering this transaction must keep while restoring.
