# ADR-0020 — Atomic store pairs and terminating repair for a corrupt lineage

Date: 2026-09-24
Status: accepted
Related: `src/snapshot-store/txn.ts` (`withTransaction`), `src/hash-store.ts` (`withStore`,
`upsertSnapshot`, `deleteUndoPair`, `upsertSnapshotFor`), `src/tool-undo.ts` (`undo_last_edit`),
`src/undo-edit.ts` (`clearUndo`), `src/snapshot-store/lineage-store.ts` (`commitSnapshot`,
`diagnoseUnusableLineage`, `retireAbsentLeases`, `deleteByPath`), `src/session-view.ts`
(`grantServeLeases`, `recordServed`, `recordServedTruncated`), `src/domain-errors.ts`
(`E_UNDO_NOT_RECORDED`), [ADR-0017](0017-content-addressed-line-identity.md),
[ADR-0019](0019-lease-identity-served-span-resolution.md)

## Context

The invariant this checkpoint exists to pin, verbatim:

> A store mutation that spans more than one row must be atomic, or leave a state the next operation
> can recover from. It must never leave a state that a normal sequence of operations cannot escape.

T3b found two live violations, one per arm of that sentence.

**CP1 (first arm — atomicity).** `undo_last_edit`'s restore path commits two store rows after the file
write: the snapshot/lineage adopt (`upsertSnapshot`) and the undo-pair clear (`deleteUndoPair`). They
were two separate units, and a fault in the adopt was swallowed by a `console.error`-and-continue arm,
so the pair cleared while the adopt did not commit and the tool still reported success. The failure is
not exotic: `LineageCorruptError` reaching `grantServeLeases` is exactly such a fault, and CP2 shows it
was reachable.

**CP2 (second arm — terminating recovery).** A `file_snapshots` row whose `line_lineage` family is
unusable made `commitSnapshot`'s adopt arm throw for that content forever. `grantServeLeases` calls
`commitSnapshot` inside the `withStore` unit that wrote the `served` row, so the throw rolled the
served+lease unit back, `recordServed` swallowed it, and the read reported success while persisting
nothing. The result was a closed loop with no escape:
`read → edit → reject → read → edit → reject`.

Both are the same defect seen from two sides: a multi-row store mutation without a unit, and a store
state whose only exit is an operation that reproduces it.

## Decision

### CP1 — one transaction, not recorded intent

The snapshot adopt and the undo-pair clear are bound in **one** `withStore` unit
(`src/tool-undo.ts:161`).

The mechanism is the store's single re-entrant transaction owner. `withTransaction`
(`src/snapshot-store/txn.ts:47`) opens exactly one `BEGIN IMMEDIATE` per handle: a nested caller
(`db.isTransaction` true) runs `fn` directly and joins the outer unit, and only the outermost owner
commits or rolls back. Its own doc states the policy this decision leans on — _"Inner callers never
swallow the error — swallowing would let the outer COMMIT persist a half-written pair"_ — and it lists
the delegates: `hash-store`'s `withStore` / undo pair and `lineage-store`'s `commitSnapshot`.
`withStore` (`src/hash-store.ts:1220`) is the module-level convenience over that owner, and both
writers already route through it, so binding the pair needed no new owner, no second `BEGIN`, and no
new schema.

Two properties make this the whole answer rather than half of it:

- **The file write is outside any transaction either way.** `io.writeText` cannot be made atomic with
  the store, so the store pair is the only thing that can be. Recorded intent / compensable designs
  therefore buy nothing atomicity does not already give, and add a journal row, a healing path and a
  second state machine.
- **The pair is bound after the successful write**, so no write lock is held across the file write.

