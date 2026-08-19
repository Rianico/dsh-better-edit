## Parent

# 17 ([Enhancement] recover default guidance when an override file is emptied or deleted) · Design settled via grilling (rounds 1–4), confirmed; the Gherkin contract in `.scratch/specs/0007-…` extended by the malformed-fail-fast amendment

## What to build

Give the user a recovery path for a messed-up per-preset guidance override file: **emptying or deleting an override file (or its whole preset dir) restores the compiled default guidance** — rendered at session-start, file re-seeded at next boot.

This ticket owns **all code changes**: `src/guidance.ts`, `src/index.ts`, `test/guidance.test.ts`. Docs/records are a separate ticket (07).

Three-way classification of an override file's content (this is the whole model):

1. **Absent / blank** — file missing, zero-byte, whitespace-only body, and **no front-matter fence**. = "I want the default". At render, treat as absent → compiled default; at boot, re-seed the file with the current seeded default.
2. **Valid fence** — any well-formed leading `---` fence (even keyless `---\n---\n`, even with an empty body). = "I intend this content, including blank". At render, file wins; at boot, never touched. This is the *deliberate blank* case — never reset, never re-seeded.
3. **Broken fence** — a leading `---` that does not parse (missing closing `---`, non-integer `order` value, unknown front-matter key). = **fast fail**. The malformed text must NEVER reach the model context. At render, compiled default + a warning naming the file and the parse reason; at boot, the file is left **untouched** (it holds the user's salvageable body/attempt — overwriting is data loss).

## Acceptance criteria

### `parseSectionFile` — three outcomes (currently collapses "no fence" and "broken fence" into one prose shape)

- [ ] `ParsedSection` gains a way to express the malformed outcome (e.g. an optional `malformed?: boolean`, or a discriminated union). "No fence" stays prose (`{ text: whole }`) and wins; "broken fence" becomes a distinct rejected outcome; "valid fence" stays `{ order, text }`.
- [ ] Keep today's semantics that must NOT change: `""` → `{ text: "" }` (blank, order undefined); a missing closing `---` is no longer prose — it becomes **malformed**; non-integer `order` and unknown front-matter keys become **malformed** (no longer prose); CRLF-tolerant fences stay valid; leading blank lines after the closing fence are stripped; a valid keyless fence `---\n---\n` stays **valid with order undefined** (deliberate blank — NOT malformed, NOT treated as absent).
- [ ] Export a shared predicate, e.g. `isBlankOverride(content: string): boolean` = file parses to a **whitespace-only body and no valid fence** (i.e. not malformed AND `order === undefined` AND `text.trim() === ""`). This is the single source of truth for "should this file re-seed". Must be `false` for: prose with content, any valid fence (incl. keyless/empty), and malformed files.
- [ ] Export a malformed predicate or otherwise let callers distinguish malformed from blank, e.g. `isMalformedOverride(content)`. A keyless fence and an empty file must be distinguishable from a broken fence.

### `resolveSection` — fast fail + blank-as-absent

- [ ] When the found override file is **blank** (`isBlankOverride`), treat it as absent → advance the fallback chain (which ends in the compiled default). Never render an empty section for a blank file.
- [ ] When the found override file is **malformed**, do NOT render its text and do NOT advance to a lower file — resolve to the **compiled default** of that section, and surface a warning. The `Warning` must name the override file path and the parse reason, e.g. `ignoring malformed guidance override <path>: non-integer order 'abc'…; using compiled default`.
- [ ] How the warning is surfaced: `resolveSection`/`composeSections` should expose the malformed info upward (e.g. an optional field on `GuidanceResolution` / a returned warning list / an optional `onMalformed` callback threaded through) so `index.ts` can log it once per agent install via `rootCtx.logger.warn`. Resolution remains pure (no cordis dependency inside `guidance.ts`) — keep the log call in `index.ts`.
- [ ] Non-blank, non-malformed files win as today (prose wins with default order; valid fence wins with its order).

### `ensurePresetGuidance` — three-way disk rule at boot

- [ ] Enumerate **all** preset directories in the home (shipped `DEFAULT_PRESETS` **and** any custom-on-disk preset dir), not just `DEFAULT_PRESETS`.
- [ ] For every preset dir, for each section file that **exists and is blank** (`isBlankOverride`): rewrite it with the current seeded default (`---\norder: N\n---\n\n<default>`). This is the "heal a blank file" path.
- [ ] **Malformed** files are never touched. **Non-blank** files are never touched. Existing behaviors preserved: seed absent section files only for `DEFAULT_PRESETS` (custom presets are never fabricated — absence of a dir/file = no override); root READMEs unchanged (still seeded only if missing, still `wx`).
- [ ] Write for the heal path is a plain overwrite (not `wx`/exclusive — the file exists) and must carry the same `fs`-gate discipline as production writes if it were a user-mutation seam (here it runs at boot on the plugin home; follow whatever the existing seeding does for encoding/error handling). Must never fail the boot (the caller in `index.ts` already `.catch`es).
- [ ] Deliberate-blank (valid-fence incl. keyless, empty body) files survive boot untouched — they are **not** blank-overrides.
- [ ] The heal path uses the **current** bundle defaults (a plugin upgrade yields new defaults, not the stale seed).

### `src/index.ts` — wiring + warning

- [ ] Thread the malformed warning from resolution into `rootCtx.logger.warn`, once per agent install (bounded by the existing `WeakSet` guard), naming file + reason. Never fails the install — malformed content is never injected.
- [ ] `ensurePresetGuidance(configDir())` call already exists in `apply()` (boot); it now heals blank files and scans all preset dirs — no signature change required, but verify.

### Tests (`test/guidance.test.ts`)

- [ ] Rewrite the three parse pins that currently assert malformed → prose: `treats a missing closing fence as prose`, `treats a non-integer order as prose`, `treats an unknown front-matter key as prose` → now assert the **malformed** outcome.
- [ ] Keep intact: `accepts a fence without an order key (body only)`, `returns an empty string for an empty file`, `is CRLF-tolerant for the fence`, `parses order from a valid front-matter fence`, `strips leading blank lines`.
- [ ] Add `parseSectionFile`/predicate cases: empty file is blank (→ `isBlankOverride` true, not malformed); whitespace-only file is blank; valid keyless `---\n---\n` is NOT blank (deliberate blank), NOT malformed; valid empty-body fence `---\norder: 150\n---\n` is NOT blank.
- [ ] Add `resolveSection` cases: blank file → compiled default (not empty); malformed file → compiled default AND a warning naming file + reason; non-blank file wins; blank-with-fence → renders `""` at its order (deliberate blank preserved — `{ order, text: "" }`); malformed never renders the file's text.
- [ ] Add `ensurePresetGuidance` cases: a blank section file (any preset, including a **custom** preset dir present on disk) gets re-seeded with the compiled default; a **malformed** file is left byte-identical; a non-blank file is left byte-identical; an **absent custom-preset** file is not fabricated; a deliberate-blank (valid-fence) file survives boot untouched; whole shipped preset dir deleted → all four re-seeded.
- [ ] Keep the existing `never rewrites existing files` test (non-blank) passing.
- [ ] Full suite green: `npm test` and `npm run typecheck`.

## Blocked by

Nothing (docs ticket 07 is parallel — disjoint files).
