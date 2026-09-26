# ADR-0023 — Multi-window read declined; the region rule is window-count-agnostic

Date: 2026-09-25
Status: **superseded** — the decline is overturned by operator ruling (FU-6, 2026-09-26) and the
`windows` port has landed; see the §FU-6 amendment below. The Decision §2 cells (R13/R14), the
region-rule retirement and the W1–W4 measurements stand on their own facts.
(Originally: accepted.)
Related: `docs/adr/0022-region-scoped-rejection-serves.md` (its _Declared limit (R12)_ is retired
here; its region rule is unchanged), `docs/adr/0018-exact-position-served-span-verification.md` (exact-write merge),
`docs/adr/0019-lease-identity-served-span-resolution.md` (lease identity), `src/session-view.ts`
(`_mergeServedRows`), `src/read-and-serve.ts`, `src/contract.ts` (`READ_KS`),
`test/arch/rejection-payload-region.test.ts` (R13, R14), upstream referent
`pi-better-edit@00f8c34:src/file-content/preview.ts` (`ReadWindow`, `buildWindowedPreview`),
`pi-better-edit@00f8c34:src/constants.ts:9` (`MAX_READ_WINDOWS = 16`)

## Context

Upstream `read` accepts `windows: ReadWindow[]` — up to 16 `{offset, limit}` pairs in one call.
The local `read` accepts one `offset`/`limit` pair, and a `windows` field fails `E_BAD_PAYLOAD`
naming the offending field only (ADR-0022 _Declared limit (R12)_). T6 was chartered to port the
multi-window read; T6a landed the region rule first and declared the limit that this ADR retires:

> "Multi-window reads do not exist locally and are **not** exercised by this ADR." — ADR-0022

The port was put to a justify-or-decline gate (`.lsz/tmp/handoff/T6b/CP0-premise-table.md`) with an
orchestrator-added atomicity row (A1). Both rulings came back the same way, so this ADR records the
decline and the retirement of the limit — the two things that would otherwise rot.

## Decision

1. **Decline the `windows: ReadWindow[]` port.** No contract change: `READ_KS` stays
   `["path", "offset", "limit", "encoding"]`, `src/contract.ts` and `src/tool-read.ts` stay frozen,
   and this lane's `src/` diff is empty. `MAX_READ_WINDOWS`, window normalization and window-shaped
   previews are not built.
2. **Retire ADR-0022's declared limit** by exercising multi-region interaction on the surface that
   exists: `test/arch/rejection-payload-region.test.ts` gains **R13** (two windowed reads whose
   served rows overlap; the anchors span the overlap) and **R14** (disjoint control; the anchors sit
   inside window A while window B is served, leased and unchanged). ADR-0022's rule needed no
   amendment — it was already stated over _the region the submitted anchors identify_, never over a
   read window, so it is window-count-agnostic by construction.
3. **The R12 ban stands.** A `windows` argument still fails `E_BAD_PAYLOAD` naming only the
   offending field, and ADR-0022's predicate trigger for that ban (a multi-window read landing in
   `READ_KS`) has **not** fired. What changed is the _scope_ claim: multi-region behaviour is no
   longer unexercised, so the limit sentence is false and is removed rather than restated.

## Why the port buys no capability

Each row is a measurement, not an opinion; each has a deciding command in _Reproduce_.

