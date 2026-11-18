# ADR-0035 — The full-read verdict is FileView's alone; a page clears no hazard state

Status: Accepted (ticket arch-T3, lane `arch-impl-candidates`).
Related: [ADR-0029](0029-windowed-read-projection.md) — windowed reads and the projection that
renders them; unchanged here, because this record is about the store seam's verdict on a read, not
about what the read looks like. [ADR-0027](0027-single-projection-collapse-contract.md) — the
projection text contract, untouched. [ADR-0019](0019-lease-identity-served-span-resolution.md) /
[ADR-0018](0018-exact-position-served-span-verification.md) — the lease identity that resolves a
shown anchor; it is the reason the lease grant stays unconditional below.
Downstream records: `src/file-view.ts` (`FileView.fullRead`, `readView`), `src/read-and-serve.ts`
(`readAndServe`), `src/session-view.ts` (`ServeContext`, `recordServed`,
`warnOnNonDenseFullReadMirror`), `test/core/full-read-authority.test.ts` (the four cells),
`test/core/epoch-lifecycle.test.ts` and `test/tools/read-windows.test.ts` (the repaired cells).

## Context

Two predicates decided "is this a full read", in two places, from two different facts.

- `readAndServe` decided from the **request shape** (`src/read-and-serve.ts`): `offset` absent,
  `limit` absent, no requested windows (`undefined`/`[]` both mean none, per `hasRequestedWindows`),
  and nothing truncated. That verdict was used for exactly one effect: clearing the reported-drift
  marks.
- `recordServed` decided from the **served rows** (`src/session-view.ts`): `rows.length ===
full.hashes.length` and every row dense (`position === index`, `hash === hashes[index]`). That
  verdict gated the other three effects a full read owns — clearing retired anchors, clearing
  hazard cards, and overwriting the whole served canon array.

They disagree for exactly one shape: a read that pages over the whole file. Measured on `7c0930f`
with a 4-line file (`one\ntwo\nthree\nfour\n`) — after a plain full read, then seeded sentinels
(`retired = [{hash: "ZZZ", deathPos: null}]`, `cards = [999]`, `canons = 10 × "JUNK"`), then
`markDriftReported(["abc"])`, one shape read, measure:

| shape                                | `retiredAfter` | `cardsAfter`  | `canonsAfter`       | `driftAfter` |
| ------------------------------------ | -------------- | ------------- | ------------------- | ------------ |
| full read (control)                  | `[]`           | `[]`          | 4 dense entries     | `[]`         |
| `{limit: 1_000_000}`                 | `[]`           | `[]`          | 4 dense entries     | `["abc"]`    |
| `{offset: 1, limit: 4}`              | `[]`           | `[]`          | 4 dense entries     | `["abc"]`    |
| `{windows: [{offset: 1, limit: 4}]}` | `[]`           | `[]`          | 4 dense entries     | `["abc"]`    |
| `{offset: 1, limit: 2}`              | `["ZZZ", …]`   | `[999, 0, 1]` | 10 entries (merged) | `["abc"]`    |

The same read, two verdicts: `readAndServe` called the three whole-file pages **not** a full read
(the drift marks survived) while `recordServed` called them **the** full read. The cost is not
cosmetic:

- A page wiped the hazard set for lines it never served. The retired anchor `ZZZ` at an unknown
  death position — the shape no partial sweep is allowed to drain — was dropped, and the hazard
  cards that limit which death positions the next sweep may free went with it.
- A page overwrote the served canon array with its own dense projection, destroying the canon holes
  the verification collision guard reads (a `null` canon means "not known for this hash", and the
  partial branch exists precisely to keep that hole rather than fill it from a guess).
- The two readers of the verdict also disagreed about their own narrowing rules, so no single place
  could be fixed: moving the rule into either file leaves the other one guessing.

The request shape is known in exactly one place. `readView` already owns the window rule
(`hasRequestedWindows`) and already returns `truncation`; `recordServed` never sees either — it sees
rows, and rows are a consequence, not a request.

## Decision

1. **`FileView` computes the verdict once and returns it.** `readView` sets `fullRead` from the four
   request facts that seam already owns — no `opts.offset`, no `opts.limit`,
   `!hasRequestedWindows(opts.windows)`, and `!r.truncation?.truncated` — and returns it on the
   view. No other site computes a full-read verdict: `readAndServe` reads `view.fullRead` for the
   drift clear and forwards the same value as `fullRead` in the serve context, and `recordServed`
   reads it from there.
