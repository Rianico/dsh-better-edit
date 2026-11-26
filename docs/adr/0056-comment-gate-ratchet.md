# ADR-0056 — The comment gate is a shrink-only CI ratchet

Date: 2026-11-26

## Status

accepted (issue #232; ports upstream `pi-better-edit@51cb819`, PR #280)

Grammar reference: [docs/agents/comment-grammar.md](../agents/comment-grammar.md).

Downstream records: `.oxlintrc.json` (`jsPlugins`, `harness/no-comments`, `ignorePatterns`),
`scripts/comment-gate-predicate.mjs` (the shared grammar), `scripts/oxlint-plugin-comment-gate.js`
(the oxlint rule), `scripts/comment-gate-baseline.mjs` (`--check`/`--update`),
`test/arch/comment-gate-baseline.json` (the legacy ledger),
`test/arch/comment-gate.test.ts` (the ceiling literal and the parity corpus).

## Context

Comments in this repo were governed by an allowlist plugin that drifted from the grammar the
project actually settled on: it accepted the retired `WHY:`, `Invariant:`, `See ADR-` and
`via https://` tokens, accepted any `/** */` block anywhere, and accepted a `SAFETY:` comment that
guarded nothing. The plugin was also configured by nothing — `.oxlintrc.json` held an empty
`rules` object — so `pnpm run lint` never ran it. Upstream `51cb819` replaced that shape with one
shared predicate, an armed rule, a baseline generator using a second parser, and an arch suite that
pins both layers to one fixture corpus.

Downstream has its own comment corpus and its own integration surface. It carries no pi-lens
bridge, keeps `benchmark/` as a measurement harness outside the shipped source set, and cannot
drain `src/` and `test/` in one change without turning a gate into a rewrite.

## Decision

- **One predicate owns the grammar.** `scripts/comment-gate-predicate.mjs` exports the allowlist,
  the retired-token containment, the directive prefix, the Gherkin forms, the JSDoc caps and the
  classification. The oxlint rule and the Babel baseline generator both consume it, so the rule and
  its suppression file cannot drift.
- **The grammar ports unchanged except where downstream differs.** `SAFETY:`, `TODO(#<digits>):`,
  `HACK:`, `Ref: docs/<path>` and `Ref: http(s)://<link>` are the only tags. Strict Title-Case
  Gherkin steps and `Feature:`/`Scenario:` headings are allowed. `WHY:`, `Invariant:`, `See ADR-`
  and `via https://` are retired everywhere, including as text inside a `/** */` block. A
  `/** */` block is module scope only and at most 12 lines.
- **Only `eslint-disable*` and `oxlint-disable*` are directive prefixes.** Upstream also accepts
  `pi-lens-ignore`; downstream has no pi-lens bridge, so such a line would suppress nothing and is
  prose. The reason after `--` is free-form and must be non-empty.
- **A `#!` line 1 is an interpreter directive.** Neither parser classifies it as a comment, so an
  executable script's first line is not a violation.
- **The gate is armed as a ratchet, not a drain.** `.oxlintrc.json` enables
  `harness/no-comments` as `"error"` over root configs, `src/`, `test/` and `scripts/`, ignoring
  `.lane/`, `lib/`, `dist/`, `coverage/` and `benchmark/`. The pre-existing `src/`+`test/`
  violations are recorded in `test/arch/comment-gate-baseline.json`; root configs and `scripts/`
  hold zero. A new violation at any scope fails `pnpm run lint`.
- **The ceiling is a literal in the arch suite.** `EXPECTED_MAX_LEGACY_COMMENTS` in
  `test/arch/comment-gate.test.ts` equals the baseline length. The generator writes only the
  `entries` array and cannot read or raise that literal, so a rise is a visible edit to the test
  file in review. The arch suite also asserts the baseline is not bloated behind a matching count.
- **The second parser is `@babel/parser`.** oxlint sees its own AST; the generator sees Babel's.
  The arch suite runs the same corpus through the real rule and through Babel, so a divergence
  fails in CI instead of drifting silently.
- **The arrival retires the scanner's parser-availability trigger.**
  `test/support/arch-scan.ts` held a manifest predicate that failed the moment a tokenizer entered
  `package.json`; it fired when `@babel/parser` landed here, so the trigger is removed and the
  regex-literal blind spot stays declared by its C19 cell rather than deferred on availability.
- **`benchmark/` is outside the gate.** It is a measurement harness, not shipped code, and its
  comments answer to the harness that owns it.

## Consequences

- `pnpm run lint` now refuses every new untagged or retired-token comment, including inside a
  `/** */` block, and names the rule kind (`prose`, `bodyDoc`, `blockCap`, `safetyPosition`).
- The legacy corpus keeps lint green while it shrinks. Removing a recorded comment requires
  `--update` to retire its entry, and the exact ceiling keeps the source count from rising.
- The arch suite pins the shebang exception at the plugin level and the parser level, so an
  executable script stays lintable.
- `pnpm run typecheck` gains `allowJs`, because the test imports the gate's `.mjs` modules.

## What this deliberately does not do

- It does not preserve long design rationale in `src/` or `test/` comments. That rationale lives in
  ADRs and in `docs/agents/arch-guard-inventory.md`; the pre-drain baseline history in git keeps the
  deleted text recoverable.
- It does not adopt upstream's `pi-lens-ignore` prefix or its `docs/agents/verification-standards.md`
  provenance page; this ADR is the downstream provenance.
- It does not move the upstream sync cursor. `51cb819` is a targeted port outside `0b1934c`.