| #   | Measured fact                                                                                                                                                                                                                                                                                                                                                                                                                                               | Meaning for the port                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Upstream's windowed preview is a **per-window loop that unions rows by position** (`hashByPosition = new Map<number, string>()`, returned sorted). It holds no window-shaped state.                                                                                                                                                                                                                                                                         | N windows ≡ N sequential single-window reads producing the same position→hash union. There is no new expressible anchor or lease state to port.                                                                               |
| W2  | Locally, served rows **merge** across reads: `_mergeServedRows` slices + writes positions, and clears or truncates only on an explicit `clearFrom`/`truncateTo`. `wipeServedState` has **no caller in `src/`**, so no read path wipes another read's rows.                                                                                                                                                                                                  | The multi-region lease the port would grant already exists: one edit can be anchored on rows two separate reads served (R13 asserts exactly this).                                                                            |
| W3  | Upstream's line budget is **shared, not multiplied**: `remainingLines` starts at `maxTruncLines` and is decremented per window; a window cut by the budget renders `[Read budget exhausted; this window is not shown.]` and serves nothing.                                                                                                                                                                                                                 | 16 windows serve no more rows than one wide `offset`/`limit` read under the same budget (`DEFAULT_MAX_LINES = 2000`). Batching cannot raise what a single read can serve.                                                     |
| W4  | Atomicity (the A1 row): sequential reads **can** straddle an external write, but the straddle is handled — the snapshot identity binds `ino`+`mtimeMs`+`ctimeMs`+`size`, drift is reported per position, the F7 version guard rejects row-less (target-lost), and a straddle-tolerant cell already exists. Meanwhile one-call same-revision multi-region serving is reachable today via a single wide read, whose serve-merge and lease grant are one unit. | The straddle is real but handled, and the atomic alternative already exists. The residual delta of `windows` over a wide read is **payload shaping** (skip middle rows, per-window headers) and **call count** — convenience. |
| W5  | Decision rule (T8 correction 2026-09-26: no such precedent exists under either numbering — `rg -i 'parity\|convenience' docs/adr/0016-*` → 0 hits, and no upstream ADR carries a `justifies`/`convenience` sentence): parity alone does not justify a port. W1–W4 leave call count as the only delta, so there is no capability to justify it.                                                                                                              | Convenience fails the same way parity does. Declined, recorded, with a trigger for revisit.                                                                                                                                   |

Not measured, not claimed: whether upstream accumulates served state **across** sequential calls.
The decline does not depend on it — W2 is a statement about this tree.

## The retirement is falsifiable, and the pre-existing corpus was not

