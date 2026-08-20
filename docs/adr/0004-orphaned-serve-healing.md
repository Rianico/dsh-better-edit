# Orphaned serves: eager heal and content-disambiguated verification

Date: 2026-08-20 (adapted for dsh-better-edit from pi-better-edit)

## Status

accepted (adapted for dsh-better-edit — same hashline algorithm; tool layer is dsh plugin API)

## Context

Orphaned serves accumulated when an external write relocated a line that kept its hash and a subsequent partial re-serve (paged read, echo) wrote the same hash at the new position without nulling the old one. The next `edit` saw `servedPositionsOf(hash) === 2` and failed closed with `E_RANGE_UNVERIFIED`, and the promise of `reject-and-serve` ("retry with these anchors, no read needed") re-served the current range without healing the stale slot — a self-reinforcing loop. Widening the range could not target the stale position blindly.

## Decision

We decided to heal eagerly at the served-state layer and disambiguate lazily at verification, both silently.

### Considered Options

- **Hash-layer detection (re-hash or re-probe on collision with served state)** — rejected: `hash.ts` is pure (content → hash, no I/O, no session). Making it read SQLite on every `lineHashes()` call couples the file invariant (perfect hashing, unique per file) to the session-indexed mirror and adds I/O to the read hot path. Hash uniqueness stays a file property; the mirror is where the duplicate lives.
- **Eager heal only in `patchServed` (null old position when same hash is written at new position)** — would prevent duplicates from persisting after the healing serve, but leaves already-stored duplicates in the DB to fail again on the next verification.
- **Lazy disambiguation only in `verifyServedRange` (enumerate candidate spans where `served[candFrom+k] === fileHashes[startLine-1+k]` and `len === currentLen`, pick closest to current position)** — fixes already-stored duplicates, but leaves the DB dirty between calls, so every future verification still enumerates candidates.
- **Eager heal + lazy disambiguation (chosen)** — `patchServed` nulls the stale position on the next write of the same hash (O(n) scan per patch, no extra I/O), and `verifyServedRange` enumerates content-matching candidates as a fallback for orphans already in the DB. The two reinforce: new orphans never persist, old orphans are still recoverable.
- **Surface healing as model-visible drift** — extend `drift notice` or add `E_REPEATED_ANCHOR` / `E_ORPHANED_SERVE`. Rejected for the single-valid-survives case: hash anchors are position-independent, so an external shift far from the model's intended range is irrelevant to its next edit — the tool correctly resolves `BSQ` via the current `hashIndex`. Surfacing would be noise. Both-valid candidates (genuine ambiguity) would still be drift, but that case is already covered by the existing once-per-episode drift notice if the healed orphan is reported through `scanDrift`'s reported set. A hard reject-and-serve with healed anchors would reintroduce the non-terminating loop.
- **Wipe entire served row on any hash collision / full re-read as heal** — forces the "full re-read ritual" ADR-0001 forbids. Reads are position-specific by design; healing is per-row, not per-file.

## Consequences

- `hash.ts` stays pure; no DB access from the hashing layer. The file's perfect-hashing invariant (same content at two positions → two different hashes) is unchanged; "relocated line keeps its hash" remains the file condition, "orphaning re-serve" (re-serving the same hash at newPos without clearing oldPos) the mirror event.
- `patchServed` now scans `updated` for `hash` at `i != newPos` and nulls it before writing. The next partial re-read that would have created `Wot@0, Wot@2` leaves `[X, Y, Wot]`. No extra I/O; the existing `updated` array is already in memory.
- `verifyServedRange` no longer fails closed on `length !== 1`. It builds `currentLen`, enumerates `(s,e)` pairs with matching length and content equality against `fileHashes`, and picks the span closest to `startLine-1` when multiple survive. Zero candidates → original `E_RANGE_UNVERIFIED`; single → use it (stale-vs-valid disambiguation); multiple → closest. Exterior shifts (both endpoints move together) keep `currentLen` invariant and pass via content match; interior inserts/deletes still fail on length/content mismatch. The healed-orphan case is silent — no drift row, no warning — because the mirror was repaired and the edit's intent is unambiguous.
- Tests: `served-edge-cases` "fail-safes with E_RANGE_UNVERIFIED when duplicate" renamed to "recovers from a stale duplicate by disambiguating" expecting `Successfully edited`; `served-store` truncation test now expects `[null,"ddd","eee","bbb","fff"]` (eager heal nulls the earlier duplicate on the same patch). All 1006 tests pass.
- Glossary: `orphaned serve`, `orphaning re-serve`, and `relocated line keeps its hash` added to `CONTEXT.md` to distinguish duplicated content (two hashes) from duplicated mirror entries (one hash, two positions).