**Counterexample.** `test/core/undo-atomicity.test.ts` ("holds both pair writes down: the serve path
cannot mask the split") faults both writers deterministically and measures the end state in one object.
On the pre-fix tree: `toolClaimedSuccess: true`, `faultCode: undefined`, `undoPairPresent: false`,
`advertisedAnchorsServed: false`, `followUpEdit: "rejected"`. The tool reported success; the pair was
cleared; the adopt did not commit; and the anchors the tool had just advertised — its message says
"the post-edit diff rows carry the restored file's fresh anchors for follow-up edits" — were never
served, so a model that trusts them is stuck. On the fixed tree: `toolClaimedSuccess: false`,
`faultCode: "E_UNDO_NOT_RECORDED"`, `undoPairPresent: true`, `followUpEdit:
"not-attempted:tool-faulted"`, `nextOperation: "applied"`.

**The mutation that kills the fix.** Removing the `withStore` binding (unbinding the two calls) makes
"rolls the snapshot adopt back when the undo-pair clear faults" fail with `adoptLanded: true` — the
adopt commits while the clear faults. The suite therefore proves the _unit_, not merely the removal of
the swallow; a variant that only deleted the swallow still fails that cell.

**Fault path (recoverable by construction).** A rollback leaves the file reverted (outside the unit),
the adopt unapplied and the pair retained. The terminating step is the next `undo_last_edit`: it finds
the file no longer equal to the recorded post-edit content, takes the pre-existing `E_UNDO_STALE`
branch, clears the pair and returns. Pinned by "after an adopt fault the next undo terminates the
retained pair".

**No silent swallow.** The arm is gone. A fault raises `E_UNDO_NOT_RECORDED`
(`src/domain-errors.ts:625`, MODEL audience per [ADR-0014](0014-user-model-audience.md)), whose
message states that the file was reverted, that the undo history is retained, and that the next
`undo_last_edit` clears it as stale. The raw cause is logged for diagnosis before the throw, so it is
not lost.

### The post-unit serve write (CP1 follow-up)

The pair stays one unit. After it commits, `undo_last_edit` records the restored rows' serve state in a
**second** unit (`recordServedTruncated`), which now **reports whether that write landed** instead of
swallowing the failure. The tool promises the diff rows' anchors only when it did; otherwise it warns
that the anchors were **not recorded as served**, that the diff rows are therefore not usable anchors,
and that the file must be re-read before editing.

The boundary is deliberate: the serve write stays **outside** the pair, so a serve fault cannot roll the
committed revert back. It **downgrades the claim**; it does not fail the undo. The cell pins that
directly — the pair is committed while the anchors the output shows are absent from the served set and a
follow-up edit using one is rejected.

This is the same invariant read from the other side: an operation may not advertise a capability it did
not acquire. The success path's message is unchanged, and a second cell pins it byte-for-byte.

**The invariant, named.** _No user-visible claim about served anchors may be emitted before a successful
serve write, and any tool that fails to serve must say so in its result rather than implying success._

T3d applies it to the two paths where it was still violated — measured, through the real tools:

- **`edit`** (`src/mutation.ts`) — `recordIfNeeded` discarded `recordServedTruncated`'s boolean, so under
  a post-commit serve fault the tool returned `Successfully edited 1 file(s) — …` with a diff advertising
  an anchor absent from `getAnchorReservations`, and the next edit on that anchor died with
  `E_UNSERVED_RANGE` (wrapped in `E_BATCH_ABORT`). Nothing was surfaced.
- **`read`** (`src/read-and-serve.ts` + `src/session-view.ts`) — `recordServed` swallowed its failure
  with `console.error` and returned `void`, so `readAndServe` returned the rows anyway. Under a serve fault
  a read returned rows with the served set **empty**, and the next edit using one died with
  `E_UNSERVED_RANGE`; `READ_GUIDANCE`/`EDIT_GUIDANCE` presented those rows as the anchors.

Both are **claim** defects, not atomicity defects. Now both recorders report whether the write landed and
both surfaces downgrade the claim: `edit` appends a notice naming the partial failure and the recovery,
`read` puts the same class of notice in its `text`. Neither operation fails — the edit stays committed
and the read still shows its rows — so the boundary rule holds unchanged: the serve write remains outside
the committed unit and cannot roll it back.

The notice goes in `text` rather than `warning` because `tool-read` renders both but `src/write-hook.ts`
renders `text` only; the boundary cell calls `readAndServe` directly, so a notice parked in `warning`
cannot pass. The guidance no longer promises anchors unconditionally: the edit and undo bullets and
`EDIT_DESCRIPTION` (783 → 794 chars, inside its 800-char bound) make the claim conditional on the result
not reporting the rows were not recorded.

### CP2 — repair at detection, not explicit repair with an actionable error

**What "corrupt" means, precisely.** A `file_snapshots` row exists for the adopted
`(path, snapshot_hash)` and its `line_lineage` family is unusable in one of four ways:

1. **empty** — zero rows for a snapshot that claims lines;
2. **wrong count** — rows ≠ `splitLines(content).length`;
3. **non-contiguous numbering** — a row's `line_number` ≠ index+1. Note the precision: this arm cannot
   fire from row _ordering_ (`snapshotLineageStmt` orders by `line_number ASC`); it fires from numbering
   that is not contiguous from 1, e.g. `11,12` for a 2-line file.
4. **canon mismatch** — a stored `canon_hash` ≠ `canonDigest(line)` for the line being adopted. The first
   three are structural; this is the only check on the identity the row carries, and without it a family
   with the right count and numbering but a garbage canon is adopted as healthy and its `line_id`s are
   inherited into every future pairing.

**Why the canon arm cannot be version skew.** `snapshotHashFor(content)` embeds `CANON_VERSION` in the
key it looks up (`${CANON_VERSION}:${contentChecksum(content)}`), so the adopt arm can only ever see rows
written by _this_ canon version — a canon change bumps the version, changes the key, and lands on a
different row through the insert path. `canonDigest` is pure for a given line: no clock, no reservations,
no store state. A mismatch inside the adopt arm therefore cannot be legitimate skew; it is corruption,
and excluding it would be a gap rather than a decision.

**How it is detected.** `diagnoseUnusableLineage` (`src/snapshot-store/lineage-store.ts:231`), called in
`commitSnapshot`'s adopt arm before anything is written. It returns a diagnosis (the empty / count /
order / canon arm) or `undefined` when the family can be adopted as-is.

