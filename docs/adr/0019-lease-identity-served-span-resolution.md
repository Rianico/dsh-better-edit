# ADR-0019 — Lease-identity served-span resolution (obligation (c))

Date: 2026-09-24
Status: accepted; supersedes [ADR-0018](0018-exact-position-served-span-verification.md) in part
Related: `src/hashline/anchor-pipeline.ts` (`LeaseSpanSource`, `verifyRebasedSpan`,
`verifyServedRange`), `src/snapshot-store/lineage-store.ts` (`positionsByIdentity`, `commitSnapshot`),
`src/snapshot-store/pairing.ts`, `src/mutation/engine.ts` (`makeLeaseSource`, `runFileEdits`),
`src/mutation.ts` (`execute`, `applySequence`), [ADR-0013](0013-pos-free-roundtrip-optimization.md),
[ADR-0017](0017-content-addressed-line-identity.md),
[ADR-0018](0018-exact-position-served-span-verification.md)

## Context

RES-1: `verifyServedRange` accepted a served span when `strictPos === false`, so a served slot
silently re-bound onto a look-alike line. T3a closed the symptom by making the position check
unconditional ([ADR-0018](0018-exact-position-served-span-verification.md)), knowingly shipping the
option [ADR-0013](0013-pos-free-roundtrip-optimization.md)'s Considered Options had rejected ("strict
pos always") and accepting a re-read on exterior drift. T3c's binding obligation (c) was to make that
cost temporary **via lease/line identity only**.

## Decision

On the live edit path the served span is verified by **line identity**, not position: each served
row's anchor must hold a **live lease** whose `line_id` resolves, through the current buffer's
identity map (`positionsByIdentity`), to that row's rebased coordinate (`verifyRebasedSpan`). The
position check remains the fallback where no `LeaseSpanSource` exists.

Resolution is **read-only**: it never re-stamps a lease and never writes `retired_at`. This ADR pins
the **resolution boundary**, not the edit path — a _passing_ edit legitimately re-serves echo rows and
retires anchors, which is pre-existing T2b behaviour and was measured (measured on the real tool path: a
passing edit re-stamps every lease row and adds rows). A **rejecting** edit is now a no-op for served
state: T3f removed the reject path's `recordEchoServes` write, so a rejection rethrows with the
current-range echo and records/grants nothing. Both edit-path effects come from `recordServedTruncated`
and the tombstone path, not from resolution.

