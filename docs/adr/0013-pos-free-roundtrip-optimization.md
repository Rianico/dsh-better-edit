# ADR-0013 — Pos-free round-trip optimization with concurrency fallback

Date: 2026-09-01

## Status

accepted; **partially superseded by [ADR-0018](0018-exact-position-served-span-verification.md) and [ADR-0019](0019-lease-identity-served-span-resolution.md)**.

- **§1 (epoch not pos) — dead.** The epoch pin (`served.snapshotId`, `loadEpochSnapshotId`, its writer and readers) was deleted in T3c CP1-r1 (`6272e09`) as write-only state; position trust now comes from line identity, not from an epoch comparison. Backing: `rg -n 'strictPos|EpochSnapshotId|epochSnapshotId|curSnapshotId' src/ test/ tests/` → 0 hits.
- **§2 (tombstone / allocation invariant) — survives.**
- **§3 (concurrency fallback) — never shipped in dsh, now removed.** The automatic `changed ∩ [L,R]` strictness existed only as the unread `strictPos`; ADR-0018 measured that the position check was already unconditional.
- **§4 (non-overlapping forever is pos-free) — the outcome is restored via identity**: exterior drift no longer aborts a non-overlapping edit, by a stronger instrument rather than by dropping the position check. Backing: `tests/51-epoch-strict.test.ts` and `test/core/lease-resolve-seam.test.ts` (a benign shift applies at its rebased coordinate, asserting the exact resulting bytes).

This ADR's `## Considered Options` rejected "strict pos always" for its re-read tax, which is what ADR-0018 shipped; ADR-0019 removes that tax on the benign-shift route. See ADR-0018's "Behaviour change" for the measured cost and for the routes that are unchanged.

## Context