**All four arms route into the same branch.** The canon arm is a fourth diagnosis, not a fourth repair:
the family is discarded by `snapshot_id` and re-materialized fresh in the caller's unit, with exactly the
properties below — so a canon-corrupt row is repaired on its next adoption rather than silently reused,
and `line_id_counters` are still not reset. The repair is **one-shot**: re-materialization leaves the
family canon-consistent, so the next and every later adoption takes the healthy adopt path — no
re-diagnosis, no re-materialization, no id churn — which `test/core/lineage-repair.test.ts`'s three-adopt
cell pins with one warning across three consecutive adopts, unchanged ids and stable row counts.

**The exact repair.** The adopt arm discards **that one** family by `snapshot_id` — `DELETE FROM
line_lineage WHERE snapshot_id = ?` then `DELETE FROM file_snapshots WHERE snapshot_id = ?` — and falls
through to the insert path, re-materializing fresh inside the caller's unit. Specifically:

- **siblings untouched** — no other `(path, snapshot_hash)` row is deleted, and the path's other
  snapshots stay available for pairing;
- **`line_id_counters` not reset** — fresh ids continue from the counter, so an id is never re-issued;
- **`retireAbsentLeases` closes the identity** (`:307`) — every lease still bound to a discarded
  `line_id` retires, so a stale anchor cannot rebind onto a fresh identity. Fail closed.

**Why the alternative lost.** Explicit repair with an actionable error needs an action that terminates.
None exists inside this task's constraints: the only whole-path deletion is `pruneMissing`, which
targets _missing_ files, and adding a repair affordance would change the tool payload contract, which
this checkpoint forbids (`src/contract.ts` untouched). Naming a non-terminating action recreates the
defect it was meant to fix. Its second half — surface every failed store write on the read path — would
fail reads on genuinely transient hiccups (locks, disk) _and_ leave the corrupt row in place, so the
next caller pays again. Repair at detection removes the failure at the writer that owns
`(path, snapshot_hash)`, and costs nothing on the healthy path.

**The corrected mechanism.** The loop's refusal is the **identity** arm — `E_STALE_RANGE`, "line 2 in
t.txt no longer resolves to the line identity it was served with. Re-read." — **not** the no-lease arm.
Measured: the earlier good read's leases _survive_ the `withStore` rollback (the rollback restores the
pre-fault served+lease state, it does not clear it), so `leaseFor` resolves; `positionsByIdentity` maps
that lease's `line_id` through the now-empty family to nothing, and the gate rejects. This matters
because the arm's `reread: true` hint is _actionable-looking and unactionable_ — re-reading reproduces
the refusal forever. After the repair the same hint is correct, because a re-read now repairs.

### The contract reversal

`commitSnapshot` no longer throws on an unusable stored lineage. It diagnoses, discards and
re-materializes. Four tests pinned the old contract and were **rewritten to a strictly stronger
post-state**, not deleted or weakened:

| file                              | title before                                                                       | title after                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `test/core/lineage-store.test.ts` | adopt with emptied lineage **throws instead of silently no-oping**                 | adopt with emptied lineage **repairs it instead of silently no-oping**             |
| `test/core/lineage-store.test.ts` | sparse stored lineage **throws instead of silently no-oping**                      | sparse stored lineage **repairs it instead of silently no-oping**                  |
| `test/core/hash-store.test.ts`    | partially-corrupt lineage **throws instead of serving a stale mix**                | partially-corrupt lineage **repairs instead of serving a stale mix**               |
| `test/core/hash-store.test.ts`    | adopt on an orphan snapshot row **throws; serve paths fail closed without repair** | adopt on an orphan snapshot row **repairs it; the serve path grants leases again** |

