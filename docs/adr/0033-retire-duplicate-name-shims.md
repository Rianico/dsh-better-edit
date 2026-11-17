# ADR-0033 — Retire the duplicate-name shims and the dead FileView sub-graph

Status: Accepted (ticket arch-T1, lane `arch-r1`; reverses the CAND-1 decline recorded in
`docs/absorption-plan.md` §T3).
Related: [ADR-0018](0018-exact-position-served-span-verification.md) — a dead path can go green; this
record deletes the path instead of banking coverage for it.
Downstream records: `src/mutation.ts` (`persistUndoAndWrite`, `execute`), `src/mutation/engine.ts`
(`PreparedItem`, `runFileEdits`), `src/file-view.ts` (`normFromText`, `fileSnap`, `fmtReadPreview`,
`readView`), `src/encoding.ts` (`SUPPORTED_ENCODINGS_LABEL`),
`test/core/coverage-agent-c-mutation-engine.test.ts` (re-pointed pins),
`test/arch/applied-notice-tier.test.ts` (`MIN_SOURCE_FILES`).

## Context

One concept, two names, seven specifiers. The read seam was already `src/file-view.ts`, the mutation
seam already `src/mutation.ts` + `src/mutation/engine.ts`, but four alias layers still stood in front
of them:

- `src/edit-engine.ts` — `export * from "./mutation/engine.js"` plus
  `export { persistUndoAndWrite, commit, commitSingle, commitBatch } from "./mutation.js"`.
- Five byte-identical shims, each a docblock plus `export * from "./file-view.js"`: `file-reader`,
  `file-kind`, `validation`, `read-render`, `truncate`.
- A ten-line deprecated re-export block inside `src/mutation.ts`, re-exporting `runFileEdits`,
  `persistUndoAndWrite`, the engine types, the `edit-response` builders, `genDiff`/`restoreEndings`/
  `toLF`/`stripBOM`, `computeDrift`/`scanDrift` and `noop-guard`'s three functions.
- `src/preview-controller.ts`, which no module imported at all.

Measured state at `HEAD` before the ticket (`git ls-tree -r HEAD --name-only src | rg '^src/[^/]+\.ts$' | wc -l`
→ 44; `ls src/*.ts | wc -l` → 37 after), `src/mutation.ts` at 14 `export` statements naming 26 symbols
(`git show HEAD:src/mutation.ts | rg -c '^export '` → 14, 4 after), and **seven dead exports**: the seven exported names
of the orphan controller (`git show HEAD:src/preview-controller.ts | rg -c '^export '` → 7:
`PREVIEW_DEBOUNCE_MS`, `PreviewHost`, `PreviewCompute`, `RPreview`, `RRState`, `getPreviewInput`,
`DebouncedPreview`), against zero consumers for any of them across `src/`, `test/`, `tests/`,
`benchmark/` and `scripts/`.

CAND-1 declined this deletion on two grounds, and both were wrong in the same way — each mistook a
name for a seam.

**Ground 1 — "not dead: a type-only importer".** The importer was `src/tool-edit.ts:20`,
`import type { PreparedItem } from "./edit-engine.js"`. `PreparedItem` is _declared_ by
`src/mutation/engine.ts:118`; the alias contributed nothing to the import beyond a second spelling of
the owner's path. A type-only import of an owned name through an alias is not a use of the alias, and
it migrated in one line (`from "./mutation/engine.js"`).

**Ground 2 — "banked by two coverage suites".** The two suites pinned behaviour that lives in
`src/mutation/engine.ts` and `src/mutation.ts`: `test/core/coverage-agent-c-edit-engine.test.ts`
imported `collectRemovedHashes`, `countLineChanges`, `applyOne`, `enforceNoopLoop` (all owned by
`mutation/engine.ts`) and `persistUndoAndWrite` (owned by `mutation.ts`) through `edit-engine.js`.
After re-pointing at the owners they prove the same behaviour with no shim. The second suite's
contribution was `test/core/coverage-easy2.test.ts`'s `easy2 edit-engine` block, whose whole subject
was the alias's existence — `typeof mod.applyOne === "function" || typeof mod.runFileEdits === "function"`
on a dynamic `await import("../../src/edit-engine.js")` — so it pinned no behaviour at all and is one
of the deleted blocks named in the ticket inventory (decision 8). Coverage of an alias is not coverage
of a seam, and keeping dead code alive to keep its tests green is the inverse of
[ADR-0018](0018-exact-position-served-span-verification.md)'s lesson: "an agent can 'fix' a dead path,
watch it go green, and believe the live path was exercised."