Issue [#31](https://github.com/Rianico/dsh-better-edit/issues/31) — freed `3-char` anchors re-bind to identical-content lines and pass `verifyServedRange` silently. Root cause is two-layer: `mapStableHashes` re-allocates a freed hash via `removedByContent` queue + `baseIdx=xxh32(canon)%SPACE` free-bit, and `verifyServedRange` is position-blind (`served[candFrom+k]==fileHashes[startLine-1+k]` only).

Production evidence: 1050 edits / 145 sessions, 901 `Successfully edited` hide rebind-successes; `old_string` fails loud+lossless in same situation. The whole-span variant (`S@3 reborn @3` after `other|cards` swap) shows strict `from==pos` also fails when `same pos+same canon` but different span.

Project contract (`CONTEXT.md:anchor philosophy`) is `position-independent` — exterior `insert @0` before `served 1..5` must not abort `edit 10..12`. Strict `pos` breaks it. Whitespace-insensitive (`ADR-0002`), orphan healing (`ADR-0004`) already rely on content-matching candidates, not pos.

See `CONTEXT.md` glossary (`serve`, `served state`, `position-independent`, `reject-and-serve`, `orphaned serve`) for terminology.

## Decision

Keep **`position-free` for single-thread** (serial `read->edit*` per `sessionKey`), fallback to **`pos-restricted + tombstone + canon`** for concurrency. Model is `OCC` with read-set=`served range`, not file — exterior drift is `drift notice` (ADR-0006), not abort.

### 1. Epoch not pos

At `read full` (`file-view.ts:readView` without `offset/limit` and not truncated): store `epoch={snapshotId:ino|mtime|size|checksum, servedHashes, servedCanons}` per `(session,path)` in `hash-store.ts:served`. `partial read` merges via `_mergeServedRows` without clearing epoch.

At `edit` (`mutation/engine.ts:applyOne` -> `hashline/anchor-pipeline.ts:verifyServedRange`):

- `curId=fileSnap(path)` vs `epoch.snapshotId`: if `==` skip pos.
- else candidates `{ [cFrom,cTo] | len==currentLen && ∀k servedHashes[cFrom+k]==fileHashes[startLine-1+k] }` (existing lazy disambiguation, ADR-0004), filtered by `tombstone`, then `∀k servedCanons[from+k]==canon(fileLines[startLine-1+k])` else `E_RANGE_STALE`. No `from==pos`.

### 2. Tombstone (allocation invariant)

`hash-assign.ts:mapStableHashes` drops `removedByContent` queue. `used=bitset(oldHashes)∪bitset(tombstone)` where `tombstone:Set<string>` per `(session,path)` since last full `read`, persisted in `served.tombstones TEXT` (`JSON string[]`). New lines probe over it. Lifecycle:

- `edit success: tombstone∪=removedHashes` (`mutation/engine.ts:collectRemovedHashes`)
- `undo: tombstone=(tombstone-restored)∪(cur-restored)`
- `read full: tombstone=∅` ; `partial: keep` ; `pruneServedOlderThan` clears with `served`.

Prevents `S@3` reborn `@3` whole-span case where `pos`+`canon` both pass.

### 3. Concurrency fallback (automatic, no config)

No `supportConcurrency` flag — fallback is automatic via `epoch`:

```
curId = fileSnap(path) // ino|mtime|size|checksum at edit
if curId == epoch.snapshotId
  -> single-thread, no concurrent write: resist (pos-free)
     candidates hash== && tombstone∉ && canon==
else
  changed = diff(epochHashes, curHashes) // indices where hash!=
  if changed ∩ [L,R] == ∅ && changed ∩ servedRanges == ∅
    -> resist (exterior drift, e.g. insert @0 before served 1..5) -> pass
  else
    -> strict: from==startLine-1 && to==endLine-1 && tombstone∉ && canon== else E_RANGE_STALE
```

Makes `shift==rebind` loud only when `changed` overlaps target, not when exterior. Cost is one `edit` retry, rare (`~1/238k`) — and it is not a re-serve: a strict/identity rejection records nothing and grants nothing (ADR-0018, T3f), says `Re-read.`, and a retry with the echoed anchors is rejected again (measured).

### 4. Non-overlapping forever is pos-free

`A:10..12 +1 line` shifts `B:20..30->21..31`. `B`'s `served 20..30 == file 21..31` still `candidates==1` -> pass. Non-overlapping spans never abort in `resist`.

## Single vs Multi-session

|                                                       | Single-session (serial `read->edit*` per `sessionKey`) | Multi-session (concurrent `A`+`B`)                                                       |
| ----------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Read-set                                              | `epoch==curId` → no concurrent writer                  | `epoch!=curId` → concurrent `changed` detected                                           |
| Non-overlapping `A:10..12+1` shifts `B:20..30→21..31` | `pass` — candidates `hash==` still `1`, `tombstone∉`   | `changed ∩ [L,R]==∅` → `resist` → `pass` (drift notice, not abort)                       |
| Overlapping `S@3 reborn @3` whole-span                | `tombstone` blocks allocation → `E_STALE_ANCHOR`       | `changed ∩ [L,R]!=∅` → `strict from==pos` → `E_RANGE_STALE`                              |
| Cost                                                  | `pos-free` — zero extra round trips                    | May incur one `edit` retry, and it is not a re-serve (ADR-0018, T3f; see the note below) |

> **Historical scope (Status §3):** the strict `from==pos` column in the table above
> is the `strictPos` fallback, which never shipped and is removed; the old code name
> `E_RANGE_STALE` was renamed `E_STALE_RANGE` by ADR-0014. Today an overlapping
> concurrent change goes through the identity gate — it applies at the rebased
> coordinate, or rejects as `E_STALE_RANGE` (ADR-0018 / ADR-0019).
>
> **Tombstone (T4 CP1-r2, F6) — this blockquote described four arms that no longer exist.**
> It used to say the `Retry with these anchors (no read needed)` hint survives on the
> non-`reread` arms: served-length mismatch (`src/hashline/anchor-pipeline.ts:802` at
> `3f4aca6`), a line whose bytes differ from what was served (`:883`), and every
> `E_UNSERVED_RANGE` (`:775`/`:790`) — and that those echo rows are "the current file's
> anchors". **The second half was right; the first is now history.** T4's F1–F3 set
> `reread: true` on all four arms, so no arm renders the hint and the callers read from
> the echoed _current_ rows without a serve being recorded
> (`buildRangeEcho(startLine, endLine, fileHashes)`). Measured basis: CP0 G3 (`SR@802`)
> and H1 (`SR@790`) — the retry is rejected byte-identically at the same site and a
> re-read applies. The historical note is scoped to `3f4aca6`; the guard that keeps the
> four arms from coming back is `test/arch/range-family-signal.test.ts`.
> We keep `pos-free` by default because line non-overlap ≈ semantic non-overlap for hash-anchored edits; strict would make every exterior `insert @0` abort `B`'s unrelated range, violating `CONTEXT.md:anchor philosophy` and `ADR-0004` healing. Concurrency fallback is automatic, no `supportConcurrency` flag — exterior drift stays `resist`, only overlapping concurrent goes `strict`.

## Considered Options

- **Strict pos always** — would make every exterior insert abort `edit 10..12` after `insert @0`, forcing re-read tax, violating `position-independent` and ADR-0004.
- **Tombstone+canon without pos** — fixes `#31` same-session dense whole-span, but cross-session isolated `S@2->7` shift stays silent (desired for single thread, undesired for strict concurrency).
- **Global file tombstone** — would block reuse for all sessions until any `read`, prematurely cleared by another agent's `read`. Per-session epoch is correct; file `snapshots` stays global last-writer-wins.

## Consequences

- `hash-store.ts:served` adds `canons TEXT` parallel to `hashes` and `tombstones TEXT`; `session-view.ts` adds `loadTombstones/putTombstones` (`withStore` atomic with `hashes+canons`).
- `hash-assign.ts` removes `removedByContent`, adds `tombstone` param to `mapStableHashes`/`lineHashes`.
- `anchor-pipeline.ts:verifyServedRange` keeps candidate enumeration, adds `tombstone` filter and `servedCanons` check, `strict` pos via automatic `changed ∩ [L,R]` (no config).
- Tests: `hashline-stable-mapping.test.ts` "reuses first removed hash" flips to `fresh hash`; new property `identical canon after removal gets ≠ removed hash`.

- Round trips: single-thread exterior drift no longer aborts; a strict/identity rejection records nothing and grants nothing (ADR-0018, T3f), says `Re-read.`, and a retry with the echoed anchors is rejected again — the `Retry with these anchors (no read needed)` hint is gone from every arm (T4 F1–F3; the four then-surviving sites are tombstoned above) while the echo rows remain the current file's anchors, so an echo-retry still rejects at the same site (CP0 G3/H1).

## T4 reconciliation — the two accepted ADRs disagreed; the measurement chose this one

[ADR-0018](0018-exact-position-served-span-verification.md):167-168 asserted _"The recovery is
the re-read the message already instructs."_ The blockquote above asserted the opposite for
four arms: the hint survived, and the echo rows were "the current file's anchors" — i.e. a
retry looked on offer. Both could not be true at `3f4aca6`. Measured through the real tools at
that revision (CP0 G3 → `SR@802`, H1 → `SR@790`): the echo-retry is **rejected
byte-identically at the same site**, and a re-read **applies**. So the measurement chose this
ADR's reading: the echoes are not serves and cannot be a retry. It also chose 0018's sentence
as the target state — after T4's F1–F4 the hint is gone and that sentence is true of every
arm. **No new ADR was written**: a new ADR would have hidden two accepted ADRs disagreeing
instead of naming the disagreement, the evidence, and the resolution.

## Reproduce

The tombstone and the reconciliation are re-derivable from the committed tree:

```
pnpm exec vitest run test/core/range-family-retry-truth.test.ts test/arch/range-family-signal.test.ts --reporter=verbose
node test/tools/mutate-ledger.mjs M1   # span-length arm (CP0 G3 → SR@802): C1 + arch guard RED
node test/tools/mutate-ledger.mjs M2   # unserved-interior arm (CP0 H1 → SR@790): C2 + arch guard RED
node test/tools/mutate-ledger.mjs M3   # unconditional hint: C5 (+ C2) RED
node test/tools/mutate-ledger.mjs M4   # read-free E_STALE_ANCHOR remedy: C3 RED
node test/tools/mutate-ledger.mjs M5   # payload-map field removed: arch guard RED (+ typecheck)
```

The raw G3/H1 tool-path sweeps that measured the echo-retry rejection are the handoff
evidence `.lsz/tmp/handoff/T4/evidence/CP1-sweep-G1-G10-HEAD.txt` (G3) and
`CP1-sweep-H1-H2-HEAD.txt` (H1).
