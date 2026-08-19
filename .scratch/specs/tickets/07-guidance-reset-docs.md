## Parent

# 17 ([Enhancement] recover default guidance when an override file is emptied or deleted) · Design settled via grilling (rounds 1–4), confirmed

## What to build

The user-facing documentation and records for the guidance-reset feature. This ticket owns **docs/records only** — no `src/` changes: `docs/adr/0001-…`, repo `README.md`, repo `README.zh.md`, `CHANGELOG.md`. (The plugin-home README constants `GUIDANCE_HOME_README`/`_ZH` live in `src/guidance.ts`, owned by ticket 06.)

## The behavior to document (authoritative)

A user recovers the compiled default guidance for a section/preset by **emptying or deleting** the override file:

- **Blank file (no front-matter fence, whitespace-only body)** = "I want the default". Compiled default renders at session-start; the file is re-seeded at next boot (any preset dir, shipped or custom).
- **Delete the file** = same: default renders immediately; re-seeded at next boot for shipped presets (custom-preset deletes stay absent — absence = no override).
- **Delete a whole preset dir** = all four section files re-seed at boot (shipped presets).
- **A valid front-matter fence is a deliberate intent signal** — a file with any well-formed `---` fence (even a keyless `---\n---\n`, even with an empty body) is explicit content and is **never** reset or re-seeded. So "make it blank on purpose" = keep the fence; "reset to default" = delete the file, or empty it AND remove the fence.
- **Broken fence** (missing closing `---`, non-integer `order`, unknown key) = **fast fail**: the malformed text is never injected into the context; the compiled default renders and a warning names the file + reason; the file is left untouched on disk for repair.
- Files are read once per agent at session-start; re-seeding happens at boot, not mid-session.
- Reset restores the **current** bundle defaults (a plugin upgrade yields new defaults).

## Acceptance criteria

- [ ] `docs/adr/0001-guidance-override-files.md` amended **in place** (this is an amendment, not a new ADR):
  - Record the two exceptions to "override files win by content": blank-no-fence = absent (reset), and broken-fence = rejected (fast fail).
  - Record the reset semantics: empty/delete → compiled default at render, re-seed at boot; granularity is per file / per preset dir / per preset; shipped vs custom asymmetry (shipped re-seed, custom never fabricated); read-once preserved (resolution stays pure/read-only; physical re-seed only at boot).
  - **Explicitly reverse** the old rationale "malformed fence degrades the WHOLE file to prose so the mistake stays visible in the rendered section" — that visibility is replaced by the fast-fail + warning (see the 0001 text quoting the prose fallback).
  - Keep the `order`/fence/fallback pipeline description otherwise intact.
- [ ] `README.md` and `README.zh.md` (repo root): in/under the per-preset guidance section, add a **"Reset / restore defaults"** subsection. Instructions:
  - *Delete the file, or empty it and remove the front-matter fence* — the compiled default renders at session-start and the file re-seeds at next boot.
  - *Deliberately blank content* requires keeping a valid fence (a fence is an intent signal; it is never overwritten).
  - *Broken fence* = the file is ignored (default renders), a warning is logged with file + reason, and the file is left untouched for repair.
  - Note shipped vs custom (custom-preset deletes stay absent) and that reset restores the current bundle defaults.
- [ ] `CHANGELOG.md` gains an entry describing the feature (reset/restore defaults; fast-fail on malformed fences).
- [ ] `CONTEXT.md` glossary is consistent with the final vocabulary (`Override file`, `Reset` already added during the design — verify nothing else needs updating: `guidance`, `guidance override`, `reset`).
- [ ] Markdown renders cleanly (no broken fences/lists in the added Markdown code blocks).

## Blocked by

Nothing (core ticket 06 is parallel — disjoint files).
