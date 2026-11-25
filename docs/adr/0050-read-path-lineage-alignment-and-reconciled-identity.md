# ADR-0050 — Read-path lineage alignment, raw-hash carry, and reconciled line identity

Date: 2026-11-25

## Status

accepted

Upstream referent: `pi-better-edit@45ebc6e` — _fix(store): align checksum miss and carry anchors across homogeneous runs (#347)_ — which closes upstream `#338`, `#343`, `#344` and `#345`. It lies outside the absorption cursor `0b1934c`; this record states the downstream decision for the three-ticket port only.

Downstream records: `src/snapshot-store/pairing.ts` (`LineageLine`, `pairLineage`, `carryHomogeneousRuns`), `src/snapshot-store/lineage-store.ts` (`latestLineageFor`, `raw_hash` persistence, `pairLineIds` on the shared engine), `src/hashline/hash.ts` (`rawDigest`, `alignToLatestLineage`, `lineHashesAligned`, `HashAlignmentOptions`), `src/hashline/hash-assign.ts` (`rawDigest`, `lineHashesAligned`), `src/file-view.ts` (`NormFile.retiredHashes`, `FileView.retiredHashes`), `src/read-and-serve.ts` + `src/session-view.ts` (`ServeContext.retiredHashes`), `src/mutation/engine.ts` (edit-load alignment + post-write retirement), `src/edit-response.ts` (`driftNotice` omission), `src/constants.ts` (store version 8), `src/snapshot-store/vacuum.ts` (lineage price 52).

## Context

Issue #154 reported that an exterior change to a duplicate line loses a held anchor: the model reads `X/dup/Y/dup/Z`, holds the second `dup`'s anchor, an external writer deletes the first `dup`, and after one successful edit the surviving `dup` no longer answers to its anchor. The cause is not unsafe targeting but identity churn: with no snapshot for the drifted content, a read re-derived every anchor top to bottom, so the surviving twin took the deleted twin's spelling and the held anchor became stale while the refusal path could not name it as deleted.

Anchor identity has two consumers that must agree: the anchors a read serves, and the `line_id`s the store inherits. Two pairing rules would let one line keep its anchor while its identity retires, or the reverse.

## Decision

One pairing owner, two consumers.

- **Pairing.** `pairLineage` = the pin-bounded engine (`pairSnapshots`, unchanged and still fail-closed) followed by `carryHomogeneousRuns`, which fills only the gaps the engine leaves UNPAIRED: the k-th copy of a raw-uniform run answers the k-th copy, a current tail allocates fresh, and prior overflow retires. Gates: the current gap is raw-uniform by digest, and every prior row of the gap holds that canon **and** that raw digest. An absent digest (a legacy row) is no evidence, so the gap stays unpaired.
- **Evidence.** `line_lineage.raw_hash` persists `xxh32` of the raw line beside the canon digest. The canon is trim-only (ADR-0040) and deliberately folds an edge whitespace run, so it cannot separate `"  }"` from `"    }"`; only the raw digest can prove a run holds one spelling. The column is nullable and backfilled in place at open (`HASH_STORE_VERSION` 7 -> 8, downstream's own numbering): a pre-column row reads as no evidence and fails the carry closed, and an older build still refuses a newer store.
- **Read alignment.** On a checksum miss the read retrieves `latestLineageFor(path)` and pairs the buffer against it (`alignToLatestLineage`): a paired line keeps its served anchor, unpaired lines allocate fresh around the carried and retired anchors, and a prior anchor whose canon repeats in the lineage stays blocked so a fresh duplicate cannot reclaim a retired twin's spelling. Absent, empty, or unusable lineage (non-contiguous numbering, an out-of-alphabet or repeated anchor) falls back to fresh allocation; a store fault logs and falls back. Alignment is opt-in per call (`HashAlignmentOptions`): the read sets it, every other `lineHashes` caller keeps its previous allocation. A served mirror that no longer matches is dropped, so the drift read follows the same alignment: `normFromText` reuses `previous` only while its canon-joined content still equals this content's canons, and otherwise the cached snapshot or the lineage decides.
- **Reconciliation.** The read persists the anchors its alignment retired (`NormFile.retiredHashes` -> `FileView` -> `ServeContext.retiredHashes`) inside the serve write: a full read clears the session's retired set first and then re-adds them; a partial read merges them. The edit load opts into the same alignment, blocks the retired anchors for the batch, and queues them for the post-write retirement, so an edit that discovers a deletion retires it with its own overflow.
- **Inheritance.** `pairLineIds` — the single helper behind `commitSnapshot` and `positionsByIdentity` — calls `pairLineage` with the same canon and raw evidence, so anchors and `line_id`s cannot drift apart. Resolution still uses the working-buffer identity map while a batch is in flight (`mutation/engine.ts`); the commit path re-pairs the final content, which is the more identity-preserving answer for a line that survived inside a replaced range.
- **Notice shape.** A clean batch omits `details.driftNotice`; the empty join is "no drift", not an empty notice. An exterior change outside the edited range still reports one.

## Consequences

- A homogeneous shrink or growth edit applies on the surviving ordinal anchor with no intervening read. Only the retired overflow copy fails closed: its anchor is absent from the aligned buffer, so the refusal is `E_STALE_ANCHOR` at resolution; `E_TARGET_LOST` remains the code for a boundary whose anchor resolves but whose leased `line_id` no longer does.
- A deleted twin's anchor is never re-issued: it is blocked within the discovering alignment and persisted as retired by the read that served it or the edit that committed it.
- Cost: one lineage read per checksum-miss read and one extra digest per lineage row. The vacuum price model moved 40 -> 52 bytes/line, derived from a measured 11.02 B/line delta (200k synthetic rows, 10-digit digest, table + unique index, VACUUM'd) rounded to 12 for page granularity.
- Downstream deviations from the referent: no `src/served/*`, `src/file-content/*` or `src/mutation-engine/*` layout — the seams here are `session-view`, `file-view`/`read-and-serve`, and `mutation`; alignment is per-call opt-in rather than a shared loader; the store version is downstream's own 8; the serve-context member keeps downstream's `retiredHashes` vocabulary instead of upstream's `blockedHashes` name (ADR-0028); and this record is ADR-0050 because ADR-0049 is the dry-run preview (#186).
- The absorption cursor does not move; this is a defect-driven targeted port (`0b1934c` unchanged).

## References

- Issue #154 (downstream) and its three downstream tickets #187 (T1 alignment), #188 (T2 carry), #189 (T3 unification/reconciliation); upstream #338 / #343 / #344 / #345, commit `45ebc6e`.
- [ADR-0002](0002-whitespace-insensitive-anchors.md), [ADR-0040](0040-canon-v4-trim-only.md), [ADR-0041](0041-anchor-identity-from-raw-bytes.md) — canon vs anchor identity.
- [ADR-0013](0013-pos-free-roundtrip-optimization.md), [ADR-0035](0035-full-read-authority.md), [ADR-0042](0042-buffer-changed-rejections-are-served-or-absent.md) — full-read verdict and rejection shape.