**The FileView finding.** `readNormFile` (`src/file-view.ts` at `HEAD`) was the only root of a dead
sub-graph: it was the sole caller of `loadFileKindAndText`, `valAccess` and `valKind`, and its own only
consumer was `test/core/file-reader.test.ts` (deleted). `preview` was already orphaned. The live read
path is `readView` → `io.readText` → `normFromText` plus `fs-bridge`'s own error mapping
(`mapFsError`, `decodeForOpen`) — which is what the model actually sees, because
`src/read-and-serve.ts` and `src/tool-read.ts` both enter through `readView`.

## Decision

1. **Delete `src/edit-engine.ts`.** `PreparedItem` names its owner (`mutation/engine.js`). The alias
   existed so callers could avoid choosing between the two modules; every caller could choose, and did
   so in one line.
2. **Delete the deprecated re-export block in `src/mutation.ts`.** The seam's surface is `execute`,
   `resolveDisplayPath`, `snapshotIdFor`, plus `persistUndoAndWrite` — the last exported because the
   transaction's own behaviour pins call it directly (the #98 post-write retirement ordering and the
   `E_ENCODING_UNWRITABLE` round-trip verdict, `test/core/encoding-roundtrip.test.ts`) and because it
   owns no other module. Everything else in that block was reachable at its owner, and a re-export that
   nothing in the tree imports is a second expression of the owner's contract that no test can keep
   honest.
3. **Delete the `commit` wrapper** (no `src/` caller — its only consumer was
   `test/core/encoding-roundtrip.test.ts`, which now names `persistUndoAndWrite`) **and the
   `commitSingle`/`commitBatch` re-export; inline the three-line `applySequence` forwarder** into its
   only caller, `execute`. The forwarder was `return runFileEdits(io, items, ctx)` with a docblock —
   an interface with no invariant of its own, so `execute` now calls `runFileEdits` directly.
4. **Delete `src/preview-controller.ts`.** Zero importers in `src/`, `test/`, `benchmark/` and
   `scripts/`; `getPreviewInput` returns `null` unconditionally, so `renderCall` always takes its
   `cancel` branch and the 150 ms debounce can never arm. This is not CAND-5: CAND-5 declined to
   _wire_ a preview into the tool definition, this record declines to _keep_ a controller that no
   composition reaches. Deleting the orphan does not foreclose CAND-5 — a future preview arrives with
   its own controller and its own caller.
5. **Delete the FileView sub-graph rooted at `readNormFile`**, and the four result types it alone
   consumed: `LFile`, `LFileText`, `LoadFileOptions`, `ReadNormOptions`. A dead read path is more
   dangerous than a dead helper: it is a second, untested answer to "what does the model see", and the
   one thing that can drift from the live answer without any test noticing.
6. **Delete the five shims.** The three live importers of `file-reader` (`fs-bridge`, `mutation`,
   `mutation/engine`) name `file-view.js` directly. No runtime cycle is created because
   `file-view.ts` imports `fs-bridge` **type-only** (`import type { FileIO }`), so the edge exists only
   at compile time.
7. **One roster.** `SUPPORTED_ENCODINGS` gains `SUPPORTED_ENCODINGS_LABEL`, and `tool-read`'s and
   `fs-bridge`'s rejection messages plus the three `store-config` sites (the zod default,
   `DEFAULT_CONFIG_YAML`, `complementMissingFieldsSync`) derive from it. The roster had been spelled
   out five times; a codec added to four of them would have produced a config template that offers an
   encoding the tool then rejects. Rendered messages and the generated config stay byte-identical —
   proved by comparing each live template against its `HEAD` counterpart with the hard-coded list
   replaced by `${SUPPORTED_ENCODINGS_LABEL}`, and `DEFAULT_CONFIG_YAML` plus the zod default against
   `HEAD`'s literal list (see Consequences for the probe).