Each now asserts strictly more than "it throws": the lineage is re-materialized with the anchors just
adopted, the ids are proven fresh (no reuse of a corrupt id), the sibling snapshot count is proven
unchanged, the warning is asserted, and the serve path is proven to grant leases and persist the served
row. No test was deleted or skipped; the suite count rose (138 files / 1489 tests → 139 files / 1491
tests).

### `deleteByPath` atomicity

`deleteByPath` (`src/snapshot-store/lineage-store.ts:536`) ran four statement calls with no
transaction — and that was the _generator_ of the CP2 state: a fault between the first
(`DELETE FROM line_lineage …`) and the second (`DELETE FROM file_snapshots …`) leaves exactly the
empty-lineage row above. The four statements now run inside one `withTransaction`; nested inside
`pruneMissing`'s `withStore` unit it joins the outer transaction rather than raising
`cannot start a transaction within a transaction`.

**Generator proof.** `test/core/lineage-repair.test.ts` ("deleteByPath is one unit: an interrupted
delete cannot split the family") installs a deterministic fault _between_ the statements, through the
real `deleteByPath`:

```sql
CREATE TRIGGER block_snapshot_delete BEFORE DELETE ON file_snapshots
BEGIN SELECT RAISE(ABORT, 'injected: delete interrupted'); END
```

Pre-fix: `{faulted: true, snapshotRows: 1, lineageRows: 0}` — the split, i.e. the corrupt state
produced by the real generator. Post-fix: `{faulted: true, snapshotRows: 1, lineageRows: 3}` — the
fault rolls the whole delete back. A `vi.spyOn` around the call would not have shown this: the four
statements are local prepared statements inside `createLineageStore`, and the store face's
`deleteSnapshot` deletes a different table.

### Observability of the repair, and its limitation

The repair is observable via `console.warn` **only**: the warning carries the path, the snapshot hash
and the precise arm. It is asserted in tests (a `vi.spyOn` on `console.warn`), so it cannot silently
regress to a quiet repair.

`console.warn` is the deliberate channel, not an oversight: the repair must be observable, and the tests
assert the warning, so a `no-console-except-error` advisory on that call site is intentional and a later
scan should not read it as a live regression. Switching it to `console.error` would also break the
contract the tests pin.

A returned status would have to travel `commitSnapshot` → `grantServeLeases` →
`recordServed`/`recordServedTruncated` → the tool result, which is a payload change this checkpoint
forbids. **Trigger to revisit:** a read-result channel for store repairs existing — i.e. the tool result
gaining a non-payload warning channel. When that fires, the arm must become machine-readable (R5).

### `LineageCorruptError` shape

**Decision: keep it as the diagnosis value** — constructed, never thrown.

Why: its semantics are already "diagnosis", not "failure" — nothing failed, the adopt arm repairs — and
its doc comment says so. Its only consumer today is the warning's message; nothing consumes the _arm_
as a value yet, and the first consumer is precisely the read-result channel above. Renaming now would
also make this ADR describe a tree that does not exist, since this checkpoint is docs-only, and the
shape should be chosen against a real use rather than guessed. The cost is stated rather than hidden:
an `Error` subclass that is never thrown misleads a grep for "what throws"; the class doc comment is
the mitigation until R5.

## Considered options (why rejected)

- **CP1 recorded intent / compensable journal.** The file write is outside any transaction either way,
  so the store pair is the only thing that can be made atomic; a journal adds a second state machine
  and a healing path for a guarantee the re-entrant transaction already provides.
- **CP1 write the pair before the file write.** Holds a write lock across `io.writeText`, and a
  file-write fault would then leave the pair committed over an unreverted file — the same split,
  mirrored.
- **CP2 keep the throw, surface it, name a recovery action.** No terminating action exists to name
  without a payload change (see above), and the "surface every failed write" half fails reads on
  transient hiccups while leaving the row in place.
- **CP2 quarantine via `isCorruptionError`.** Would quarantine the whole store file, destroying every
  unrelated path's history to fix one logical inconsistency. The narrow action is the row-level repair.
- **CP2 repair scoped to the serve path only** (`grantServeLeases`) rather than the writer. Would leave
  the trap reachable from any direct `commitSnapshot` caller, and puts a repair in a _reader_ of the
  lineage instead of the writer that owns `(path, snapshot_hash)`.
- **CP2 reset `line_id_counters` for the repaired path.** Re-issues ids that a retired lease or a
  tombstone may still reference — exactly the rebind [ADR-0017](0017-content-addressed-line-identity.md)
  and [ADR-0019](0019-lease-identity-served-span-resolution.md) exist to prevent.
- **CP2 delete the path's siblings, or the whole path.** Destroys identity that is not corrupt; the
  repair is targeted at one unusable family by `snapshot_id`.

## Behaviour changes (T7 CHANGELOG inputs)

1. A failed undo-store write now raises `E_UNDO_NOT_RECORDED` instead of reporting a false success: the
   file stays reverted, the undo history is retained, and the next `undo_last_edit` clears it as stale.
2. A corrupt lineage now repairs (with a warning) instead of rejecting forever: a `read` that used to
   report success while persisting nothing now persists, and the following `edit` applies.
3. An undo whose post-unit serve write fails now downgrades its message — no anchor promise, and a
   re-read is required before editing — instead of reporting full success.
4. An edit whose post-unit serve write fails now downgrades its message — the edit stands, the result says
   the rows were NOT recorded as served, and a re-read is required before the next edit — instead of
   advertising the diff's anchors as usable.
5. A read whose serve write fails now says so in its returned text — the rows are still shown, but their
   anchors are not usable for editing until a re-read — instead of presenting them as usable anchors.

## Residuals (with triggers)

- **R1** — `clearUndo`'s internal swallow (`src/undo-edit.ts:123`, `console.error`-and-continue).
  Reached only on the two `E_UNDO_STALE` branches, where the tool returns a typed stale error anyway.
  Trigger: "no store failure is ever silent" becoming a standing rule, or the read-result channel below.
- **R2** — the serve-path swallows that remain **silent** about their outcome: the drift write
  (`src/session-view.ts:677`), the promotion/wipe arms (`src/read-and-serve.ts`, `clearRetiredAnchors` and
  `clearCards`; each documented in place as a deliberate local fallback), and `recordEchoServes`
  (`src/hashline/anchor-pipeline.ts:913`). `recordServed` and `recordServedTruncated` no longer belong
  here — they report whether the write landed, and the read and edit paths downgrade their claim when it
  did not. The remainder are no longer reachable from a _permanent_ condition: the only permanent store
  failure reachable from the read path was the unusable lineage, and `commitSnapshot` now repairs it
  instead of throwing. What remains is environmental (locks, disk), the cause is logged, and the read's
  best-effort policy is deliberate — a read must not fail because bookkeeping hiccuped. Trigger: "a read
  must fail closed on a store write" becoming a requirement, or the echo arm being audited (T4
  echo-guard hardening).
