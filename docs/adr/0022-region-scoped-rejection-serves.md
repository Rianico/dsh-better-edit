# ADR-0022 — Region-scoped rejection serves on the existing edit surface

Date: 2026-09-25
Status: accepted
Related: `src/hashline/anchor-pipeline.ts` (`verifyServedRange`, `buildRangeEcho`,
`fmtMismatchWithServes`), `src/domain-errors.ts` (`E_STALE_RANGE`, `E_UNSERVED_RANGE`
formatters), `src/fs-bridge.ts` (the F7 version-guard arm), `CONTEXT.md`
(`reject-and-serve`, `target-lost rejection`), `test/arch/rejection-payload-region.test.ts`
(new), `test/arch/range-family-signal.test.ts`, `test/core/range-family-retry-truth.test.ts`,
upstream referent `pi-better-edit@00f8c34` ADR-0018 `region-scoped-rejection-serves`

## Context

`edit` rejects rather than miswrites: a submitted anchor whose served state no longer holds
produces a rejection whose payload _echoes rows_ — the model re-addresses from those rows
instead of spending a read. That echo is the operation this ADR constrains.

The upstream record (`pi-better-edit` ADR-0018, Decision) states the invariant:

> **"Invariant — a rejection payload carries rows only for the region the submitted anchors
> identify. A serve refreshes the model's inputs for that region and never substitutes another
> region for those anchors. When the region cannot be identified, the grounding is void and only
> a read restores it."**

_Region_ here means **the window the submitted anchors identify** — the served/rebased
coordinate window of the lease — **not** a read window. The rule is a property of the
**rejection payload on the edit path**; it is not parameterised by how many read windows exist.
T6b's `windows[]` API (see _Declared limit_) does not change it.

The local tree has no code-side statement of this rule. `src/hashline/anchor-pipeline.ts:161-224`
already satisfies the position half — `pushRow` dedupes and clamps, `buildRangeEcho:564-576`
clamps to `SERVED_ECHO_CAP`, and the range echo is derived from positions
(`buildRangeEcho(startLine, endLine, fileHashes)`), never from a content match: the local tree
has no `uniqueAnchorLine` (measured: `git grep -n 'uniqueAnchorLine' -- src/` → no match). But
nothing **asserts** it, and the `ambiguous` arm's positions come from the matcher's candidate
list. That gap is what the oracle closes: the rule is about **derivability of each row**, not
about which positions the arm happened to choose.

## Decision

**A rejection payload carries rows only for the region the submitted anchors identify.**

1. **Region-matched serve.** Every row's `position` lies inside `[0, fileHashes.length)`, its
   `hash` is `fileHashes[position]`, and its rendered content is `fileLines[position]` of the
   **same** snapshot. Never a content match, never the model's replacement text, never a
   position outside the named window. The rendered envelope must reproduce those bytes exactly.
2. **The disjointness signal is the row count, not the code.** Locally there is no
   `E_TARGET_LOST` / `E_UNVERIFIED_RANGE` (they are unported upstream debt, ADR-0021 §Debt,
   `src/domain-errors.ts:871-872`), so the payload shape decides:
   - **rows present** ⇒ the region is identifiable and the rows are its current anchors; the
     envelope renders the `Current range:` heading and the rows, and offers **no** retry
     affordance beyond them;
   - **rows absent** ⇒ the region is unidentifiable (`CONTEXT.md` → `target-lost rejection`);
     the envelope renders the headline alone, which names the previously served position and
     instructs a read, and no `Current range` heading of either form appears.
3. **No write-only field survives.** The `reread?: boolean` flag and the
   `Retry with these anchors (no read needed).` string are deleted. The flag was a constant
   `true` on all 14 producers (closure measurement in _Reproduce_), so it carried no
   information; `servedRows.length` carries the distinction, and a boolean that merely
   suppressed an unreachable hint was declaration-only vocabulary.
4. **Verification oracle.** `test/arch/rejection-payload-region.test.ts` asserts the rule per
   case with an `assertRegionPayload` helper and planted-violation negative controls. Its
   load-bearing properties: the file **never imports the content lookup** (a content-placed
   window cannot satisfy the check); every window is **hardcoded from served-coordinate
   knowledge**, never searched; each case pins its `expectedCode` plus the row/heading shape;
   and each constructed violation must **fail** the check.

### Deliberate divergence from upstream (recorded)