8. **Behaviour pins migrate, never disappear.** The authoritative pins after this record:
   `test/core/coverage-agent-c-mutation-engine.test.ts` (engine + transaction — the renamed, re-pointed
   `coverage-agent-c-edit-engine.test.ts`), `test/core/encoding-roundtrip.test.ts`
   (`E_ENCODING_UNWRITABLE` precedes every write), `test/core/coverage-final-push*.test.ts` (noop
   policy, now imported from `noop-guard.js`), `test/core/read-preview.test.ts` and
   `test/core/snapshot.test.ts` (live FileView symbols, now imported from `file-view.js`). Deleted
   suites are exactly those whose whole subject was a deleted symbol: `file-reader.test.ts`,
   `file-kind.test.ts`, `validation-access.test.ts`, plus the `it`/`describe` blocks named in the
   ticket inventory — including `easy2 edit-engine`, which asserted only that the alias existed.

## Consequences

- Whatever is now true: `src/` holds 37 top-level `.ts` files, down from 44; the test corpus is 172
  files / 1756 tests, down from 175 / 1805 (both `pnpm test` on the same vitest 4.1.12: `HEAD` →
  `Test Files 175 passed (175)`, `Tests 1805 passed (1805)`; this tree →
  `Test Files 172 passed (172)`, `Tests 1756 passed (1756)`); `src/mutation.ts` exports 4 names instead
  of 26; the orphan controller's seven dead exports are gone.
- No lint, format or CI configuration referenced a deleted path, so this record removed no guard: the
  inventory sweep over `src/`, `test/`, `tests/`, `.oxlintrc.json`, `.oxfmtrc.json`, `biome.json`,
  `.github`, `.config` and `package.json` returns zero hits on any retired specifier. Ticket item 5 is
  satisfied by that evidence, not by an edit — a guard against paths that no longer exist would only be
  dead config.
- The roster consolidation is byte-identical, and the probe is repeatable: a `tsx` script reads each
  `HEAD` literal back out of `git show HEAD:src/<file>`, substitutes the hard-coded list with
  `${SUPPORTED_ENCODINGS_LABEL}`, and asserts string equality against the live template — green for
  `tool-read`, `fs-bridge`, `DEFAULT_CONFIG_YAML`'s `supportedEncodings:` line, the zod default array
  and `complementMissingFieldsSync`'s line.
- The pins that keep this decision honest: `test/arch/applied-notice-tier.test.ts`'s
  `MIN_SOURCE_FILES` is a floor lowered 66 → 61 to match the tree (a floor, not a pin: a growing `src/`
  keeps passing, an emptied walk still fails); the inventory sweep commands above; and
  `pnpm run typecheck && pnpm test && pnpm run lint && pnpm run format`.
- A shim becomes portable again only when a consumer genuinely cannot name the owner without creating
  an import cycle — that is the sole condition under which a second specifier carries information.
- Out of scope, flagged not fixed: `file-type` in `package.json` now has no importer, and removing a
  dependency is a manifest change outside this ticket. `biome.json`'s `noRestrictedImports` map is where
  the retired specifiers would be forbidden if the project ever wanted a tombstone rule — but a rule
  against paths that no longer exist would be dead config, so none was added.
- `docs/adr/0018-exact-position-served-span-verification.md:221` still cites base-revision line numbers
  in `coverage-agent-c-edit-engine.test.ts`. That is a historical measurement of a past lane, so it is
  left as history rather than re-pointed at a renamed file's new numbers.
- No version bump, no dependency change, no payload-contract change.

## References

- [ADR-0018](0018-exact-position-served-span-verification.md) — the dead-path-goes-green lesson this
  record applies in the other direction.
- `docs/absorption-plan.md` §T3 — the CAND-1 decline this record reverses (the ruling cell keeps its
  original text, marked superseded).
- `GLOSSARY.md` — `source of truth`, `projection`: the two entries that make "one name per concept"
  checkable rather than stylistic. No glossary entry is added: "shim" carries no repo-specific sense
  here, so defining it would be vocabulary with no reader.
