# Comment grammar

The settled grammar for every comment in this repo, and the pointer the oxlint rule carries as its
provenance. The decision record is [ADR-0056](../adr/0056-comment-gate-ratchet.md); the executable
definition is `scripts/comment-gate-predicate.mjs`, and the rule that consumes it is
`harness/no-comments` in `scripts/oxlint-plugin-comment-gate.js`.

A comment is legal only in one of these forms. Anything else is a violation, and a new violation
fails `pnpm run lint` at introduction: the legacy baseline is empty and the arch ceiling is `0`.

## Line comments (and non-doc block comments)

Prefix the text with an anchored tag. The tag must OPEN the text; a tag mid-sentence does not count.

| form                    | example                                         | notes                                                                                                                           |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SAFETY:`               | `// SAFETY: the guard above narrowed it`        | must sit within two non-blank lines ABOVE a `TSAsExpression`, `TSTypeAssertion` or `TSNonNullExpression`; otherwise it is prose |
| `TODO(#<digits>):`      | `// TODO(#196): add the liveness check`         | the issue number is mandatory                                                                                                   |
| `HACK:`                 | `// HACK: sqlite has no partial index here`     | for an irregular but deliberate shape, including an intentionally empty `catch`                                                 |
| `Ref: docs/<path>`      | `// Ref: docs/adr/0056-comment-gate-ratchet.md` | `Ref:` is the ONLY citation tag and needs a target                                                                              |
| `Ref: http(s)://<link>` | `// Ref: https://nodejs.org/api/fs.html`        | absolute link                                                                                                                   |

Tool directives are legal only as `eslint-disable*` or `oxlint-disable*`, followed by `--` and a
non-empty free-form reason:

```text
// eslint-disable-next-line no-control-regex -- these code points ARE the notice's subject.
```

`pi-lens-ignore` is NOT accepted downstream: there is no pi-lens bridge in this repo, so it would
suppress nothing. A directive whose `--` carries nothing is prose.

Gherkin is accepted in strict Title Case with a mandatory trailing space: `Given `, `When `, `Then `,
`And `, `But `, plus the headings `Feature:` and `Scenario:`. `Background:`, `Scenario Outline:` and
`Examples:` are out.

## Documentation blocks

A `/** */` block is judged structurally, not by a tag:

- module scope only: a block inside a function, arrow, class method or object method is a `bodyDoc`
  violation;
- at most 12 lines, otherwise a `blockCap` violation and the rationale belongs in an ADR under
  `docs/adr/`;
- its TEXT must not carry a retired form (below), even inside the block.

## Retired forms

`WHY:`, `Invariant:`, `See ADR-` and `via https://` are retired everywhere, including inside a
`/** */` block. A reason worth keeping is worth a record to follow:

```text
// Ref: docs/adr/0037-served-evidence-seam.md
```

## Interpreter directive

A `#!` line on line 1 is an interpreter directive, not a comment. Neither parser reports it.

## Scope and ratchet

The rule runs over root configs, `src/`, `test/` and `scripts/`. `benchmark/**` is out of scope by
owner ruling, together with gitignored build output (`.lane/`, `lib/`, `dist/`, `coverage/`).

The suppression file is `test/arch/comment-gate-baseline.json`, keyed by
`(repo-relative path, raw comment value, 0-based occurrence among that file's violations)`. It is
empty. `node scripts/comment-gate-baseline.mjs --check` recomputes every violation through a second
parser (`@babel/parser`) and refuses any entry the baseline does not record; `--update` writes only
the entries and cannot raise the ceiling. The ceiling is the literal `EXPECTED_MAX_LEGACY_COMMENTS`
in `test/arch/comment-gate.test.ts`; raising it is a visible edit to that test in review.

Parser parity is pinned by one fixture corpus that runs through both the real oxlint rule and Babel
(`test/arch/comment-gate.test.ts`), so the two layers cannot drift apart silently.

## Downstream adaptations

Relative to upstream `pi-better-edit@51cb819` (PR #280):

- `benchmark/**` is ignored by `.oxlintrc.json` and excluded from the scan scope.
- `pi-lens-ignore` is not an accepted directive prefix.
- The migration baseline starts empty because `src/` and `test/` are drained, rather than carrying
  upstream's legacy ledger.
- The upstream cursor stays at `0b1934c`; this is a targeted port outside the absorbed range.
