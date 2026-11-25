# ADR-0052 — seeded guidance carries provenance and an upgrade lifecycle

Date: 2026-11-25

## Status

accepted (issue #177; tickets #204–#208)

Amends: [ADR-0001](0001-guidance-override-files.md) — the guidance override convention.

Amends (audience exception only): [ADR-0014](0014-user-model-audience.md).

Downstream records: `src/guidance/seed.ts` (`projectSeededBytes`, `seedHash`, `decideSeededFile`,
`SEED_VERSION`), `src/guidance/seed-history.ts` (`KNOWN_HISTORICAL_SEEDS`),
`src/guidance/materialize.ts` (`ensurePresetGuidance`, the `.seeded.json` ledger,
`reconcileShippedFile`, `inspectCustomFile`), `src/guidance/resolve.ts` (`resolveSection`'s
divergence footer), `src/domain-errors.ts` (`PROMPT_DIVERGED_NOTICE`), `src/index.ts` (the
logger callback).

## Context

A seeded guidance file was written once and never re-rendered. If an install booted at 1.2.6, a
later release that changed `src/prompts.ts` could not reach its `edit.md`: the file stayed at the
old body forever, so a new rule (the `dry_run` bullet of #186, for example) only appeared after the
user deleted the file or blanked it. Worse, every seeded file carried a hardcoded `order:` fence
from the band that was current when it was written, so an upgrade that moved the harness tool band
left those sections pinned to an obsolete slot — the exact failure ADR-0001's 0.2.1 amendment had
already documented once.

The naive repairs both break the same invariant. "Refresh everything" destroys a user's
customizations, which are the whole point of an override directory. "Never overwrite" is the defect
itself. ADR-0001 already fixes what a reset must do (empty/delete restores the compiled default at
the next boot); what it never states is who owns a file whose bytes are _this plugin's own output_.
Without an answer, a seed and a customization are indistinguishable after the first boot.

## Decision

**1. A seed's identity is its projection, not its bytes.** `projectSeededBytes` drops the whole
leading BOM run, normalizes `\r\n` and a lone `\r` to `\n`, and strips trailing whitespace-only
lines; interior lines and trailing spaces on a content-bearing final line survive. The projection is
idempotent and `""` projects to `""`. `seedHash` is the sha256 hex of the projected bytes, so BOM,
EOL, and trailing-blank noise cannot fork an identity. The parser keeps its own, deliberately
smaller scope: `parseSectionFile` strips exactly ONE leading BOM, and `isBlankOverride` tests the
stripped text (a `\uFEFF---\n---\n` file is still a deliberate blank).

**2. The decision matrix is total and ordered.** `decideSeededFile` classifies any string, in this
exact order: `malformed` (a leading fence that does not parse) → fenced `deliberate-blank` (valid
`---` opener, whitespace-only body) → bare-blank `preserve` (the materializer's blank-heal pass owns
that policy) → `current` (projection equals the compiled default) → `refresh` (projection equals the
hash recorded for this file) → `refresh` (projection is a `KNOWN_HISTORICAL_SEEDS` entry) →
`preserve` (everything else is a customization). The file is auto-refreshable **iff** its full-file
v1 projection matches (a) the current compiled default, (b) the recorded hash, or (c) a known
historical seed; otherwise it is user intent and is preserved byte-for-byte.

**3. Provenance lives in a sidecar, not in front-matter.** `<plugin-home>/.seeded.json` is
`{ version: SEED_VERSION (1), files: { "<preset>/<file>": "<hash>" } }`, covering the shipped
presets only. Why not a fence: a bad fence is a parse failure that rolls the whole section back to
the compiled default and reports a warning, and provenance inside user-editable prose is itself
editable — and destructible by the very edit that should be recognized as a customization. A
sidecar keeps the markdown clean and out of the parser's failure domain. Reading is tolerant by
design — a missing file, invalid JSON, a non-object, an array, a foreign `version`, or a non-string
hash value all degrade to an empty ledger, and the end-of-run write repairs it. The ledger is
written once per boot, key-sorted, 2-space JSON, trailing newline, through `writeAtomic`.

**4. Seeds carry no front-matter fence; order follows the band.** A new seed and a refreshed seed
are the bare `renderDefault()` body. Section order comes from the harness tool band
(`systemPrompt.getSectionOrder`, fallback `1100`/`1300`/`1310`), so a stale hardcoded `order:` can
no longer pin a section to an obsolete band. A hand-written `order:` in a user file is still parsed
and honored — the fence is an affordance, not a seed artifact. This supersedes ADR-0001's "a seeded
file keeps the order it was written with until it is reset".

**5. Refresh is a guarded read-decide-write.** `reconcileShippedFile` reads the file, decides, then
re-reads and compares `seedHash` before writing (TOCTOU: a file the user changed under us belongs to
the user — neither written nor recorded), writes with `writeAtomic` (same-directory temp file, mode
preserved, Windows `EPERM` fallback), and records the new hash. A missing shipped file is seeded
with `writeFile(..., { flag: "wx" })`; a concurrent `EEXIST` is the other writer's file and is
neither rewritten nor recorded. Bare blanks keep the reset-on-empty heal path — `isBlankOverride`
gates an immediate body write (the pre-#206 named helper is now inline in the materializer) — and
the healed file is recorded.

**6. The historical ledger makes an old seed recognizable.** `KNOWN_HISTORICAL_SEEDS` holds 12
`<preset>/<file>` keys backed by 16 distinct seed identities rendered from 26 tags
`v0.3.1 … v1.2.7`: `edit.md` has 8 versions (first tags `v0.3.1`, `v0.5.0`, `v0.7.0`, `v0.8.0`,
`v1.0.0`, `v1.1.0`, `v1.2.4`, `v1.2.7`), `read.md` 4 (`v0.3.1`, `v1.0.0`, `v1.1.0`, `v1.2.7`), and
`undo_last_edit.md` 4 (`v0.3.1`, `v1.0.0`, `v1.1.0`, `v1.2.4`). Bodies were preset-independent at
every tag, so all four presets share each file's array. Fixtures live at
`test/fixtures/guidance-seeds/<first-tag>/<file>` (16 files);
`test/guidance-seed-history.test.ts` re-hashes them and fails on drift in both directions (an
orphan ledger hash, or a fixture no preset lists). Provenance method: render each tag's own
`src/prompts.ts` + `src/guidance/resolve.ts` values into the seeded content, project, hash.

**7. Customizations are protected and reported once.** A shipped file that is customized or
malformed is untouched. A custom preset directory is detect-only: never refreshed, never fabricated
(a missing file stays missing), though its bare blanks still heal. Every preserved path — shipped or
custom — collects into ONE aggregated `rootCtx.logger.warn` per boot via
`ensurePresetGuidance(homeDir, warn?)`; `src/index.ts` passes the logger callback. Deliberate blanks
and current files are silent.

**8. A diverged file says so to the model.** `resolveSection` appends the two-line
`PROMPT_DIVERGED_NOTICE` (`[USER] [W_PROMPT_DIVERGED]` then one sentence) when the resolved text's
`seedHash` differs from the compiled default body. Malformed fallbacks, blank-chain skips,
current-default files, and deliberate blanks are notice-free; an order-only fence around the exact
default body is not divergence, because the comparison is over resolved text, not raw bytes. The
literal lives in `src/domain-errors.ts` because the arch gate forbids raw `[W_*]` headers anywhere
else. It is deliberately NOT a `DomainWarningCode`/`WARNING_REGISTRY` member: it has no formatter
envelope and must stay two lines.

**9. One audience exception, named.** The notice carries a `[USER]` prefix inside model-facing
prompt content, which intentionally departs from ADR-0014's "[USER] is human-only" rule for tool
warnings: the footer is human-visible in the prompt AND tells the model that the local file is
authoritative, so a diverged section can never be mistaken for the plugin's own defaults. The
constant is cited by name in `resolveSection` so the vocabulary registry and the audience oracle do
not drift; ADR-0014's rule stays intact for tool warnings, and this record is the named exception.

**10. Recorded deviations from the #177 ticket spec.** `decideSeededFile` takes `historical`
injected and has no `file` argument — the seam stays pure and the materializer wires the ledger.
The projection strips the whole leading BOM run while `parseSectionFile` strips one (a narrower
parser scope on purpose). Bare blanks are not decided by the seam; the materializer's healer owns
them. The notice constant sits in `domain-errors.ts` for the arch gate rather than in
`resolve.ts`. Custom-preset decisions pass `historical: []` — the manifest is shipped-only — so a
stale custom seed classifies as `preserve` and is warned, never refreshed.

## Consequences

- An upgrade refreshes an unmodified seed, so the #177 defect is closed and the 1.2.6 stale-rule
  class disappears on the next boot; an install picks up a new guidance bullet without resetting the
  file.
- A user's edit stays byte-identical on disk. It is listed in exactly one boot warning, alongside
  every other preserved file, and it never receives provenance of any kind.
- Deliberate blanks stay silent and untouched; a bare blank still heals to the current default,
  now without a fence.
- No provenance lives in the markdown, so ADR-0001's failure modes (bad fence → whole-section
  rollback) cannot be triggered by the plugin's own bookkeeping.
- A release that changes compiled guidance gains one mandatory step: append the new hashes to
  `KNOWN_HISTORICAL_SEEDS` and add the matching fixtures under
  `test/fixtures/guidance-seeds/<tag>/<file>` (CONTRIBUTING.md §Release). The test fails on either
  half missing, before the tag.
- One plugin-owned ledger file appears in the plugin home, `.seeded.json`. It is repairable: a
  missing or corrupt copy reads as empty and the next boot rewrites it, at the cost of losing the
  recorded hash for any seed the historical ledger does not cover — such a seed then classifies as
  a customization and is preserved with a warning.

## Considered options

- **Never overwrite a seeded file (status quo — rejected).** This is the defect: the seed is the
  plugin's own output, and leaving it frozen means an upgrade can never fix the guidance the model
  reads.
- **Provenance in `.md` front-matter (rejected).** A stray or malformed fence is a parse failure
  that rolls the section back to the compiled default, so plugin bookkeeping would be able to break
  a user's file. It is also inside the prose the user is invited to edit, so the marker is
  editable and destroyable by the same edit that should mark the file customized.
- **Refresh every file whose projection is not a customization — i.e. refresh everything (rejected).**
  Distinguishing a seed from an edit is the problem, not a detail; without identity there is no
  safe subset to refresh, and a blanket overwrite destroys user intent.
- **A versioned sidecar manifest plus an identity matrix (chosen).** One hash per shipped file, an
  exhaustive history for older seeds, a pure decision seam, and an atomic write with a TOCTOU
  guard. `writeAtomic`'s temp-file-plus-rename is what keeps a concurrent boot or editor from
  observing a half-written seed.

## What this deliberately does not do

- **No custom-preset refresh or fabrication.** A custom directory is detect-only: its blank files
  heal, its stale or customized files are warned about, and a missing file stays missing.
- **No marker inside the markdown.** The seeded body remains exactly the compiled default; no
  comment, no fence, no hash in the prose.
- **No new config key and no new `WARNING_REGISTRY` member.** The ledger path is fixed, and the
  divergence footer is prompt-tier content, not a tool warning.
- **No repair of user content.** A preserved or malformed file is reported, never rewritten; the
  fallback chain in `resolveSection` keeps its existing semantics (malformed renders the default and
  reports the file).
- **No change to merge or reset semantics for deliberate blanks.** A valid empty fence remains the
  user's "disable this section" signal and is never healed.

## References

- #177 — the seed-provenance and upgrade-lifecycle issue (this record); tickets #204–#208.
- [ADR-0001](0001-guidance-override-files.md) — the override convention, reset-on-empty, malformed
  fast fail, and the 0.2.1 band amendment this record extends.
- [ADR-0014](0014-user-model-audience.md) — the user/model audience split; this record is its named
  prompt-tier exception.
- `src/guidance/seed.ts`, `src/guidance/seed-history.ts`, `src/guidance/materialize.ts`,
  `src/guidance/resolve.ts`, `src/guidance/parse.ts`, `src/domain-errors.ts`, `src/fs-write.ts`.
- `test/guidance-seed.test.ts`, `test/guidance-seed-history.test.ts`, `test/guidance.test.ts`.
- `CONTRIBUTING.md` §Release (the guidance seed ledger step).