2. **`recordServed` gates only the three hazard/cache effects on it** — `clearRetiredAnchors`,
   `clearCards`, and the whole-array canon overwrite. Everything else it does is common to every
   serve: the `served` row merge, and the partial branch's per-row canon merge plus `sweepAndRetire`
   (which is how a page still GC's the rows it did serve).
3. **The density check degrades to an assertion, never a second authority.** When the context says
   `fullRead: true`, `rows` must be the dense mirror of `hashes`; a non-dense mirror means
   `FileView.served` disagrees with `FileView.hashes`, which is a FileView bug. It is reported
   (`console.warn`, naming the path and the row/hash counts) and the verdict still decides — a
   warning must not silently become the thing that decides.
4. **The lease grant is not a full-read effect.** `grantServeLeases` stays unconditional, and its
   call site and body are unchanged. A served anchor is editable only through its lease, and a lease
   is stamped with the snapshot it belongs to, so a page still commits the content it showed. This
   is a deliberate limit, not an oversight — see Consequences.
5. **`recordServedTruncated` keeps no verdict at all.** Its rows are served from the result snapshot
   the write just made; that snapshot is neither a read nor a page, so it is neither branch.

## Consequences

- A page no longer clears retired anchors, hazard cards, or the whole canon array. The rows it
  actually served are still GC'd by the partial branch: `sweepAndRetire` frees the death positions
  the page re-observed, and the per-row canon merge refreshes (and only refreshes) the canons of the
  positions it served.
- **The epoch follows the content the session was shown, and a page moves it.** Unchanged content ⇒
  the pin does not move (it is content-addressed). Changed content ⇒ the page commits what it
  displayed, and the pin advances to it. That is the direct consequence of decision 4: a lease
  cannot exist without the snapshot it is stamped with, so "grant leases for these rows" and "commit
  the content behind them" are one act. It is a deliberate limit: the alternative is a
  displayed-but-unleasable anchor, measured below as worse than the status quo.
- The verdict is now explicit at every call site. A caller that intends a full serve passes
  `fullRead: true`; a caller that intends a page passes `fullRead: false` (or omits the context when
  it has none, e.g. `scanDrift`'s recorded drift rows). Of the existing callers, the 19 that pass a
  context were triaged one by one against the shape they already carried, and no assertion changed:
  a dense mirror ⇒ `true`, a proper subset ⇒ `false` reproduces the previous branch exactly, so only
  the read path — the one place where the two predicates disagreed — changes behaviour.
- The verdict's carrier was renamed `FullReadContext` → `ServeContext` when the verdict was added:
  the old name was already a misnomer (a page passed the same context — `hashes`, `canons` — and
  the full-read decision was derived from the rows inside `recordServed`), and the interface now
  carries the verdict plus the serve's `content`, so the new name says what it is: one serve's
  context. The rename is plain — no alias — and safe because nothing consumes the old name:
  `rg -n "FullReadContext" src test` → 0 hits, and no external consumer is possible, since
  `package.json`'s `exports` map publishes only `.` → `./lib/types/index.d.ts` (plus
  `./package.json`) and `src/index.ts` re-exports only `name`/`inject`/`apply`/`AgentTools` — nothing
  from `session-view.ts`. A deep import into `lib/types/session-view.d.ts` was never part of the
  published contract.
- Pins: `test/core/full-read-authority.test.ts` (four cells — the refined page clears nothing, the
  full read still clears, a genuinely partial page preserves, and a page of changed content keeps
  its anchors leasable), the repaired `test/core/epoch-lifecycle.test.ts` windowed cell (lease
  identity _and_ hazard state across three non-plain shapes), and the hazard half of
  `test/tools/read-windows.test.ts` (`windows: []` clears the whole contract; a window covering the
  whole file does not).
- `test/tools/mutate-ledger.mjs`'s `R2M1` (the `previous`-reconstruction gate in `read-and-serve.ts`)
  and `T5M29` (the `commitSnapshot` line in `grantServeLeases`) both still anchor on live text, and
  both still produce their recorded RED sets.

## Rejected alternatives

- **Gate the lease grant on the verdict too.** Measured: 12 failing tests across 7 files, every one
  of them `E_UNKNOWN_ANCHOR` on page-then-edit — anchors the model was just shown become
  uneditable, because the lease is the only route from a shown anchor to a line identity
  (ADR-0018/ADR-0019). A displayed-but-unleasable anchor is worse than the defect being fixed, so
  the grant stays.
- **Keep the density verdict in `recordServed`.** That is the defect: rows are a consequence of the
  request, and a page that happens to cover every line produces rows indistinguishable from a full
  read's. No amount of extra row-shape checks recovers the information that was never in the rows.
- **Put the verdict in `readAndServe` and thread it through as a bare boolean.** It would leave the
  request-shape rule in the caller that already had it and give `recordServed` a `boolean` with no
  owner — the second caller (the write hook, the drift scan) would have to re-derive it. `FileView`
  owns the shape, `hasRequestedWindows` and `truncation` are already there, so it owns the verdict.

## References

- [ADR-0029](0029-windowed-read-projection.md) — the windowed projection this record leaves
  untouched.
- [ADR-0027](0027-single-projection-collapse-contract.md) — the projection text contract.
- [ADR-0019](0019-lease-identity-served-span-resolution.md), [ADR-0018](0018-exact-position-served-span-verification.md)
  — lease identity, and why an unleased row cannot be edited.
- [ADR-0025](0025-63-supersedes-24-zero-matched-strip-arm.md) — the served-state warning
  producers that read the same state this verdict now labels.
- The arch-T3 probe (a throwaway `test/core/__probe-t3.test.ts`, deleted after measuring) — the
  pre-fix numbers this record's Context table is re-derived from. It is not committed; the
  table above and the pins named in Consequences are the durable form.