Upstream distinguishes the payload's remedy by **code** (`[E_TARGET_LOST]` ⇒ no rows,
`[E_UNVERIFIED_RANGE]` ⇒ rows under `Current range (fresh read):` with no hint,
`[E_STALE_RANGE]` ⇒ rows under `Current range:` with a hint). Locally the same shapes are
realised **under the existing codes**, with `servedRows.length` as the machine-readable signal,
because this lane adds **no new public literal** (no new `E_*`/`W_*` code a model can key on —
public vocabulary is the host's surface). The accepted cost is that the _reason_ is not
code-readable locally; the accepted benefit is that the host's error table, prompts and
downstream consumers are unchanged. Upstream parity is not a reason to add a declared-but-unproduced
code, which is exactly the defect T4 removed.

Upstream's four-case variant analysis (retired-in-place / re-added-elsewhere / shifted survivor /
one-stale-one-shifted) is satisfied locally by the existing exact-boundary rule (ADR-0018,
superseding ADR-0004): each boundary anchor must have **exactly one** served position, so a
look-alike line cannot re-bind the window. This ADR adds the row-derivability guard on top; it
does not re-open the boundary rule.

### Upstream → local reference map

| upstream arm                                                                               | local realization                                                                                                   | evidence                                                                                                        |
| :----------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------- |
| `[E_UNVERIFIED_RANGE]` — rows leased, heading `Current range (fresh read):`, no hint       | `[E_STALE_RANGE]` / `[E_UNSERVED_RANGE]` payload with **non-empty** `servedRows`, rendering `Current range:` + rows | `src/hashline/anchor-pipeline.ts` (13 arms), `src/domain-errors.ts` (`staleRangeFormat`, `unservedRangeFormat`) |
| `[E_TARGET_LOST]` — grounding void, no rows, read instruction in the headline              | `[E_STALE_RANGE]` with `servedRows: []` + `servedBlock: ""`, headline carries the read instruction                  | the single local site: `src/fs-bridge.ts` F7 version-guard arm                                                  |
| `assertLivePayload` matrix + 5 planted violations (+ 3 more added upstream later)          | `assertRegionPayload` + planted violations, local arms                                                              | `test/arch/rejection-payload-region.test.ts`                                                                    |
| code-based disjointness                                                                    | row-count-based disjointness                                                                                        | Decision §2, §3 above                                                                                           |
| `CONTEXT.md`: narrow `reject-and-serve`; add `target-lost rejection`; drop `context serve` | done in `CONTEXT.md` — the **authoritative home** for those terms; this ADR cites them and does not restate them    | `CONTEXT.md` glossary                                                                                           |

## Declared limit (R12)

Multi-window reads do not exist locally and are **not** exercised by this ADR.

**The limit, stated once.** A `windows` argument to the local `read` fails with `E_BAD_PAYLOAD`, and
the failure names the offending field only — it does not advertise the allowed set. The allowed set
is discoverable from the read tool's `parameters` schema (`buildReadTool`, `src/tool-read.ts:30`) and
from `READ_KS` (`src/contract.ts:238`). `src/contract.ts` is frozen by ruling, and adding a hint at
that call site would hand-copy the list into a third place.

The cell that pins this limit — including the control that shows the ban can fail — is
`test/arch/rejection-payload-region.test.ts` → _the declared multi-window limit is discoverable from
the failure (R12)_. Read the cell; it is the witness, and this ADR does not restate what it asserts.

**Predicate trigger (T6b):** the trigger is the _landing of a multi-window read_ — `READ_KS`
admitting a `windows` field. Until then the loud `E_BAD_PAYLOAD` is the discoverable failure, and
this ADR's rule stays window-count-agnostic.

## VOID record — the spec §9.5 ADR-0016 instruction

