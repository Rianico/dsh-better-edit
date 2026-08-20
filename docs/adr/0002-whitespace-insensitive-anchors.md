# Whitespace-insensitive anchors — ASCII strip, no fingerprint

Date: 2026-08-20 (adapted for dsh-better-edit from pi-better-edit)

## Status

accepted (adapted for dsh-better-edit — same hashline algorithm; tool layer is dsh plugin API)

## Context

In workflows where an external formatter runs between edits (editor format-on-save, CI, a watcher — the linter being the only external writer), every whitespace-only lint pass rotated anchors under the trailing-trim canon, forcing `E_STALE_ANCHOR` rejections and full re-reads (measured: edit → prettier → edit rejects; ~93–98% of prettier's changed lines are whitespace-only).

## Decision

We decided the anchor is computed from the line with ASCII whitespace (`[ \t\r\n]`) removed, so formatting survives; verification keys on these anchors; and — because the only external writer is a formatter, which never alters semantics — no fingerprint is added. Any token-level change (quotes, semicolons, arrow-parens, wrapping, a brace merged onto a signature line) still rotates the anchor and is rejected as today.

### Considered Options

- **Anchor-strip only, no fingerprint (chosen)** — the anchor absorbs ASCII whitespace; verification semantics for every *non-whitespace* change stay identical to today. Linter-only workflows lose the rejection/re-read tax on whitespace churn; the ~2–7% token-level lint changes remain visible rejections, which is correct. Schema stays one value per line; no served-store change beyond the anchor derivation.
- **Anchor-strip + fingerprint (ADR-0003)** — the fingerprint was designed to catch semantic whitespace changes (`"x y"` vs `"xy"`, regex classes, Python re-indent). In a linter-only workflow those changes cannot occur (formatters never alter string/comment/regex contents), so the fingerprint is dead weight: a second value on every served line for a signal that never fires. Dropped.
- **Keep the anchor unchanged (ADR-0004)** — correct for workflows with concurrent human/other-agent writers, but pays a rejection + full re-read on every whitespace-only lint pass. The linter-only workflow is exactly the case where that cost is avoidable and recurring.

## Consequences

- Anchor derivation strips ASCII whitespace only (`[ \t\r\n]`); NBSP and all Unicode whitespace remain significant. Token-level changes stay detectable — `func hello()` vs `func hello() {`, quotes, semicolons, arrow-parens all still rotate because `{`/`"`/letters are not whitespace. **Caveat (verified): whitespace *inside* string literals and regexes is stripped too** — `const s = "x y"` and `const s = "xy"` canonicalize identically, so a whitespace-only change within a string is invisible to verification. Benign under the linter-only assumption (formatters never alter string contents); a concurrent-human workflow must revisit this (see the fingerprint note below).
- The survivor/removed-hash reuse in the stable mapping keys on the same stripped canon, so `func(a, b)` and `func(a,b)` match as the same line across a format pass.
- The snapshot cache keys on the raw whole-file checksum, which is unchanged; a canon version must participate in snapshot-cache invalidation so pre-change cached hashes are not served as valid after upgrade.
- In-flight anchors rotate once at upgrade (all served rows re-derive); per-session served state is short-lived (cleared at session start / TTL-swept), so no migration is needed — only snapshot-cache invalidation.
- The linter-only assumption is load-bearing: if a human or other agent can edit files concurrently, a whitespace-only semantic change becomes invisible. The ADR documents that boundary; a future workflow change revisits the fingerprint option.