- **Benign shift** — the intended line's content is unchanged, its position moved → resolves →
  applies. Pinned by `test/core/lease-resolve-seam.test.ts` ("applies a benign exterior insert above
  the served span", "applies a benign exterior delete above the served span") and by
  `tests/51-epoch-strict.test.ts` ("applies at the rebased coordinate after an exterior insert"),
  which asserts the exact resulting bytes.
- **Look-alike rebind** — the intended line was deleted and another line holds its bytes → its
  `line_id` is absent from the current lineage → reject `E_STALE_RANGE`, no write. Pinned by
  `test/core/deleted-twin-anchor.test.ts` (both the full-read and the windowed route; file
  byte-identical after the rejection).

The gate's arms, all `E_STALE_RANGE` with the echo rows/block and `reread: true`: window length
changed, an unleased served row, a retired lease, a coordinate no leased identity occupies, and — since
CP2-r2 — a null row inside the window (fail-closed; dsh does **not** adopt upstream ADR-0024's
interior-`null` tolerance). Pinned by `test/core/lease-resolve-seam.test.ts`
("verifyRebasedSpan — the gate's arms", 8 tests: the 6 rejection arms, the benign-accept arm and
the no-mirror-mutation arm).

**Why the seam is opt-in.** No `LeaseSpanSource` ⇒ the unconditional position check, byte-identical.
If the **seed** read throws — `identityPositions`, `src/mutation/engine.ts:620-630` — there is no
source and the position check stays. A **lease** read that throws inside the gate (`leaseFor`,
`src/hashline/anchor-pipeline.ts:662`) propagates and aborts the edit: fail-closed too, but it is not a
fallback to the position check. Preview (`noPersist`) carries no source by decision. Pinned by
`test/core/lease-resolve-seam.test.ts` ("is opt-in: without a
lease source the position check still rejects the shift", "keeps the position check when a preview
edit carries no lease source").

## The pairing engine was a prerequisite, and this was measured

On the two-rule FIFO pairing the deleted-twin contract fixture handed the surviving twin the
**deleted** line's `line_id`, so identity resolution on that rule would have re-bound the lease onto the
look-alike line — RES-1 under a new instrument. The patience/LIS engine instead leaves the deleted line
unpaired, so the lease retires. That engine-side half is pinned by `test/core/lineage-store.test.ts`
("the deleted twin does not inherit the deleted line's lineId (contract fixture)", which asserts the
absent id, the twin's own id, and the full id vector).

The FIFO half is a **historical observation, not tree-reproducible**. Its vectors — `[1,3,4,5,2,7]` for
the contract fixture, `[2,1]` for a bare swap, `[2]` for an ambiguous duplicate canon — have 0 hits in
the tree (`rg -n '\[1,3,4,5,2,7\]' test/ tests/ src/` → 0 hits), because the comparison was made by
reverting the `pairLineIds` adapter to the two-rule FIFO form and running the fixture; `5a0b495^` is
that pre-port adapter. To re-run it: restore that form and run the contract fixture. The engine's values
for the same three fixtures ARE committed — `[1,3,4,5,6,7]`, `[3,4]`, `[4]` — in
`test/core/lineage-store.test.ts`.

The engine is `src/snapshot-store/pairing.ts`, a verbatim port of upstream
`pi-better-edit@00f8c34 src/hashline/patience-pairing.ts` — `diff -u` against upstream reports only the
added `@module` tag. All **22** of its upstream oracles are ported verbatim to
`test/core/pairing.test.ts`, which holds **30** tests — those 22 plus **8 local-only**
additions (not upstream ports).

## Pairing consequences

Each is derived from the store-level oracles in `test/core/lineage-store.test.ts`; the derivation is
stated because the ADR claims the _consequence_, not the rule.

1. An ambiguous duplicate canon pairs **nothing** — the current line takes a fresh id (twin safety).
   Pinned by "duplicate canon pairs nothing — the current line takes a fresh id" (`[4]`; the FIFO rule
   would have produced `[2]`).
2. A **bare symmetric swap** (`alpha,beta → beta,alpha`) retires both identities — fresh `[3,4]`,
   where FIFO kept `[2,1]`. Pinned by "a bare symmetric swap retires both lines (no unique LCS
   embedding)". **Counterpoint, recorded deliberately:** strict twin safety needs only (1); (2) is
   accepted for upstream parity with the fail-closed direction, and it costs a re-read on that span.
   The alternative — a bespoke "unique-canon crossing = swap" rule — is rejected below.
3. A **duplicate exterior insert** leaves both occurrences unpaired (fail-closed). Pinned by "a
   duplicate exterior insert leaves the duplicated identity unpaired" (`[4,5,2,3]`).
4. Consequently, an edit that inserts a duplicate of a served line leaves that line's original
   identity unpaired in the committed lineage, so its lease retires and the next edit on it needs a
   re-read — the same shape as (1), reached through the edit path rather than through `commitSnapshot`
   directly.

For contrast, the routes that keep identity: "an unambiguous rotation keeps the moved lines'
identity, retires the displaced one" (`[4,1,2]`), "an exterior insert preserves every served line's
`lineId` at its shifted coordinate" (the full `[lineNumber, lineId]` mapping) — the latter is what
makes the benign-shift decision above reachable at all.

## Considered options (why rejected)

- **Keep the unconditional position check** — a permanent re-read tax on every exterior drift, which
  is the cost obligation (c) exists to remove.
- **Content-candidate search** (the [ADR-0004](0004-orphaned-serve-healing.md) heal) — that IS the
  rebind, and it was removed in T3a. A digest cannot separate two identical lines.
- **Tombstone + canon without identity** — a byte-identical twin shares the canon, so it cannot
  distinguish moved from replaced.
- **Upstream parity including its later interior-`null` tolerance** (upstream ADR-0024) — loosens a
  fail-closed rule beyond this task's mandate; dsh keeps its own interior-null rejection.
- **A bespoke "unique-canon crossing = swap" rule** to preserve reorder identity — a new heuristic, an
  upstream divergence, and the fail-closed direction is the one that protects against rebinds.

## Batch rebase — what was ported and what was declined

The live batch keeps an in-memory working-buffer identity map (`runFileEdits`): seeded from
`positionsByIdentity(originalNormalized)`, advanced by `spliceWorkingBufferIds` — lines outside the
replaced range keep their id, replacement lines become `null`. It is what lets later items in one
batch see earlier ones when a canon gets duplicated. Pinned by `test/core/batch-identity.test.ts`
(A1 control, the A2 duplicate-canon residual that rejected before the map, a batch that both grows and
shrinks before a third item).

`commit-from-map` is **declined** — a decision, and here is what it rests on: dsh's commit re-pairs
the final content against the latest snapshot, which is _more_ identity-preserving for a line inside a
replaced range that survived byte-identical (re-pairing inherits it; the map would assign `null` and
force a re-read on the next edit). The map's unique contribution is resolution-time determinism, so it
is resolution-only by design. The residual that remains: an item whose anchor targets a line an
earlier item **created** still rejects — fail-closed, pinned by `test/core/batch-identity.test.ts`
("an item targeting a line an earlier item created still rejects").

## Behaviour changes (T7 CHANGELOG inputs)

1. Exterior drift on a benign shift no longer forces a re-read — the obligation (c) UX delta.
2. A bare symmetric swap now requires a re-read (both identities retire) — pairing consequence (2).
3. An edit that inserts a duplicate of a served line requires a re-read on that line next time —
   pairing consequence (4).
4. A store whose `served` rows predate lease granting (pre-T2b) has no lease for those anchors, so its
   first edit after upgrade rejects and needs one re-read. Derived from the gate's unleased arm,
   pinned by `test/core/lease-resolve-seam.test.ts` ("rejects when the served row holds no lease").
5. Preview keeps the position check — a deliberate boundary, not an oversight: the seam is opt-in and
   `noPersist: true` has no production call site (`rg -n 'noPersist: true' src/` → 0 hits; the only
   occurrence in the tree is the boundary test itself).
6. A null row inside the served window now rejects `E_STALE_RANGE` fail-closed, where the gate previously
   skipped it. Pinned by `test/core/lease-resolve-seam.test.ts` ("fails closed on a null row inside the
   window").
7. A batch item whose anchor targets a line an **earlier item created** still rejects (`E_BATCH_ABORT`) —
   the residual the working-buffer identity map does not close. Pinned by
   `test/core/batch-identity.test.ts` ("an item targeting a line an earlier item created still
   rejects").

## Consequences

- `served_leases` is now load-bearing for correctness on the edit path; the serve path must grant
  leases (the T2b invariant).
- Resolution writes nothing, and every unresolvable identity fails closed. Pinned at runtime by
  `test/core/lease-resolve-seam.test.ts` ("resolution is read-only (runtime)", both outcomes), whose
  teeth were verified by injecting a write into `positionsByIdentity` and watching both go red.
- `currentSnapshotHash` was deliberately **not** introduced: the gate runs unconditionally, so
  upstream's `isUniformLeaseFastPath` predicate has no analogue here
  (`rg -n 'currentSnapshotHash' src/ test/ tests/` → 0 hits).
- The position check stays, as the fallback and as the instrument for every route that carries no
  lease source — identity replaces it, it does not disappear.