The plan (`mvcc-spec.md` §9.5) orders deletion of the _Consequences_ parenthetical _"a retired
anchor is recoverable only by a re-read (or by `reject-and-serve`'s served rows)"_ in
"ADR-0016". **This instruction is VOID for this tree, in both of its referents:**

```
[cwd=$ABS rev=f7ded15] git -C "$ABS" grep -n 'only by a re-read\|recoverable only' -- docs/; echo "exit=$?"
exit 1
```

The phrase does not exist anywhere under `docs/`. Local `docs/adr/0016-store-version-flap-guard.md`
is **Store Version-Flap Guard** (a different ADR entirely), and local
`docs/adr/0017-content-addressed-line-identity.md` has no such clause; the upstream file the plan
means (`UP/docs/adr/0016-content-addressed-line-identity-supersedes-healing.md`) already reads
_"A retired anchor is recoverable only by a re-read"_ — the parenthetical is absent at `00f8c34`,
deleted by upstream ADR-0018's own decisions. No replacement work is invented for this row, and no
ADR bullet claims to delete a clause that does not exist.

## Ledger

The T4 ledger cells `T4M1`/`T4M2` (drop `reread: true` at an arm), `T4M3` (render the retry hint
unconditionally) and `T4M5` (remove `reread?: boolean` from a payload map) **retired**: their
mutation anchors no longer exist — the deferral they pinned has fired. See ADR-0018's _T4 ledger_
subsection for the retirement record and the replacements (`T6M1`–`T6M4`).

## Consequences

- The retry affordance a rejection carries is its **rows**. A model that retries with an echoed
  row rejects at the same site; a read is the recovery. The `Retry with these anchors (no read
needed).` string is gone, so no message can promise a read-free retry the served state cannot
  honour.
- `E_STALE_RANGE` now carries two _shapes_ under one code: row-carrying (region identifiable) and
  row-less (target-lost). The verdict is machine-readable from `servedRows.length`; the
  informational prose is not.
- `CONTEXT.md` gains `target-lost rejection`, narrows `reject-and-serve` to region-matched serves,
  and drops the never-implemented `context serve`.
- The two deferred `W_*` warnings keep their deferral, with the **owner** moved from a lane letter
  to the producer seam (`src/hashline/served-guard.ts`) and `holds()` replaced by a predicate over an
  **injected witness** (`holds(fired)`), so production carries no witness state, the falsity is
  reachable, and the verdict cannot depend on evaluation order; the arch oracle derives the witness
  from a source scan as the independent second referent (T6 CP2, F2).
- Out of scope, unchanged: the fast path, in-place `E_STALE_RANGE` for torn or inserted spans,
  the content-placeable `E_STALE_ANCHOR` self-heal, the `E_SUSPICIOUS_TEXT` / `mode: "literal"`
  surface, and `README.md`'s error table.

## Reproduce

The `reread` closure measurement that decided the deletion (every path to the two payload
constructors is a literal `true`, the only non-literal path being the pass-through plumbing fed by
those same call sites):

```
[cwd=$ABS rev=f7ded15] git -C "$ABS" grep -n 'reread' -- src/
src/domain-errors.ts:150:    reread?: boolean;
src/domain-errors.ts:245:    /** Same rule as `E_STALE_RANGE.reread`: true omits the retry hint. */
src/domain-errors.ts:246:    reread?: boolean;
src/domain-errors.ts:289:// WHY: after T4 every production arm sets `reread: true`, so this hint branch is
src/domain-errors.ts:396:  // headline alone, and `reread: true` still suppresses the retry hint.
src/domain-errors.ts:399:  return payload.reread === true ? base : `${base}\n${RETRY_HINT}`;
src/domain-errors.ts:417:  // the retry hint obeys `payload.reread` exactly as `staleRangeFormat` does —
src/domain-errors.ts:421:  return payload.reread === true ? base : `${base}\n${RETRY_HINT}`;
src/fs-bridge.ts:136:        reread: true,
src/hashline/anchor-pipeline.ts:464:          reread?: boolean;
src/hashline/anchor-pipeline.ts:472:          reread?: boolean;
src/hashline/anchor-pipeline.ts:485:        ...(opts.reread !== undefined ? { reread: opts.reread } : {}),
src/hashline/anchor-pipeline.ts:496:        ...(opts.reread !== undefined ? { reread: opts.reread } : {}),
src/hashline/anchor-pipeline.ts:642:      reread: true,
... (12 more arms) ...
exit 0
```

```
[cwd=$ABS rev=f7ded15] git -C "$ABS" grep -c 'reread: false' -- src/; echo "exit=$?"
exit 1
```

`opts.reread` is written only by the two spreads at `:485`/`:496`, and every one of the 13
`ServedRejectionError` construction sites passes `reread: true`; the 14th producer
(`src/fs-bridge.ts`) passes it literally. Hence the field is the constant `true` and is derivable
from nothing — it is deleted.

After the change, the invariants are re-derivable from the committed tree:

```
node test/tools/mutate-ledger.mjs T6M1   # restore the dead retry affordance → formatter + oracle RED
node test/tools/mutate-ledger.mjs T6M2   # re-add `reread: true` at one arm → arch guard RED
node test/tools/mutate-ledger.mjs T6M3   # plant a real W_* producer → registry oracle RED
node test/tools/mutate-ledger.mjs T6M4   # break assertRegionPayload's rule → negative controls RED
```

## Considered Options

- **Keep `reread` and re-point it at the region rule** (the amended ticket's clause (b)) — rejected
  after measurement. Locally every producer sets it `true`, so a "`reread === true ⇔
servedRows.length === 0`" reading would require flipping 13 arms to omit it while the field's only
  remaining reader was a test — a field read only by a test is still write-only in production.
- **Re-defer the pair with a predicate trigger** (clause (c)) — rejected: the closure measurement
  proves the field is a constant, and a constant has no future producer that could make a
  re-deferral actionable. This was the trigger's own condition ("the next ticket that touches this
  contract").
- **Add `E_TARGET_LOST` as a bare union member so the payload shape is code-readable** — rejected:
  a declared-but-unproduced code is the exact defect T4 removed (`test/arch/domain-error-registry.test.ts`
  "deleting a deferred code's producer _stays_ deleted"). The code may return **with** its producer,
  in the absorb that ports it.
- **Keep serving context rows for the target-lost case (unleased)** — rejected upstream and here:
  a context row grounds no decision, and serving it would reintroduce a non-leasing serve.