Retiring a limit by adding cells is only honest if the cells can fail. Measured, in a throwaway copy
of the tree (the worktree's `src/` is never written; recipe in _Reproduce_): replacing the region
echo with a whole-file echo —

```ts
const echoRows = buildRangeEcho(1, fileHashes.length, fileHashes); // was (startLine, endLine, …)
```

— reddens **exactly R13 and R14** (`Tests 2 failed | 14 passed (16)`), through the oracle's window
check. Every pre-existing cell in the file stays green under that regression, including the
span-length cell whose region happens to be the whole file. So the two new cells carry the limit's
removal, and the corpus before them did not: that is the measurement this ADR's Decision §2 rests on.

R13 additionally pins the serve-union in the test layer (the merged mirror holds both windows, and
the overlapped line occupies **one** position — the exact-write rule of ADR-0018, neither duplicated
nor dropped), and both cells assert the exclusion directly: no row position and no rendered
`hash│line` outside the resolved region, for rows that are served, leased and byte-unchanged. Only
the region rule keeps them out.

## Predicate trigger — when to revisit (with deciding commands)

Revisit this decline **iff** either holds; otherwise the answer stays no and no new measurement is
owed:

- **(a) Upstream's `ReadWindow` changes from convenience to capability** — e.g. windows carry lease,
  epoch or snapshot identity, or a window can serve rows a single wide read cannot. Decide with:

  ```
  git -C ../pi-better-edit grep -n 'ReadWindow' <sha> -- src/
  git -C ../pi-better-edit show <sha>:src/file-content/preview.ts | sed -n '/^function buildWindowedPreview/,/^}$/p'
  git -C ../pi-better-edit show <sha>:docs/adr/ | grep -il window   # the ADR that changed it, if any
  ```

  The test is whether the union-by-position loop still holds and whether the line budget is still
  shared (W1, W3). If both still hold, the delta is still call count and the decline stands.

- **(b) The host advertises a multi-window read payload.** Decide with:

  ```
  grep -rn 'windows' node_modules/@deepseek-ai/dsh-tools/ 2>/dev/null | head   # host schema surface
  grep -n 'READ_KS' src/contract.ts                                            # local allowed set
  ```

  A host-side `windows` field changes the contract question from "should we" to "the host already
  sends it"; `src/contract.ts` is frozen by ruling, so that reopen needs its own ticket.

A correction owed to the CP0 table: its J2 row cites a `resolveWindows` function. No such symbol
exists at `00f8c34` (`git -C ../pi-better-edit grep -n 'resolveWindows' 00f8c34` → empty). The
measured referent is `buildWindowedPreview`, cited above; J2's _conclusion_ survives, its command did
not, and a decision whose command does not run is not re-derivable.

## Ledger

No mutant was added, retired or re-anchored: this lane changes no `src/` line, and the ledger's
mutation anchors are all in `src/` or in pre-existing cells. One **expected RED set grew**, and it was
re-pointed in the same commit as the cells that grew it:

- `T6M1` (_restore the deleted retry affordance on the stale-range formatter_) — expected 6 cells,
  now 8. R13 and R14 assert their `E_STALE_RANGE` payloads through `assertRegionPayload`, which bans
  `Retry with these anchors`, so restoring the affordance reddens them too. Measured in a scratch
  copy before the re-point: `3 failed | 13 passed (16)` in
  `test/arch/rejection-payload-region.test.ts` (the third is the pre-existing `T6.regionOracle`).
  Recorded as `T6b.overlap` / `T6b.disjoint` in `test/tools/mutate-ledger.mjs`.

`T6M4` (_break the region oracle's per-row identity guard_) is unchanged at one expected cell: it
removes a check, so only the planted-violation cell that asserts the check _fails_ reddens. R13/R14
drive real payloads, whose rows satisfy the identity, so they stay green under it — their own
falsifiability is the region-echo mutation in _Reproduce_, not `T6M4`.

## Considered Options

- **Port `windows` for parity with upstream** — rejected: W1–W3 leave call count as the only delta,
  and the W5 rule makes parity a non-reason. Porting would also add a public field to a
  frozen contract and a second way to express what `offset`/`limit` already expresses.
- **Port a capped subset (`MAX_READ_WINDOWS` small) as a cheap win** — rejected: the cost is not the
  cap, it is the second serve path. Window-shaped previews need their own budget accounting (W3),
  their own section rendering and their own region definition, all for a union `_mergeServedRows`
  already produces.
- **Restate ADR-0022's limit instead of retiring it** (e.g. "multi-window reads remain unported") —
  rejected: the limit as written claims multi-region interaction is _unexercised_, and after R13/R14
  that claim is false. A limit sentence that outlives its measurement is rot; the unported-fact
  belongs in the sync record (`AGENTS.md`, `docs/absorption-plan.md`), not in an ADR limit.
- **Delete the R12 cell along with the limit** — rejected: the ban is live behaviour (a `windows`
  field still fails loudly and discoverably), and its cell is the witness that the failure names the
  offending field only. Only the _scope_ claim was retired.

## Consequences

- No model-visible change and no CHANGELOG entry: the read surface, the error codes and the rendered
  payloads are byte-identical before and after this lane. T7 is told so explicitly
  (`.lsz/tmp/handoff/T4/for-T7.md`).
- The next absorb meets `windows` again. It is recorded as **deliberately not ported** in
  `AGENTS.md` (_Upstream sync_) and `docs/absorption-plan.md`, with the measured reason, so the
  decision is not re-litigated by whoever ports `87a17eb..upstream/HEAD`.
- The region rule now has multi-region carriers. A future change that scopes a rejection payload by
  _read window_ instead of by _the region the anchors identify_ — for example one that echoes every
  served window — reddens R13/R14 rather than passing silently.
- `src/session-view.ts`'s ownership of the served-merge invariant is now load-bearing for a stated
  architectural decision (W2), not only for the read path. A future "clean up served state on read"
  change would silently revoke the multi-region lease this ADR relies on; R13's mirror assertion is
  the tripwire in the test layer, since `src/` gains none.

## Reproduce

All commands from the worktree root (`~/development/ai/dsh-better-edit.feat-t6b-multiwindow-read`);
`../pi-better-edit` is the upstream checkout at `00f8c34`.

```
$ git grep -n 'ReadWindow' -- src/; echo "exit=$?"
exit 1                                          # W1's local half: no window type exists here
$ grep -n 'READ_KS' src/contract.ts
238:const READ_KS = new Set(["path", "offset", "limit", "encoding"]);
345:  rejectUnknownFields(request, READ_KS, "Read request");
$ git -C ../pi-better-edit grep -n 'MAX_READ_WINDOWS =' 00f8c34 -- src/constants.ts
00f8c34:src/constants.ts:9:export const MAX_READ_WINDOWS = 16;
```

W1 — the union is by position, under one shared budget (W3 is the `remainingLines` lines):

```
$ git -C ../pi-better-edit show 00f8c34:src/file-content/preview.ts \
    | sed -n '/^function buildWindowedPreview/,/^}$/p' \
    | grep -n 'hashByPosition\|remainingLines -=\|budget exhausted'
11:  const hashByPosition = new Map<number, string>();
29:        `${header}\n[Read budget exhausted; this window is not shown. Re-read it on its own.]`,
55:    for (const row of built.served) hashByPosition.set(row.position, row.hash);
56:    remainingLines -= built.text === "" ? 0 : built.text.split("\n").length;
67:    served: [...hashByPosition.entries()]
```

W2 — the merge is exact-write and nothing on a read path wipes it:

```
$ grep -n 'export function _mergeServedRows' src/session-view.ts
57:export function _mergeServedRows(
$ git grep -n 'wipeServedState' -- src/
src/session-view.ts:12: * clearDriftReported, wipeServedState, servedPositionsOf,
src/session-view.ts:451:export async function wipeServedState(sessionKey: string): Promise<void> {
                                                 # definition + doc comment, zero callers
$ grep -n 'recordServed' src/read-and-serve.ts
5: * This module only adds the persistence seam: recordServed + clearDriftReported
18:  recordServed,
173:    servedLanded = await recordServed(       # the read path merges; it never clears
```

W3's local budget and W4's snapshot identity / straddle carrier:

```
$ grep -n 'DEFAULT_MAX_LINES =' src/file-view.ts
37:export const DEFAULT_MAX_LINES = 2000;
$ grep -n 'return `v2|' src/file-view.ts
347:  return `v2|${canonicalPath}|${info.ino}|${info.mtimeMs}|${info.ctimeMs}|${info.size}`;
$ grep -n 'tolerates an external positional shift' test/core/drift.test.ts
215:  it("tolerates an external positional shift above the range — only genuinely removed lines drift", () => {
$ grep -n 'export async function recordServedTruncated' src/session-view.ts
354:export async function recordServedTruncated(   # merge + lease grant as ONE unit (A1)
```

Decision §2's carriers, and the falsifiability recipe (scratch under gitignored `.lsz/tmp`; the
worktree's `src/` is never written, so `git diff --stat src/` stays empty):

```
$ npx vitest run test/arch/rejection-payload-region.test.ts     # R13 + R14 green at HEAD

$ PROBE=.lsz/tmp/t6b-falsify
$ rm -rf "$PROBE" && mkdir -p "$PROBE"
$ git archive HEAD | tar -x -C "$PROBE"
$ ln -s "$PWD/node_modules" "$PROBE/node_modules"
$ perl -0pi -e 's/  const echoRows = buildRangeEcho\(startLine, endLine, fileHashes\);/  const echoRows = buildRangeEcho(1, fileHashes.length, fileHashes);/' \
    "$PROBE/src/hashline/anchor-pipeline.ts"
$ npx vitest run --root "$PROBE" test/arch/rejection-payload-region.test.ts
     × overlapping windowed reads: an anchor pair spanning the overlap scopes the payload to the resolved region (R13)
     × disjoint windowed reads: an anchor pair inside window A excludes window B's rows (R14)
 Test Files  1 failed (1)
      Tests  2 failed | 14 passed (16)
$ rm -rf "$PROBE"; git diff --stat src/; echo "empty=$?"
empty=0
```

The mutation ledger sweep (`node test/tools/mutate-ledger.mjs <id> --expect-rev=<40-char sha>`,
foreground, sequential) is the standing check that the pre-existing region carriers still fail when
their own invariants regress.

## FU-6 amendment (2026-09-26) — the decline is superseded; `windows` has landed

**Ruling.** The operator overruled all recorded declines (FU-6 ticket, relayed via `fu-tm`,
2026-09-26): port upstream's multi-window read contract plus the read-path stats consolidation in
one commit. This is an override of Decision §1, **not** the predicate trigger above firing — W1–W4
still measure what they measured, and the trigger's tests (union-by-position, shared budget) still
hold at the ported commit. The ruling substitutes an owner decision for the capability argument;
the measurement record stays intact because Decision §2's carriers (R13/R14) and the region-rule
retirement do not depend on the decline.

**Ported referent.** `pi-better-edit@2334352206adcf2c5c2cb0d3beaa1eae7ea8f0c4` — _feat(read): add
multi-window reads and consolidate the read path's stats_ (2026-09-22; an ancestor of the current
sync cursor `00f8c34`, i.e. this closes the single deliberate exception of the v2 absorb — the
cursor does not move). Cited lines: `2334352:src/constants.ts:9` (`MAX_READ_WINDOWS = 16`),
`2334352:src/file-content/preview.ts:45-49` (`normWindows` cap + message),
`2334352:src/read.ts:68` (schema `maxItems`), `2334352:src/read.ts:131,179` (`isFullRead` follows
the empty-array fallback; drift cleared only on full reads),
`2334352:src/file-content/loader.ts:34` + `2334352:src/file-content/index.ts:51` (`FileStats`
travels with the loader's text into `fileSnap`, fresh-stat fallback).

**Local landing.** `src/file-view.ts:45` (`MAX_READ_WINDOWS`), `:520` (`normWindows`), `:731`
(`buildWindowedPreview`), the `hintRemainder` threading at `:601`/`:654`/`:705`/`:716`;
`src/contract.ts:244` (`READ_KS` gains `"windows"`) and `:56` (`ReadParams.windows`);
`src/tool-read.ts` (schema `windows` entry, passed through to the seam);
`src/read-and-serve.ts:54`/`:131`/`:169` and its `isFullRead` gate.

**Disclosed deviations (each measured, none silent).**

1. The dsh value-schema DSL has no array `maxItems` (`node_modules/@deepseek-ai/dsh-tools` compiler:
   array nodes admit only `type`/`items`/annotations) — upstream's schema+preview double enforcement
   reduces to `normWindows`-only; the cap stays model-discoverable via the tool description text.
2. `MAX_READ_WINDOWS` lives in `src/file-view.ts`, not `src/constants.ts` (that file is another
   lane's scope; the read budgets already live together in `file-view.ts`).
3. `fileSnap(absolutePath, preloadedStats?)` takes no checksum argument — this tree's `fmtSnapId`
   carries no checksum segment, so upstream's third parameter has no local counterpart.
4. The stats-consolidation cell for `prepareFile` was not ported: the local read path loads text
   through `FileIO.readText` (`readView` in `src/file-view.ts`) and never double-stats through a
   loader→`fileSnap` chain on the tool path; the `FileStats`/`LFile.stats`/preloaded-`fileSnap`
   plumbing itself is ported verbatim-shape and pinned by `test/core/file-view-stats.test.ts`.

**Tests.** `test/tools/read-windows.test.ts` ports upstream's suite (headers, overlap collapse,
past-EOF, shared budget, no root `nextOffset`, `windows: []` full-read fallback, cap rejection)
with seam-level adaptations only; `test/arch/rejection-payload-region.test.ts` R12 is flipped per
ticket direction — `windows` now serves (`=== Lines 1-1 of 3 ===`) and the unknown-field witness
uses `ranges`, with the allowed-set leak ban and its demonstration control intact; R13/R14
continue to pin the sequential path on purpose. The mutate ledger needed no re-anchoring: zero
mutants anchored in `src/file-view.ts`, the `R2M1` anchor line is untouched, and `T6M4`'s anchor
block survives the R12 rewrite.
