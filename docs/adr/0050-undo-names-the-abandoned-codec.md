# ADR-0050 — the undo names the codec a migration edit abandoned

Date: 2026-11-25

## Status

accepted (issue #191; the t1 half of ticket i148-encoding)

Upstream referent: none — downstream-only. `pi-better-edit` carries no encoding model, so no upstream commit or upstream ADR corresponds to this disclosure.

Downstream records: `src/file-encoding-state.ts` (`EncodingMigration`, `prepareForSave` verdict),
`src/mutation.ts` (`persistUndoAndWrite` forwarding, `AppliedMigration`), `src/undo-edit.ts`
(`UndoEntry.migration`), `src/hash-store.ts` (`undo`/`file_undo` gain `migrated_from` +
`migrated_from_bom`), `src/tool-undo.ts` (the one disclosure clause).

## Context

A migration edit (`normalizeToUtf8: true` over a recorded legacy encoding — utf16le, windows-1251,
GBK, …) lands UTF-8 bytes where a legacy codec used to be. The revert still writes UTF-8: it never
refuses and never claims the old bytes came back. But before this record the revert said nothing at
all about the codec change, so silence read as restoration — a model that migrated a file and
undid the edit could believe the legacy bytes were back on disk, when the file holds UTF-8.

The disclosure has to name the abandoned codec exactly once, and it has to survive the two gaps
that already exist in this repo: the in-process encoding memo is cleared on restarts (and by any
`clearEncodingState`), and the undo revert re-prepares its text against whatever memo the read
seam currently holds. A verdict kept only in the memo would vanish across exactly the restarts the
undo pair is built to survive.

## Decision

**1. The verdict is taken once, at the save seam.** `prepareForSave` returns an optional
`migration: EncodingMigration { encoding, hasBOM }`, set ONLY on the legacy-recorded arm
(`recorded !== 'utf8' && recorded !== 'utf8bom'`) when the body is NOT byte-faithful under the
recorded codec. The faithful-ASCII arm, the `encodingHint` arm, the no-state arm and the UTF-8
family carry no verdict — a faithful body changed nothing about the codec (its bytes are identical
either way), and the other arms never abandon one. `hasBOM` is the recorded FILE property, never
text-level `stripBOM`: a legacy BOM (utf16le's FF FE) is a byte image a UTF-8 string write cannot
reproduce, so the BOM-ness the undo discloses is the one the file had, not one the text implies.

**2. The verdict is forwarded, never recomputed.** `persistUndoAndWrite` captures `prep.migration`
per file, passes it into `saveUndo` as an optional entry field, and returns `AppliedMigration[]
{displayPath, migration}` (`[]` when no file migrated). The edit itself renders nothing from it —
the disclosure belongs to the revert that restores the content, not to the write that left.

**3. The verdict is durable on the undo pair, not in a memo.** `UndoEntry` gains
`migration?: EncodingMigration`; both store halves (`undo`, `file_undo`) gain additive nullable
columns `migrated_from TEXT` + `migrated_from_bom INTEGER` — DDL plus the idempotent
`addColumnIfMissing` backfill beside the #171 columns, extended INSERT/UPDATE/SELECT and the
`mapFileUndoRow` boundary validation. An old row (both columns NULL) means "not recorded" and
claims nothing; the reader (`getUndo`) rebuilds the verdict only when the stored pair is fully
typed (`typeof migratedFrom === 'string' && typeof migratedFromBOM === 'number'`), else
`undefined`. No destructive migration, no `HASH_STORE_VERSION` bump — same contract as #171.

**4. The revert discloses, never restores.** After the existing mixture clause, `undo_last_edit`
pushes exactly one clause when `undo.migration` is defined:

- `Restored as UTF-8; the pre-edit <codec> encoding and its BOM are not restored.` (`hasBOM`),
- `Restored as UTF-8; the pre-edit <codec> encoding is not restored.` (otherwise),

with `<codec>` the recorded name verbatim. The clause lands in both the single and batch paths via
the existing `parts` array. The revert still writes UTF-8 at the edit's effective ending, still
refuses only on staleness before any disclosure, and never claims the legacy bytes were restored.

## Consequences

- A model that migrates a file knows which codec it abandoned, and a model that undoes the edit
  knows the file is UTF-8 — not the legacy bytes — without re-reading. Both notices are
  model-facing; neither requires a re-read.
- Byte-exactness remains the contract for a faithful-ASCII legacy file and for the UTF-8 family:
  those arms carry no verdict and push no clause, because nothing about the codec changed.
- The undo pair is the verdict's home: a cleared memo, a restart, or a store close + reopen
  changes neither the clause nor the bytes (proven by `test/core/undo-encoding.test.ts`).
- The `E_ENCODING_UNWRITABLE` wording, the read/lookup ladder, config keys, the edit EOL
  contract, anchors/canon, served state and `src/write-hook.ts` are untouched.

## Considered options

- **In-process memo on the undo entry (rejected).** Carrying the verdict only in the encoding memo
  (or on a transient field the store never persists) dies at restart — exactly when the undo pair
  is most needed. Durability on the pair costs two nullable columns and no version bump; the memo
  stays a decode cache, not a migration record.
- **Restoring the legacy bytes on undo (rejected).** The write seam is text-only UTF-8 by
  architecture (#112); re-encoding the revert into the abandoned codec would need a byte seam the
  bridge deliberately does not own, and would reintroduce the silent-transcode class the refusal
  exists to prevent. Disclosure carries the same information at none of that cost.
- **No disclosure (rejected).** Silence after a migration revert reads as "the file is back as it
  was" — a false restoration claim about bytes that no longer exist on disk.

## What this deliberately does not do

- **No `E_ENCODING_UNWRITABLE` change.** The refusal wording, its remedy, and the round-trip
  verdict that produces it are untouched.
- **No read/ladder/config change.** The admission path, the lookup ladder, and the
  `normalizeToUtf8` knob keep their exact semantics; this record only names what the knob's write
  abandoned.
- **No new version bump or destructive migration.** The columns are additive, idempotent, and
  NULL-by-default; `HASH_STORE_VERSION` does not move.

## References

- #191 — the undo-names-the-codec issue (this record); ticket i148-encoding, t1.
- [ADR-0047](0047-eol-normalization-normalized-undo-and-the-eol-config.md) — the normalized-undo
  pattern this follows (verdict at the write seam, durable pair columns, disclosure clause, no
  version bump).
- `src/file-encoding-state.ts`, `src/mutation.ts`, `src/undo-edit.ts`, `src/hash-store.ts`,
  `src/tool-undo.ts`, `test/core/undo-encoding.test.ts`.
