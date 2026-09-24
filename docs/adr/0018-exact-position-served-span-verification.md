# ADR-0018 — Exact-position served-span verification, fail closed

Date: 2026-09-24
Status: accepted; supersedes [ADR-0004](0004-orphaned-serve-healing.md)
Related: `src/hashline/anchor-pipeline.ts` (`verifyServedRange`), `src/session-view.ts`
(`_mergeServedRows`), `src/domain-errors.ts` (`E_STALE_RANGE`, `E_UNSERVED_RANGE`),
`docs/adr/0004-orphaned-serve-healing.md`, upstream ADR `content-addressed-line-identity-mvcc`

## Context

ADR-0004 healed orphaned serves in two places, both silently: an _eager heal_ at the
served-state layer (`_mergeServedRows` nulled the old slot when the same hash was written at a
new position) and _lazy content disambiguation_ at verification (`verifyServedRange`
enumerated candidate `(s,e)` spans filtered by length and content equality, then picked the one
nearest `startLine - 1`), plus a multi-line length-mismatch tolerance (`lenHealed`, `hashline`
`f94fb88`). The two reinforced: new orphans never persisted, and orphans already in the store
stayed recoverable.

The healing was load-bearing for a promise that does not hold. Content-addressed line identity
(ADR-0017; upstream ADR `content-addressed-line-identity-mvcc`) makes an anchor a name for
_content_, not for a position — so when an anchor moved, a look-alike line satisfied every
content-based test the disambiguation applied. Two identical lines are indistinguishable by
digest; only position separates them. Healing therefore could not detect the case it existed to
repair, and its failure mode was silent: the edit re-bound onto the wrong line and reported
success.

## Decision

A served span is verified against the file **exactly**, and anything else fails closed.

### The contract

For a request spanning `startLine..endLine` with boundary anchors `anchor_from` / `anchor_to`:

- each boundary anchor must have **exactly one** served position;
- the served span's length must equal the requested range's length;
- every line's hash must equal the served hash at its served position;
- a boundary anchor whose served position no longer equals its resolved position is **stale**;
- anything else rejects with `ServedRejectionError` — `E_STALE_RANGE`, or `E_UNSERVED_RANGE`
  when a boundary anchor has zero or multiple served positions.

**No look-alike search, ever.** There is no candidate enumeration, no nearest-span ranking, and
no length tolerance: `verifyServedRange` resolves each boundary anchor's single served position
and rejects when the span does not line up.

### What it removes

Both of ADR-0004's arms, and its tolerance:

- the **eager heal** in `_mergeServedRows` — a hash written at a new position now leaves the old
  slot INTACT; the duplicate surfaces at verification as `E_UNSERVED_RANGE`;
- the **lazy content disambiguation** in `verifyServedRange` — the candidate `(s,e)` enumeration
  filtered by length + content equality and ranked by proximity to `startLine - 1` is gone;
- `lenHealed` — the multi-line length-mismatch tolerance (`hashline` `f94fb88`).

ADR-0004 is **superseded** by this ADR.

## Behaviour change

**This is a user-visible behaviour change, and it is the point of the ADR.**

> After a **windowed** read (`offset`/`limit` on a file not yet fully read in that session), an
> edit whose anchor has moved now **rejects with `E_STALE_RANGE` and requires a re-read**, where
> it previously silently re-bound onto a content-identical line.
>
> More generally: the position check is **unconditional**, so _every_ pos-free route now fails
> closed, while a **strict** session (epoch pinned, file changed) already rejected before this
> ADR. An exterior shift that moves the served span therefore now costs a **re-read** rather
> than passing silently — that is ADR-0013's withdrawn promise, and the cost is deliberate.

### Measured: session-level A/B through the real tools

Three cells, driving `read`/`edit` rather than `verifyServedRange` with hand-set `strictPos`:

| #   | route                                                                             | base `ecdf997`             | this revision `3ed4323`    |
| --- | --------------------------------------------------------------------------------- | -------------------------- | -------------------------- |
| A   | full read → exterior insert `@0` → edit the originally-served range               | **REJECT** `E_STALE_RANGE` | **REJECT** `E_STALE_RANGE` |
| B   | windowed read (`offset`/`limit`, never a full read) → same exterior insert → edit | **PASS** (silent re-bind)  | **REJECT** `E_STALE_RANGE` |
| C   | control: full read, no external change → edit                                     | PASS                       | PASS                       |

