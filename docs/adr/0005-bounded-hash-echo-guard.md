# Bounded hash-echo guard for write and edit

Date: 2026-08-27 (adapted for dsh-better-edit from pi-better-edit)

## Status

accepted (adapted for dsh-better-edit — same bounded rule; write guard in `write-hook.ts`, edit guard in `hashline/anchor-pipeline.ts`); **the two denial-code names below are historical — see the Amendment**

## Context

Downstream `dsh-better-edit#29` — after N `write` calls the file contained `lGp│nT2│CCd│UIA│## 1. H1` — the model copied the entire `HASH│content` preview chain into file content. `pi-better-edit` heals `remove_from`/`remove_to` via `stripBarePrefixes` (`E_BARE_HASH_PREFIX` → 50% `WARN_HEALED` in separator shootout), but `replacement_text` and built-in `write` `content` had no guard — hashes would enter disk. Grill with `keel` + `domain-modeling` agreed: keep `HASH│content` presentation, don't hide hashes; add a bounded, fail-loud guard.

## Decision

We add a pre-dispatch/write guard for both surfaces, same bounded rule:

- **Same-session / same-canonical-path / same-line exact match** — a candidate line `k` that begins with `${hash}│` where `hash === served[pos]`. For `write` `pos = k` (absolute line `i` vs `served[i]`); for `edit` `pos = startLine + k` (range-relative `E1` alignment). Ported from `dsh@0.4.1` `findServedHashEcho` / `findEditHashEcho`.
- **Deny, not strip (AA: A)** — `[E_WRITE_HASH_ECHO]` / `[E_EDIT_HASH_ECHO]`, file byte-identical, retry with bare content. Never generically strip `^[A-Za-z0-9]{3}│` — `Zz9│literal` stays valid.
- `write` guard lives in `src/write-hook.ts` (`tools/pre-execute`); `edit` guard lives in `src/hashline/anchor-pipeline.ts:applyEdit` admission before `verifyServedRange` (via `findEditHashEcho`).

## Considered Options

- **E2 any-served-at-file** — any hash in served set at any line → catches reordered copies but false-positives on docs containing `Ab3│` where `Ab3` happens to be served elsewhere. Deferred.
- **E3 generic strip** — `replace(/^[A-Za-z0-9]{3}│/, "")` on every `replacement_text` line — rejected, hides bug and corrupts legitimate `HASH│` literals in docs.
- **Silent strip+warn (B)** — `boundaryDups` precedent (one duplicated boundary line, intent clear) — rejected for `N`-line chains; stripping `aB3│bC4│cD5│text` one layer leaves `bC4│cD5│text` still polluted; file write is irreversible, better to fail-loud.
- **Hide hashes (plain-text read + content anchors)** — rejected, deletes `served state` fact authority (ADR-0001), worsens duplicate `}` disambiguation and token cost (hash 3 vs line 30-60).

## Consequences

- `CONTEXT.md` adds `[[served hash echo]]`, `[[E_WRITE_HASH_ECHO]]`, `[[E_EDIT_HASH_ECHO]]` — deny semantics, range-relative `E1`.
- Prompt stays `replacement_text is bare content without HASH│`; error hint says `remove the entire copied anchor chain`.
- Tests port `dsh/test/core/write-hook.hash-echo.test.ts` for `write` plus new `edit` cases (`S1` `Ab3│` at `s+k` → deny, clean retry → allow).
- Separator stays `│` — strong delimiter, weak-space shootout irrelevant; guard is delimiter-agnostic (uses `HASH_SEP`).

## Amendment (2026-09-26) — the two denial codes are one, named for the diagnosis

`:18` and `:30` are historical as written. ADRs are write-once, so the stale code names are annotated here, not renamed in the body above.

- **The split is gone.** [ADR-0014](0014-user-model-audience.md) merged `[E_WRITE_HASH_ECHO]` / `[E_EDIT_HASH_ECHO]` into one code — its `:18` records `E_EDIT_HASH_ECHO`/`E_WRITE_HASH_ECHO→E_SERVED_ECHO`, because splitting one concept across tools is the defect its Context names. `E_SERVED_ECHO` was in turn renamed `E_SUSPICIOUS_TEXT` by the domain-errors registry work (`c056c5c`, touched again by `18ffca5` and `3b2acfb`). **No ADR recorded that second rename**; [ADR-0022](0022-region-scoped-rejection-serves.md):157 mentions the new name in passing without deriving it, so this Amendment is the only place in `docs/adr/` that carries the chain.
- **Measured at `ab713dd` (worktree `/Users/zhengxk/development/ai/dsh-better-edit.feat-t7-docs`).** `rg -c "E_SUSPICIOUS_TEXT" src/` → `domain-errors.ts` 4, `hashline/anchor-pipeline.ts` 6, `prompts.ts` 1, `write-hook.ts` 1 (12 total). `rg -n "E_SERVED_ECHO|E_WRITE_HASH_ECHO|E_EDIT_HASH_ECHO" src/` → 0 hits. The payload is this ADR's own concept, unified: `target: "edit" | "write"`, `path`, `line`, `hash`, `servedLine` (`src/domain-errors.ts:148-160`), rendered by `suspiciousFormat` (`src/domain-errors.ts:298-319`).
- **The rule is unchanged.** Same-session / same-canonical-path / same-line exact match, deny not strip, file byte-identical, retry with bare content. Only the code name and its arity moved. `:17`'s `pos = k` / `pos = startLine + k` alignment still describes the two arms, which are now one code's `target` field.
- **`:30`'s consequence is false now.** `CONTEXT.md` does not carry `[[E_WRITE_HASH_ECHO]]` / `[[E_EDIT_HASH_ECHO]]`; it carries one merged entry. `CONTEXT.md`'s `E_SUSPICIOUS_TEXT` entry is the single authoritative home for the name and the message shape — cite it, do not restate it. The `served hash echo` concept entry it depends on is unchanged.
