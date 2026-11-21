# ADR-0041 — Anchor identity from the raw bytes; the canon becomes alignment-only

Date: 2026-11-21

## Status

accepted (amends [ADR-0002](0002-whitespace-insensitive-anchors.md)'s derivation half — its strip no longer derives anchors; records the deliberate downstream divergence from upstream ADR-0013; narrows the upgrade boundary [ADR-0017](0017-content-addressed-line-identity.md) recorded as "an upgrade must never destroy snapshot/undo rows")

## Context

One digest answered two questions at once. `canon(line)` plus `canonDigest(line) = xxh32(canon(line))` was both the anchor's derivation base — "which 3-char spelling does this line own?" (identity) — and the pairing/verification evidence — "did this line survive a reformat?" (alignment). [ADR-0002](0002-whitespace-insensitive-anchors.md) decided the strip; [ADR-0040](0040-canon-v4-trim-only.md) narrowed it to trim-only. Under trim-only canon, two lines that differ only in their edge whitespace runs are still canon-equal, so they share one derivation base and the allocator falls back to its positional probe for the second and third: measured on `['const a = 1;', '\tconst a = 1;', '   const a = 1;  ']` in one file, the anchors were `7rq`, `8sr`, `9ts` — `8sr` and `9ts` are probe offsets that depend on the line's siblings, not identities of the line's own bytes.

The same coupling produced the upstream #233 symptom downstream: a canon-unchanged edit (the replacement moves an edge run only) re-derived from the canonical base and served a probe spelling for the line it had just written, so the post-edit diff row and a fresh re-read disagreed with the line's own `lineHashes(onDisk, path)`.

Anchor spelling stayed coupled to formatting tolerance, and that coupling is what failed: identity has to name the bytes the model sees, while alignment has to survive a formatter moving the edges.

## Decision

Anchor identity keys on the line's RAW materialized line. The load path strips the BOM and normalizes CRLF/CR to LF before hashing, so "raw" means byte-for-byte as the model sees the line; the derivation itself is unchanged in shape — `lineHashesPure` and `mapStableHashes`' fresh allocation seed on `(xxh32(line) >>> 14) % HASH_SPACE` instead of `(xxh32(canon(line)) >>> 14) % HASH_SPACE`. The base is a function of the line's own bytes, so a line's spelling no longer depends on its siblings.

Survivor pairing keys remain on `canon` — a deliberate downstream divergence from upstream ADR-0013, which keys pairing on raw bytes too. `mapStableHashes`' survivor index still matches by canon, so a re-indent lets an untouched line inherit its anchor and the lease survives edge-whitespace churn; what rotates is the spelling, never the held anchor's validity. Upstream folds the edge-whitespace class out of identity and out of pairing; downstream keeps pairing canon-keyed because that is the edge-whitespace formatter tolerance #135 pins.

`canon`/`canonDigest` are unchanged in definition and now carry one role only: the ALIGNMENT and VERIFICATION digest (snapshot pairing, served-evidence comparison, `line_lineage.canon_hash`, `served_leases.canon_hash`).

`ANCHOR_GENERATION` is introduced at 2 — generation 2 seeds on raw bytes, generation 1 (every pre-generation-2 row) seeded on the canon; the number means the same thing upstream and downstream, and downstream had no such axis before. It tracks exactly the pieces that decide which 3-char spelling a raw line derives: the content seeding (`xxh32(line)` -> base index, downstream has no path seed), the width/space (`HASH_LEN`, `ALPH`, `HASH_SPACE`) and the probe stride. Cache keys carry both axes, `${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}` (`cacheKey` in `src/snapshot-store/index.ts`, `snapshotHashFor` in `src/snapshot-store/lineage-store.ts`), and `isCurrentGenerationSnapshotHash` splits on `:` and compares both components — a prefix-only test would bless the retired two-part shape `<canon>:<checksum>` whose second component is a checksum, not a generation.

### Considered Options

- **Also key survivor pairing on raw bytes (upstream's choice)** — rejected downstream because it breaks the edge-whitespace formatter tolerance #135 pins: a re-indent would rotate every anchor and pair nothing, so an untouched line would lose its `line_id`. Pairing stays canon-keyed; only fresh allocation moved to raw bytes.
- **Bump `CANON_VERSION` instead of introducing `ANCHOR_GENERATION`** — rejected because the canon did not change. Overloading one axis would make every canon-only change (a trim-class edit) reclaim anchor-bearing rows, when a canon-only change must stay a plain cache miss.
- **Add a per-row generation column** — rejected because it needs a schema migration. The constraint is "version axes live in cache keys only": no schema version bump, no column, no backfill.

## Consequences

- Every anchor-bearing artifact is invalidated once, because the spelling of every line changes. Snapshot rows, lineage, leases, undo pairs and the session `served` mirror were minted under generation 1.
- The undo gate refuses a foreign-generation pin and deletes the pair: `getUndo` checks the v7 `snapshot_hash` with `isCurrentGenerationSnapshotHash`, and on a miss deletes the `undo`/`file_undo` pair and returns no entry, so `undo_last_edit` reports `No undo history` rather than replaying stale anchors. Pre-change anchors are never replayed onto content this build derives differently.
- An open-time sweep reclaims foreign-prefix rows and clears `served`, under a `meta` stamp (`anchor_generation` = `${CANON_VERSION}:${ANCHOR_GENERATION}`): `sweepForeignAnchorGeneration` in `src/hash-store.ts` runs after `migrateForward` and the `served.retired` backfill, in one `BEGIN IMMEDIATE`, deleting foreign-prefix `snapshots`, `file_snapshots`, orphan `line_lineage`, foreign `served_leases`, foreign `undo`+`file_undo` pairs, and `served` wholesale (no per-row marker exists without a migration). It is idempotent — a stamped store is a no-op on every later open — and it needs no schema change.
- That narrows [ADR-0017](0017-content-addressed-line-identity.md)'s "an upgrade must never destroy snapshot/undo rows": it never destroys them for SCHEMA reasons, and a generation change now reclaims anchor-bearing rows because those anchors denote different lines.
- Anchor resolution at the write seam consults the lease for a `not_found` anchor whose recorded canon still matches: `leaseAnchorLineResolver` in `src/hashline/anchor-pipeline.ts` requires a single serve of that anchor, a non-retired lease, a rebased line inside the file, and canon equality between the rebound line and the served canon. Ambiguous, retired, missing and out-of-range decline the same way.
- The served-evidence verifier compares the recorded canon when the served anchor differs at an unchanged position (`verifyServedRange` in `src/hashline/served-evidence.ts`); a canon change still rejects, and a missing canon record keeps the strict anchor equality.
- Identity is not widened: a canon change still rejects (`[E_STALE_ANCHOR]` inside the batch envelope for the merged-token case), an ambiguous anchor is never resolved through a lease, and an unresolvable anchor is still refused rather than fuzzy-matched.
- No payload, config, error-code or schema change.
- Accepted cost, harder to reason about: a model that re-reads a re-indented file sees different anchors for the same lines. The lease keeps the held anchor valid, but the spelling the model saw is no longer the spelling the file derives — a chained edit must use the served (pre-reformat) anchor or re-read.

### Measurement

Three canon-equal edge-whitespace lines, derived standalone (one line in one file) and in one shared file, before and after this decision:

| Fixture                                                                       | Standalone before | Standalone after | In one file before | In one file after |
| ----------------------------------------------------------------------------- | ----------------- | ---------------- | ------------------ | ----------------- |
| `['const a = 1;', '\tconst a = 1;', '   const a = 1;  ']`                     | `7rq 7rq 7rq`     | `7rq nzW olD`    | `7rq 8sr 9ts`      | `7rq nzW olD`     |
| `['\tString s = "a b";', '    String s = "a b";', 'String s = "a b";      ']` | `nXf nXf nXf`     | `Rw6 p9w z8c`    | `nXf oYg pZh`      | `Rw6 p9w z8c`     |

Before, the canon-keyed allocator gave every member of a trio the same base and made the 2nd/3rd depend on their siblings (standalone they collided onto `7rq`/`nXf`, in-file they probed to `8sr`/`9ts` and `oYg`/`pZh`). After, the in-file spelling equals the solo spelling for every member: identity is a function of the line's own bytes.

The #233 symptom is fixed: a canon-unchanged edit (an edge-run rewrite) serves the written line's own anchor — the post-edit diff row and a fresh re-read both equal `lineHashes(onDisk, path)`, and the pre-edit spelling no longer reappears for the line it just replaced. Pinned by `test/core/anchor-raw-identity.test.ts` (the `const a = 1;` trio's solo/in-file equality and `ANCHOR_GENERATION === 2`; the second trio is the same probe on a literal-bearing line), `test/integration/anchor-identity-tool-seam.test.ts` (the diff/re-read equality, the re-indent application through the lease, and the merged-signature rejection) and `test/core/undo-generation-gate.test.ts` (the undo gate plus the open-time sweep, including idempotence).