The full-read route is **unchanged**, which is worth stating because it is easy to infer
otherwise from synthetic parameters: a full read pins the epoch, the exterior write makes
`epoch !== curSnapshotId` (`mutation.ts:152-155`), so `strictPos` was already `true` at base and
the old `strictPos &&` gate already rejected — the base message even reads `(pos-restricted
concurrency)`. The behaviour change is exactly cell B, the epoch-unpinned route.

Why the windowed case is the reachable one: the epoch snapshot id is pinned only on a full read
— `session-view.ts:307`/`:311`, inside `if (isFullRead)`; `upsertEpochSnapshotId` has one caller
and `clearEpochSnapshotId` none; and `isFullRead` requires `rows.length === full.hashes.length`.
A windowed read therefore never pins the epoch, so position trust stays off for that
`(session, path)` and the strict position check applies permanently.

A second route reaches the same state: `curSnapshotId` stays `undefined` when `fileSnap` throws
(`mutation.ts:148-151`).

The position check was made **unconditional** rather than left behind a `strictPos` flag
precisely because the unpinned route is reachable with no flag set — which is the route cell B
measures.

## Why this closed in T3a rather than T3c (T6 timing)

T6 (multi-window read) **adds** read windows. Every added window is another path that leaves the
epoch unpinned, so the exposure would have **multiplied** rather than stayed constant. Closing it
one line before T6 was strictly cheaper than carrying a known silent-rebind exposure into the
checkpoint that widens it. That is the affirmative reason the unconditional position check
(branch (b)) beat deferring to T3c (branch (a)).

## Status of the follow-up work

- **RES-1 is CLOSED in T3a.** It is not outstanding; the fail-closed contract above is its
  resolution.
- **Accepted debt, with a binding on T3c.** `strictPos` is now computed (`mutation.ts:152-155`)
  and passed (`mutation.ts:178`, `mutation/engine.ts:321/694/735`) but **read by nothing** — the
  position check no longer consults it. T3c is **bound** to delete it or subsume it into
  lease-derived position trust, and to resolve the `epochSnapshotId`/`curSnapshotId` interface
  fields (`anchor-pipeline.ts:593-594`) and their `applyEdit` passthrough (`:1043-1045`).
  **Anything still computed-but-unread after T3c is a blocking finding for T3c.**

## Relationship to upstream

Upstream's ADR-0016, `content-addressed-line-identity-mvcc`, is both why this contract is
meaningful and why healing was attractive. Content-addressed identity is what lets a lease
survive the edit that reassigns anchors — and it is also what made healing look safe, because a
moved anchor still names the same content. It is not safe: the digest cannot separate two
identical lines, so position is the only discriminator. This ADR keeps upstream's identity model
(ported in ADR-0017) and rejects upstream's healing.

## Considered Options

- **Keep healing and mark the result** (surface it as drift, or attach a healed-span notice to
  the response) — rejected. It still re-binds silently onto a look-alike line: a content digest
  cannot distinguish two identical lines, so the tool cannot know it healed the wrong span, and
  marking a result the tool cannot verify is not a safety property. Fail closed and re-read.
- **Keep healing behind a flag** (strict only when concurrency is suspected) — rejected: the
  windowed route reaches the unpinned state with no concurrency involved, so the flag would be
  off in exactly the reachable case.
- **Defer to T3c** — rejected on the T6 timing argument above.

## Consequences

- Silent rebinds become visible rejections. The cost is a re-read; the alternative was a
  successful edit to the wrong line.
- `E_UNSERVED_RANGE` gains a second producer (duplicate served positions) and stays a live code
  rather than the retiring one it was expected to become.
- The served mirror can hold a stale slot indefinitely — nothing nulls it. That is deliberate:
  the duplicate is the evidence, and deleting it here is the heal this ADR removes.
- `_mergeServedRows` becomes a pure merge with no disambiguation; the exact-write rule is now
  the only rule.