- **R3** — `upsertSnapshotFor` (`src/hash-store.ts:1238`) has no production caller since CP1's fix; the
  undo path uses the store face directly. Kept because it is an exported seam member
  (`src/store/index.ts`) consumed by `test/core/serve-leases.test.ts`. Trigger: the next seam-pruning
  round.
- **R4** — `retireAnchors` runs before the file write (`src/tool-undo.ts:136`), so a write fault leaves
  the anchors retired and the file unchanged. Measured escapable
  (`test/core/undo-atomicity.test.ts`, "a write fault retires anchors but leaves a state a read can
  escape": a re-read re-serves the unchanged file and its fresh anchors edit). Trigger: retirement
  becoming non-idempotent, or starting to gate re-serving.
- **R5** — `LineageCorruptError` is an `Error` subclass that is never thrown. Rename it to a plain
  diagnosis type carrying a machine-readable arm. Trigger: the read-result channel above firing.

## Consequences

- Every multi-row store write on these paths is either inside one `withTransaction` unit or explicitly
  recoverable; the store's transaction owner remains the only place a unit begins.
- A corrupt lineage row is no longer terminal: the writer that owns `(path, snapshot_hash)` repairs it,
  observably, and the identity of the discarded family is closed by lease retirement.
- The read path keeps its best-effort policy, but is no longer reachable from a permanent condition.
- The repair is observable through a warning only, and that limitation has a named trigger rather than
  a silent assumption.
- Two error surfaces moved: `E_UNDO_NOT_RECORDED` is new, and four tests that pinned the throw contract
  are reversed. No payload change; `src/contract.ts` is untouched.
- Pinned by `test/core/undo-atomicity.test.ts` (7 cells — the pair, the post-unit serve claim and its
  success-path twin), `test/core/lineage-repair.test.ts` (4 cells — the loop, `deleteByPath`'s four
  families on both the interrupted and the successful path, the canon arm, and the three-adopt cell that
  pins the repair's idempotence), and the four rewritten
  cells in `test/core/lineage-store.test.ts` and `test/core/hash-store.test.ts`.
