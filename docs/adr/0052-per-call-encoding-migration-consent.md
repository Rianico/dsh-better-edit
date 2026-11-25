# ADR-0052 — migration is a per-call consent with a UTF-8/BOM target enum

Date: 2026-11-25

## Status

accepted (issue #209; the t1 half of ticket i178-encoding)

Upstream referent: none — downstream-only. `pi-better-edit` carries no encoding model (no
`normalizeToUtf8`, no legacy-codec write path; ADR-0051 records the same finding), so no upstream
commit or upstream ADR corresponds to this consent.

Downstream records: `src/encoding-consent.ts` (the vocabulary, the env parser, the one precedence
resolver), `src/contract.ts` (the payload key, the fold, the refusal), `src/tool-edit.ts` (the wire
declaration), `src/store-config.ts` (`allowEncodingMigration`, the env rung, the cache key),
`src/file-encoding-state.ts` (`prepareForSave`'s consent + target state), `src/fs-bridge.ts`
(`WriteTextOptions.migrationConsent`), `src/mutation.ts` (one resolution per batch),
`src/tool-undo.ts` (the same ladder on a revert, plus the migrated-arm staleness tolerance),
`src/tool-str-replace-editor.ts` (the same ladder on the shadow's save).

## Context

Before this record, whether a write may convert a legacy-encoded file (utf16le, windows-1251, GBK,
…) to UTF-8 was a fleet-wide boolean: `normalizeToUtf8` / `DSH_BETTER_EDIT_NORMALIZE_TO_UTF8`
(ADR-0012 §#112). That is the right default — the write seam is text-only UTF-8, so a non-ASCII
legacy file is otherwise refused with `E_ENCODING_UNWRITABLE` — but it is the wrong granularity for
two real cases:

- **One file, one call.** A model that hit the refusal on a single file had to change fleet policy
  (or drop to a shell) to finish one edit, then remember to change it back.
- **The Windows-readable target.** A migrated file is written as UTF-8 without a BOM, which some
  Windows tooling (Notepad pre-1903 conventions, several legacy build steps) reads as ANSI. The
  fleet boolean can express "convert", but not "convert and write a BOM".

Both are per-write decisions about the same bytes the save seam already judges, so the decision
belongs beside that judgment — without a second write path, and without a new config default that
would silently reinterpret existing installations.

## Decision

**1. One payload key, one enum.** `edit` gains the optional
`allow_encoding_migration: "refuse" | "utf8" | "utf8bom"`. `null` is NOT a spelling of absent
here — the contract table has no null row, so a `null` is refused by name like any other
out-of-enum value; a caller that wants the config to decide omits the key. The enum is UTF-8-ONLY
on purpose: reads stay codec-agnostic, but every write leaves as a UTF-8 text write, so a consent
never names "the codec to write back" — it names whether this write may abandon the recorded codec,
and which UTF-8 shape the migrated bytes get. `"utf8"` = no BOM; `"utf8bom"` = exactly one leading
`EF BB BF`.

**2. A wrong value is refused by name, never dropped.** Two gates, both value-naming. The tool's
declared wire enum (`src/tool-edit.ts`, `type: "string"` with the three members and no null branch)
is the first: dsh answers an `invalid arguments` error before the tool body runs — for an
out-of-enum string that message names the values (`"arguments.allow_encoding_migration" must be one
of ["refuse","utf8","utf8bom"]`), and for a wrong type (`null`, boolean, number) it reports `must
be a string`. Every wrong value is therefore loud at the wire; the enum-naming `E_BAD_PAYLOAD` below
is the layer that names the three values for any wrong value that reaches the contract. At the
contract boundary — library and contract callers that never pass a wire schema — a value outside the
enum (wrong string, number, boolean, object, or `null`) is `E_BAD_PAYLOAD` with a message naming
`"refuse"`, `"utf8"`, `"utf8bom"` and stating that omitting the key lets the config decide. The
refusal is reachable before the normalized-marker guard (the `hasUnusableDryRun` pattern), and again
after it for a hand-built marker record. Dropping the value instead would let a typo silently fall
through to the fleet policy and convert a file the caller meant to protect (or vice versa).

**3. One ladder, resolved once per decision.** Payload (when present) → `allowEncodingMigration`
(when present) → legacy `normalizeToUtf8 === true` → `"refuse"`. `src/encoding-consent.ts` owns the
resolver; every seam calls it rather than re-deriving the order. `normalizeToUtf8: false` is not a
rung: it is the pre-#209 default, so it falls through to `"refuse"` instead of outranking an
explicit `allowEncodingMigration`.

**4. The config key must stay absentable.** `allowEncodingMigration` is a PERMANENT supported
setting (`config.yaml`, `DSH_BETTER_EDIT_ALLOW_ENCODING_MIGRATION`) with NO Zod default, and it is
deliberately NOT added to `complementMissingFieldsSync`. A materialized `refuse` would silently
disable a legacy `normalizeToUtf8: true` in every existing config — the migration would stop
happening on upgrade with no message. Absence is therefore meaningful data: it means "fall through
to the legacy spelling". The generated `config.yaml` documents the key in comments only. The env
rung trims and lowercases (`UTF8` works there); the config file is verbatim, consistent with `eol`.

**5. The save verdict maps the consent to a UTF-8 target.** `prepareForSave` resolves the consent
(`opts.migrationConsent ?? (opts.normalizeToUtf8 === true ? "utf8" : "refuse")`, so direct
callers keep the old option), and on the legacy-recorded arm:

- a **byte-faithful** body (ASCII in a single-byte charset) is written unchanged — no BOM, no
  verdict, no conversion, whatever the consent says; the memo records `{encoding:"utf8",hasBOM:false}`;
- a **non-faithful** body with consent `"refuse"` is still `E_ENCODING_UNWRITABLE` before any write;
- a **non-faithful** body with a converting consent is written as the CHOSEN target (`"utf8"` → no
  BOM, the body unchanged, so a legitimate leading U+FEFF in the caller's text survives; `"utf8bom"`
  → exactly one leading `UTF8_BOM`) and the memo records exactly that target plus the resolved
  `lineEnding` — never the abandoned codec's name.

The verdict `migration: {encoding, hasBOM}` (ADR-0051) rides only the non-faithful arm, so the undo
still names the codec that was abandoned; it names the consent target nowhere, because the memo
already tells the next read what the bytes are.

**6. Idempotence matters because the seam runs twice.** `persistUndoAndWrite` prepares the text,
then `fs-bridge.writeText` re-prepares that same text against a memo that still describes the
pre-write codec. A BOM added by the first pass would be added again by the second, so the
`"utf8bom"` branch strips one leading `UTF8_BOM` from the body before re-adding its own, so
`"utf8bom"` yields `EF BB BF` once, never twice; the `"utf8"` branch writes the body unchanged and
never strips content.

**7. The UTF-8 family is untouched.** A file already recorded as `utf8`/`utf8bom` keeps today's
behaviour: the recorded BOM is preserved, and a consent never adds one. ADR-0012's rule — the BOM is
preserved, never introduced spontaneously — outranks a consent that only speaks about _migrating a
legacy codec_.

**8. A revert resolves the same ladder, and tolerates its own target.** `undo_last_edit` (and the
`str_replace_editor` shadow's save) resolve
`resolveEncodingMigrationConsent(undefined, loadConfig())`, so the fleet setting governs a revert
and a governed write exactly as it governs an edit. After a `"utf8bom"` migration the post-image
bytes carry a UTF-8 BOM the undo pair's pre-image `bom` column does not describe (that column
records the ABANDONED codec's BOM), and a DSH backend restores that BOM on read
(`restoreStrippedUtf8Bom`), so the byte-exact staleness compare would report `E_UNDO_STALE
"modified"` for the tool's own target. The compare therefore also accepts
`stripBOM(currentRaw).text === restoreEndings(undo.resultContent, effectiveEnding)` when the pair
carries `migration`. The restore then writes through the memo (now `utf8bom`), which re-adds
`EF BB BF` — the restored file is the migrated target, and the clause still says the abandoned
codec is not restored.

**9. No store, read, or version change.** No schema column, no `HASH_STORE_VERSION` bump, no
read/lookup-ladder change: the consent is an input to the save verdict, and the only durable record
is the memo the seam already writes (plus ADR-0051's migration columns). `write` and
`str_replace_editor` payloads do not gain the key; the config setting is global, so the IO write
seam and every save-seam caller resolve the same ladder.

## Consequences

- One call can convert one file — and pick the Windows-readable BOM target — without touching fleet
  policy, and `"refuse"` can protect one file in a fleet that has opted in.
- A typo cannot silently convert or protect: it is refused by name.
- Byte-faithful ASCII stays silent and BOM-free at every consent, so the pre-#209 experience for
  that (large) class of legacy files is unchanged.
- A migrated `"utf8bom"` file keeps its BOM after undo: the bytes are the chosen target, and the
  undo clause keeps naming the codec it cannot restore.
- Direct `prepareForSave` callers keep their existing `normalizeToUtf8` option; the new option is
  additive, and `migrationConsent` wins when both are present.
- Fleet installs that never set the new key behave exactly as before: the legacy spelling and the
  `"refuse"` default decide.

## Considered options

- **A boolean payload flag (`migrate: true`) (rejected).** It cannot express the BOM target, and it
  cannot express "protect this file" in a fleet that opted in — the two cases that motivated the
  record.
- **Defaulting the config key to `"refuse"` / complementing it into existing configs (rejected).**
  Every existing `normalizeToUtf8: true` install would stop migrating on upgrade, silently. Absence
  must remain the way the legacy spelling is reached.
- **Naming the abandoned codec in the payload (rejected).** The write seam is text-only UTF-8
  (ADR-0012 §#112); a non-UTF-8 target would need a byte write the bridge deliberately does not own.
  Consent is about whether to convert, not which legacy codec to write back.
- **Handling the consent only in `mutation.ts` (rejected).** The IO bridge and the governed writers
  would then disagree about the fleet policy, and a `"utf8bom"` target would be lost on the
  bridge's second prepare pass (it would fall back to the config rung).

## What this deliberately does not do

- **No `E_ENCODING_UNWRITABLE` change in this record.** Its wording and remedy belong to ticket #210, which rewrites the message and remedy to name the per-call `allow_encoding_migration` value and the standing `allowEncodingMigration` setting (and drops the bare `normalizeToUtf8: true` phrase).
- **No read-side or auto-guess change.** Admission, the lookup ladder and `autoGuessEncoding` keep
  their semantics; a consent is never consulted on a read.
- **No store schema/version change and no new persistence.** The memo describes the bytes actually
  written, as before.
- **No `write` / `str_replace_editor` payload key.** The setting is global for those tools; only
  `edit` can override it per call.

## References

- #209 — the per-call encoding-migration consent (this record); ticket i178-encoding, t1.
- [ADR-0012](0012-vscode-encoding-model.md) — the VS Code encoding model, §#112 (the text-only
  write seam and the refusal) and the #209 amendment (per-call consent).
- [ADR-0051](0051-undo-names-the-abandoned-codec.md) — the migration verdict the undo names.
- [ADR-0047](0047-eol-normalization-normalized-undo-and-the-eol-config.md) — the `eol` ladder whose
  env > config > file > system shape this consent follows (payload > config > legacy > refuse).
- `src/encoding-consent.ts`, `src/contract.ts`, `src/tool-edit.ts`, `src/store-config.ts`,
  `src/file-encoding-state.ts`, `src/fs-bridge.ts`, `src/mutation.ts`, `src/tool-undo.ts`,
  `src/tool-str-replace-editor.ts`, `test/core/encoding-migration-consent.test.ts`,
  `test/tools/edit-wire-shape.test.ts`.
