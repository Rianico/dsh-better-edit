# ADR-0036 — One writer, one serialization for the retired-anchor column

Status: Accepted (ticket arch-T4, lane `arch-impl-candidates`).
Related: [ADR-0013](0013-pos-free-roundtrip-optimization.md) §2 — the tombstone/retired
allocation invariant this column exists for; [ADR-0017](0017-content-addressed-line-identity.md) —
content-addressed line identity, the reason a retired hash (not a position) is what is held;
[ADR-0035](0035-full-read-authority.md) — the full-read verdict that owns the one legitimate bulk
clear (`clearRetiredAnchors`).
Downstream records: `src/session-view.ts` (`addRetiredAnchors`, `retireAnchorsInStore`,
`retireAnchors`, `unretireAnchorsInStore`, `sweepAndRetire`), `src/hash-store.ts`
(`parseRetiredJson`, `getRetiredAnchors`, `getRetiredEntries`), `test/core/served-store.test.ts`
(the new cell in `served state — incremental hazard sweep`).

## Context

The `served.retired` column had two writers and two serializations.

- `sweepAndRetire` and `unretireAnchorsInStore` read and write `RetiredEntry[]` —
  `{hash, deathPos}` objects (`src/session-view.ts`: `sweepAndRetire`, `unretireAnchorsInStore`).
- `addRetiredAnchors` — the writer behind `retireAnchorsInStore`, i.e. the edit path
  (`src/mutation.ts:276`) and the undo path (`src/tool-undo.ts:274`) — read the read-side
  **projection** `store.getRetiredAnchors(...)` (a `Set<string>`, positions already gone) and wrote
  it back as bare strings:

```ts
const retired = store.getRetiredAnchors(sessionKey, path);
for (const hash of additions) {
  if (!HASH_RE.test(hash)) throw new TypeError(`Invalid retired hash: ${hash}`);
  retired.add(hash);
}
// Persist as legacy string array for backward compat; `sweepAndRetire` writes object
// entries (hash + deathPos) for positions the served view displaced.
store.upsertRetiredAnchors(sessionKey, path, JSON.stringify([...retired]));
```

`parseRetiredJson` (`src/hash-store.ts`) still reads those bare strings — `isValidHashList` ⇒
`parsed.map(h => ({ hash: h, deathPos: null }))` — which is right for legacy rows and wrong as a
write shape. A `null` death position is by design never swept incrementally: `sweepAndRetire` keeps
`e.deathPos === null` unconditionally (`src/session-view.ts`: `sweepAndRetire`'s
`deathPos === null` clause), so such an entry waits for a full-read serve or major-GC promotion.

The consequence, measured on `e9e5dc2` with 6-line file, seeds
`retired = [{hash: "AAA", deathPos: 2}]` and `cards = [2]`, then one appending retirement
(`retireAnchors(sessionKey, path, ["BBB"])`):

| stage                                   | `getRetiredEntries` before fix                                    |
| --------------------------------------- | ----------------------------------------------------------------- |
| after the appending retirement          | `[{"hash":"AAA","deathPos":null},{"hash":"BBB","deathPos":null}]` |
| after a partial serve re-observing `#2` | `[{"hash":"AAA","deathPos":null},{"hash":"BBB","deathPos":null}]` |

So one edit-path retirement silently converted the **whole column** — every earlier entry included —
into the unsweepable shape, and the incremental hazard sweep was dead for that `(session, path)` from
then on. The hazard set grows monotonically until a full read: the accumulation-until-full-read leak.
Pre-fix expectation vs. reality in the pin: `expected [ { hash: 'AAA', deathPos: 2 }, … ]` received
`{ "deathPos": null, "hash": "AAA" }`; the sweep half then reported
`expected [ 'AAA', 'BBB' ] to deeply equal [ 'BBB' ]`.

## Decision

1. **One writer reads entries.** `addRetiredAnchors` reads
   `store.getRetiredEntries(sessionKey, path)` instead of the `getRetiredAnchors` projection, and
   builds a `Set` of known hashes for dedupe.
2. **New hashes are appended as `{hash, deathPos: null}` objects** — an appended retirement has no
   known death position, so it says so, while every existing entry keeps its own `deathPos`. The
   column is written back as `JSON.stringify([...existing, ...appended])`.
3. **Validate before dedupe.** Every incoming hash is checked against `HASH_RE` first and throws the
   same `TypeError("Invalid retired hash: …")` as before, whether or not the hash is new.
4. **Idempotent retirement does not write.** When nothing was appended, the row is not upserted —
   re-retiring a known hash must not bump the row's timestamp.
5. **Legacy strings stay readable, no migration.** `parseRetiredJson`'s coercion is unchanged, so a
   pre-fix row (bare strings, or a mix) still loads; the next `sweepAndRetire` /
   `unretireAnchorsInStore` / appending write re-serializes it as objects.
6. **`getRetiredAnchors` remains the projection.** It is what the read side (`loadRetiredAnchors`)
   consumes; it is not a write source. No store API, no caller, and no other seam changes.

## Consequences

- A death position survives an appending retirement, so the incremental sweep can still free that
  entry when its position is re-observed. The pin for this is the new cell in
  `test/core/served-store.test.ts` (`served state — incremental hazard sweep`), which asserts both
  halves: `AAA` keeps `deathPos: 2` next to `{BBB, null}` after the retirement, and a genuinely
  partial serve re-observing position 2 frees `AAA` entirely.
- The edit path and the undo path both inherit the fix — they never touch the column directly, only
  `retireAnchorsInStore` (which is `addRetiredAnchors`) — so the two remaining call sites needed no
  change (`src/mutation.ts:276`, `src/tool-undo.ts:274`).
- Per-session scoping and the hazard-card rule are unchanged: a retirement is still per
  `(session, path)`, and an entry is still freed only when its death position's hazard card exists
  (`GLOSSARY.md`: `retired anchor`, `retired entry`, `hazard card`).
- A legitimately `null` entry — a legacy row that has not been re-serialized yet, or an entry
  appended from the edit/undo path — still waits for a full read. That is by design and stays: the
  edit path genuinely does not know where the freed anchor died, and inventing a position would let
  the sweep free a hash a page never re-observed.
- The defect was a write shape, not a read shape: nothing about how the column is parsed, projected,
  or scoped changed.

## Rejected alternatives

- **Make `getRetiredAnchors` return entries.** It is a projection the read side consumes
  (`loadRetiredAnchors` → the anchor reservation set), and it is the only caller's contract. Widening
  a read seam to serve a writer puts the positions back in the business of a reader that has no use
  for them; the writer should read the entries it intends to write.
- **Keep writing strings and carry a side map of positions.** Two serializations again — the exact
  defect, only with more state to keep in sync and a new way for the two to disagree.

## References

- [ADR-0013](0013-pos-free-roundtrip-optimization.md) §2 — the retired/tombstone allocation
  invariant (`used = bitset(oldHashes) ∪ bitset(retired)`), whose lifecycle is "edit: add; undo:
  add-and-revive; full read: clear; partial: keep".
- [ADR-0017](0017-content-addressed-line-identity.md) — line identity is content-addressed, which is
  why the column holds hashes and why a death position is metadata, not the key.
- [ADR-0035](0035-full-read-authority.md) — the full-read verdict; the one legitimate bulk clear.
- `GLOSSARY.md` — `retired anchor`, `retired entry`, `hazard card`.
