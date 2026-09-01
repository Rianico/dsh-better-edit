# ADR-0013 — Pos-free round-trip optimization with concurrency fallback

Date: 2026-09-01

## Status

accepted

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

Makes `shift==rebind` loud only when `changed` overlaps target, not when exterior. Cost is one `edit` retry via `reject-and-serve` (no `read`), rare (`~1/238k`).

### 4. Non-overlapping forever is pos-free

`A:10..12 +1 line` shifts `B:20..30->21..31`. `B`'s `served 20..30 == file 21..31` still `candidates==1` -> pass. Non-overlapping spans never abort in `resist`.
## Single vs Multi-session

|  | Single-session (serial `read->edit*` per `sessionKey`) | Multi-session (concurrent `A`+`B`) |
|---|---|---|
| Read-set | `epoch==curId` → no concurrent writer | `epoch!=curId` → concurrent `changed` detected |
| Non-overlapping `A:10..12+1` shifts `B:20..30→21..31` | `pass` — candidates `hash==` still `1`, `tombstone∉` | `changed ∩ [L,R]==∅` → `resist` → `pass` (drift notice, not abort) |
| Overlapping `S@3 reborn @3` whole-span | `tombstone` blocks allocation → `E_STALE_ANCHOR` | `changed ∩ [L,R]!=∅` → `strict from==pos` → `E_RANGE_STALE` |
| Cost | `pos-free` — zero extra round trips | May incur one `edit` retry via `reject-and-serve` (`E.servedRows` already re-serves, no `read` needed) |

We keep `pos-free` by default because line non-overlap ≈ semantic non-overlap for hash-anchored edits; strict would make every exterior `insert @0` abort `B`'s unrelated range, violating `CONTEXT.md:anchor philosophy` and `ADR-0004` healing. Concurrency fallback is automatic, no `supportConcurrency` flag — exterior drift stays `resist`, only overlapping concurrent goes `strict`.
## Considered Options

- **Strict pos always** — would make every exterior insert abort `edit 10..12` after `insert @0`, forcing re-read tax, violating `position-independent` and ADR-0004.
- **Tombstone+canon without pos** — fixes `#31` same-session dense whole-span, but cross-session isolated `S@2->7` shift stays silent (desired for single thread, undesired for strict concurrency).
- **Global file tombstone** — would block reuse for all sessions until any `read`, prematurely cleared by another agent's `read`. Per-session epoch is correct; file `snapshots` stays global last-writer-wins.

## Consequences

- `hash-store.ts:served` adds `canons TEXT` parallel to `hashes` and `tombstones TEXT`; `session-view.ts` adds `loadTombstones/putTombstones` (`withStore` atomic with `hashes+canons`).
- `hash-assign.ts` removes `removedByContent`, adds `tombstone` param to `mapStableHashes`/`lineHashes`.
- `anchor-pipeline.ts:verifyServedRange` keeps candidate enumeration, adds `tombstone` filter and `servedCanons` check, `strict` pos via automatic `changed ∩ [L,R]` (no config).
- Tests: `hashline-stable-mapping.test.ts` "reuses first removed hash" flips to `fresh hash`; new property `identical canon after removal gets ≠ removed hash`.

- Round trips: single-thread exterior drift no longer aborts; concurrency strict aborts only on `read-set stale`, retry uses `E.servedRows` without `read`.
