# ADR-0047 — EOL normalization, normalized undo, and the `eol` config

Date: 2026-11-24

## Status

accepted (port of upstream `pi-better-edit@aa10e61` — _feat(eol): normalize line endings and preserve exact cut reverts (#318)_ — and its upstream ADR-0019 §1–§4; the downstream deviations are named below)

Upstream referent: `pi-better-edit@aa10e61`, upstream `docs/adr/0019-eol-rewrite-normalized-undo-and-the-eol-config.md` §1–§4. Upstream's §5 (cut forward writes normalize; a correlated foreign-cut revert and next-run repair stay byte-exact) and §6 (the `write` hook is untouched) have no downstream carrier: this repo never absorbed the cut transaction, so there is no cut forward/revert/repair path to special-case, and its `write` hook remains a served-hash guard that this record does not touch. Every upstream issue number in ADR-0019 (`#318`) maps here to #147's four tickets — #168 (config/resolver), #169 (edit normalization), #170 (read disclosure), #171 (normalized undo) — and this record is the decision record for the lane that lands them (task #172).

Downstream records: `src/eol-config.ts` (`resolveEffectiveEol`, `resolveEffectiveEolFromCounts`, `countLineEndings`, `dominantEnding`, `changedTerminatorCount`, `terminatorKindsUsed`, `endingName`), `src/store-config.ts` (`EOL_SETTINGS`, `EOL_DEFAULT`, `EOL_ENV_VAR`, `parseEnvEolSetting`), `src/mutation/engine.ts` (`effectiveEnding`, `preImageMixed`, `eolRewriteWarning`), `src/mutation.ts` (the warning is pushed only after the write landed), `src/read-and-serve.ts` (`mixedEolWarning`), `src/file-view.ts`/`src/file-encoding-state.ts` (`endingCounts` out of `normFromText`; `PrepareForSaveOptions.lineEnding`), `src/hash-store.ts` (`undo`/`file_undo` gain `effective_ending` + `pre_image_mixed`), `src/tool-undo.ts` (restore and mixture clause), `src/domain-errors.ts` (`W_EOL_REWRITTEN` applied tier, `W_MIXED_EOL` read tier).

## Context

`edit` already wrote one line ending per file, but the ending was `detectEnding`'s answer — the FIRST separator in the pre-image — and it was never named. A file that spelled LF and CRLF lost the mixture on its first edit with no disclosure at all, `read` never mentioned the mixture it was about to destroy, and `undo_last_edit` replayed the pre-image at `detectEnding`'s answer, which for a mixed file is neither what the edit wrote nor what the file holds. Three consequences followed: a model could not tell that its write had re-spelled bytes, a user could not tell that a mixture existed before it vanished, and a revert of a uniform file could land at a different ending than the edit it was undoing (staleness then reported an intact file as externally modified).

Mature editors do not preserve per-line mixtures, and none of their undo stacks reintroduce one: VS Code normalizes chunks to the dominant EOL when the text model is created and again on save, JetBrains converts to LF at load and writes the detected separator on save while its `Inconsistent line separators` inspection warns about mixed files, Sublime Text normalizes in memory on open. Upstream ADR-0019 §Considered Options rejects per-line preservation, a forced system ending, byte-exact ordinary undo, and `.editorconfig` parsing for the same reason: disclosure of the applied normalization carries the same information at a fraction of the cost.

## Decision

**1. One effective EOL per write, resolved from one decode.** Every `edit` writes exactly one terminator, resolved by this ladder:

| Rung     | Value                                                              |
| -------- | ------------------------------------------------------------------ |
| `env`    | `DSH_BETTER_EDIT_EOL` when it parses to a valid setting            |
| `config` | the `eol` key in `$DSH_HOME/plugins/dsh-better-edit/config.yaml`   |
| `file`   | the pre-image's most frequent terminator kind (ties: LF, CRLF, CR) |
| `system` | `\r\n` on `win32`, `\n` elsewhere — only when the file spells none |

`eol` is an enum `AUTO | LF | CRLF | CR`, default `AUTO` (`src/store-config.ts`); `AUTO` continues to the `file` rung, a forced value names its own rung and stops. A valid `env` value also stops the ladder — `env: AUTO` means "file", never "fall through to config" — so the two rungs can never both claim a write. Env spellings are case-insensitive; an out-of-enum value is ignored with one `console.warn` and the lower rung decides.

The counts are taken ONCE, at `normFromText`, where the raw pre-image is decoded (`LineEndingCounts`), and that one scan feeds the ending choice, the mixed verdict and the rewrite count together — so the read disclosure, the write, and the applied warning cannot disagree about the same file. `detectEnding`'s first-separator rule is no longer the write decision; nothing else about anchors changes (see "does not do" below).

**2. `[W_MIXED_EOL]` — the read discloses the mixture it is about to lose.** A read page whose raw pre-image spells more than one terminator kind ends with one line, after its rows (and after the UTF-8 / serve notes) separated by a blank line:

```text
[W_MIXED_EOL] Mixed EOL: 12 CRLF, 3 LF, 1 CR. All edits normalize to CRLF (file).
```

- It has its OWN read tier: the header is bare `[<CODE>]`, with no `[MODEL]`/`[USER]` audience prefix, because a read notice reports state observed before any write and addresses nobody (`formatReadWarning`; ADR-0014's audience oracle guards the applied tier only).
- The counts are whole-file by construction — `normFromText` counts the raw pre-image once — so `offset`, `limit` and `windows` change which rows render, never which counts are reported. Kinds with a zero count are omitted, never spelled `0`; the order is fixed `CRLF`, `LF`, `CR`.
- The target and its `(source)` come from the same resolver the write uses, so the read can only name the rung the edit will name.
- It is CHROME: appended to the response `text`, never a served row, never part of a page's file content, never an anchor.

**3. `[MODEL] [W_EOL_REWRITTEN]` — a write that re-spells terminators says so.** When the pre-image spelled at least one terminator that the write re-spells, the applied result carries exactly one line:

```text
[MODEL] [W_EOL_REWRITTEN] EOL normalized to CRLF (file): 3 terminators changed. Undo restores normalized content.
```

`changed` counts pre-image terminators at a kind other than the effective one; the kept ones count zero, and a terminator a NEW line introduces was never in the pre-image and is never counted. The warning is pushed only after the write landed: an all-noop call rewrites nothing and claims nothing. It fires for a config- or env-forced rewrite of a UNIFORM file too — that read stays silent, and the edit names the rung the read had no reason to mention. `write` and `str_replace_editor` never pass the resolved ending, so their bytes are unchanged.

**4. Ordinary undo is normalized, and says when a mixture was lost.** `undo_last_edit` restores the pre-edit content at the ending the EDIT used, compares staleness against that same ending, and, when the pre-image was mixed, states `Restored at CRLF; the pre-edit mixture is not restored.` — a uniform revert pushes no such clause, because its bytes are identical to the pre-edit file. The undo pair (`undo` and `file_undo`, both halves) records `effective_ending` and `pre_image_mixed`:

- additive, nullable columns added by the idempotent `addColumnIfMissing` on both tables — no row rewrite, no `HASH_STORE_VERSION` bump, no destructive migration;
- an old row (both columns `NULL`, indistinguishable from a store that never had them) falls back to `ending` and never claims a mixture; the reader owns the fallback (`undo.effectiveEnding ?? undo.originalEnding`);
- the restore is named twice on purpose — as `PrepareForSaveOptions.lineEnding` for the prepared text and again on the `writeText` call — because the IO seam re-prepares against an encoding memo that still describes the PRE-edit ending, and an unnamed override would be re-spelled back to it.

## Consequences

- The README's "Persisted Undo" promise changes from "exact line endings" to "the previous content at the effective EOL; BOM and anchors restored; a pre-edit mixture is not restored and is disclosed". Byte-exactness remains the contract for a uniform pre-image, which is what ordinary files are.
- A model that read a mixed file knows the write will normalize it and which rung decided; a model that wrote one knows the bytes changed and that its undo returns normalized content. Both notices are model-facing; neither requires a re-read.
- The mismatch class is gone where `detectEnding` and the write disagreed: a mixed pre-image no longer reverts at a third spelling, and an intact file no longer reads as externally modified after an ordinary undo.
- The anchor canon still folds CRLF/CR to LF and anchor identity still derives from the line's raw bytes, so an EOL rewrite moves no anchor; `CANON_VERSION = 4` (ADR-0040) and `ANCHOR_GENERATION = 2` (ADR-0041) are untouched.
- Config gain: `eol: AUTO` is seeded into the config template and complemented into an existing file like any other key (`config complement`); the env override joins the existing `DSH_BETTER_EDIT_*` family.
- The ladder is measured end to end by `test/integration/eol-matrix.test.ts`: three mixed majorities, three uniform endings and a zero-terminator file (which is the only way the `system` rung is reached), plus the `env` > `config` > `file` precedence on one mixed fixture, with the per-concern specs in `test/core/eol-config.test.ts`, `test/core/eol-write.test.ts`, `test/core/read-mixed-eol.test.ts` and `test/core/undo-eol.test.ts`.

## What this deliberately does not do

- **No per-line preservation.** Untouched lines are re-spelled with the rest of the file; the disclosure, not a per-line terminator map, is the mitigation.
- **No project/global config ladder.** Downstream keeps ONE YAML config (`$DSH_HOME/plugins/dsh-better-edit/config.yaml`), so upstream's `settings.json` env > project > global > default ladder collapses into `env` > `config`. The source vocabulary is `env | config | file | system` — not upstream's `project | global`.
- **No `.editorconfig`.** Unread, as upstream v1. A future request may add it as a lower rung.
- **No cut transaction and no `raw_pre`.** This repo never absorbed upstream's cut forward/revert/repair path, so ordinary undo is the only undo surface and no byte-exact revert arm exists to preserve.
- **No `write` change.** The write hook stays a served-hash guard; a file created by `write` keeps the writer's own endings. The zero-terminator `edit` case is the only "new file" surface this decision owns, and it uses the `system` rung.
- **No anchor change.** Canon and anchor generation are not touched; an EOL rewrite is invisible to anchors by construction.
- **No new version bump or migration.** The undo columns are additive and idempotent; `HASH_STORE_VERSION` does not move.

## References

- #147 — the end-to-end EOL issue; #168 (config + resolver), #169 (edit normalization + `W_EOL_REWRITTEN`), #170 (read `W_MIXED_EOL`), #171 (normalized undo + mixture clause), #172 (matrix + docs).
- Upstream `pi-better-edit@aa10e61` — _feat(eol): normalize line endings and preserve exact cut reverts (#318)_; upstream ADR-0019 §1–§4 (decision text adopted), §5–§6 (no downstream carrier).
- [ADR-0040](0040-canon-v4-trim-only.md) — canon v4, trim-only: the alignment digest an EOL rewrite leaves alone.
- [ADR-0041](0041-anchor-identity-from-raw-bytes.md) — anchor identity from the line's raw bytes: why re-spelled terminators move no anchor.
- [ADR-0014](0014-user-model-audience.md) — the user/model audience split and the warning registry `W_EOL_REWRITTEN` rides; the read tier is separate by contract.
- `src/eol-config.ts`, `src/store-config.ts`, `src/mutation/engine.ts`, `src/read-and-serve.ts`, `src/hash-store.ts`, `src/tool-undo.ts`, `src/domain-errors.ts`.
