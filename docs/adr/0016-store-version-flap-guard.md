# ADR-0016 — Store Version-Flap Guard

Date: 2026-09-23
Status: accepted
Related: `src/hash-store.ts` (`buildStore`), `src/domain-errors.ts` (`E_STORE_NEWER_VERSION`)

## Context

Two `dsh` processes on different plugin versions can share one store file
(mixed-version installs, multi-worktree setups pointing at one `DSH_HOME`).
The old `buildStore` treated any `meta.version` mismatch as invalidation:
`DELETE FROM snapshots`, `DELETE FROM undo`, and `DROP TABLE served` whenever
the stamp differed from `HASH_STORE_VERSION`. A version flap — v6 opens a
store a v7 process just touched, or vice versa — therefore destroyed leases,
lineage, and undo pins that the other version was actively using. That is
data destruction on a healthy store, triggered by nothing more than opening
it with the "wrong" build.

## Decision

Store open is now non-destructive and version-guarded:

- **Additive, idempotent schema on every open** (`ensureSchema`): `CREATE
  TABLE IF NOT EXISTS` for the current shapes, `addColumnIfMissing` backfill
  for newer `served` columns. `DROP TABLE served` fires only for the
  pre-session-keyed shell (no `session_id` — unusable by either version).
  No `DELETE FROM` anywhere on this path.
- **One atomic forward migration** (`migrateForward`, `BEGIN IMMEDIATE` …
  `COMMIT` with `ROLLBACK`): runs only when the stamp differs from
  `HASH_STORE_VERSION`, and is the sole writer of `meta.version`. CP1 has no
  data steps — it advances the stamp; CP2/CP4 add ordered data statements
  inside the same transaction.
- **Fail closed on a newer store**: a read-only probe (`storedVersion`, two
  `SELECT`s, no DDL/PRAGMA/`run()`) runs before any write; when the stamp is
  newer than this build supports, `buildStore` throws the typed model-facing
  `E_STORE_NEWER_VERSION` with zero writes — no PRAGMA, no DDL, no version
  overwrite, no quarantine (`isCorruptionError` returns `false` for any
  `DomainError`, so `openStore` rethrows instead of renaming the file to
  `.corrupt-<ts>`).
- **v6 shells retained**: the `retired`-column one-shot wipe stays (CP4
  retires it); `HASH_STORE_VERSION` stays `6`; no v7 tables yet.

## Rejected alternative: upstream's silent forward-overwrite

Upstream `buildStore` is also additive and never wipes on mismatch, but it
writes `meta.version` unconditionally — so an older build opening a newer
store silently downgrades the stamp while leaving newer-schema rows it cannot
read in place. We diverge deliberately: a newer store is unavailable to this
build rather than silently downgraded. The cost is availability (this build
cannot use a v7-touched store until upgraded); the payoff is that no build
ever corrupts a store it does not understand. The refusal message states the
fact, states that nothing was written, and names the two recoveries (upgrade,
or point the store elsewhere).

## Consequences

- The released v6 build keeps working against its own shells; a v7 store is refused
  loudly instead of wiped or downgraded.
- v7 state stays isolated in v7 tables once CP2 lands (the guard is what makes
  that isolation safe from this build's side of the flap).
- `E_STORE_NEWER_VERSION` joins the closed domain-error registry (audience
  `MODEL`, with remedy); its message must never contain corruption-class words
  (`corrupt`, `not a database`, `malformed`, `database disk image`), enforced
  by the quarantine-guard test, or a valid newer store would be quarantined.
- The in-transaction stamp re-check is defensive: it has no deterministic interleaving test at CP1; its refusal logic is shared with the probe-time refusal covered by T1.

## Schema v7

Bump `HASH_STORE_VERSION` 6 → 7 with six new tables, all additive:

- `file_snapshots` — content-addressed snapshot headers (`UNIQUE (path, snapshot_hash)`).
- `line_id_counters` — per-path stable line-id allocation.
- `line_lineage` — per-snapshot line identity and canon hashes, `FOREIGN KEY (snapshot_id) REFERENCES file_snapshots` with `ON DELETE CASCADE`.
- `file_undo` — v7 undo pins (carries an optional `snapshot_hash`).
- `served_leases` — per-session served-line leases with position and retirement.
- `served_session_meta` — per-session, per-file reported state.

Shell-retention contract: the v6 shells (`snapshots`, `undo`, `served`) keep their exact v6 shapes — in particular `served.cards`, which the released v6 build names at store open — so an un-restarted v6 session or a concurrent v6 worktree never hits a missing table or a dropped column. A v6 process wipes only its own shells and never names the v7 tables, which is what makes the flap survivable. Version boundary: stamp 7 opens (migrating forward when older); stamp 8 is refused with `E_STORE_NEWER_VERSION`.
