# ADR-0053 — One formatter owns both unserved-interior messages

Date: 2026-11-25

## Status

accepted (issue #223; ports upstream `cb50d94`, PR #322)

Amends: [ADR-0045](0045-strict-span-mode.md) — the hint voice now shares strict's structural shape.

Downstream records: `src/unserved-span-message.ts` (`formatUnservedSpanMessage`,
`UNSERVED_LIST_MAX_RUNS`), `src/domain-errors.ts` (`W_UNSERVED_INTERIOR` payload and
`unservedInteriorFormat`), `src/hashline/served-evidence.ts` (the strict `E_UNSERVED_RANGE`
headline), `src/edit-diff.ts` (`removedLineCount`), `src/edit-response.ts` (the hint payload).

## Context

ADR-0045 shipped two voices for one fact. Strict printed the replaced-span denominator and a
run-compressed list of absolute file lines. Hint printed a min..max envelope:
`Span replaced N unserved interior line(s) (lines X-Y).` The envelope is not a fact: its `X-Y`
span covers every line between the first and last unserved line, including served lines in the
middle, so a four-line replacement with holes at 1 and 4 read as if every line were unserved. The
two voices also owned their own grammar, plural agreement and compression rules, so each could
drift independently.

Upstream `cb50d94` (`fix(edit): make unserved-interior messages structural`, PR #322) fixes the
same defect by moving both voices onto one formatter. Downstream has the same defect and the same
seam, so the fix ports.

## Decision

- **One formatter, two voices.** `formatUnservedSpanMessage` in
  `src/unserved-span-message.ts` owns the summary clause, the absolute-line list, plural agreement
  and the remedy. `voice: "strict" | "hint"` selects only the summary clause and whether the remedy
  is present. Neither producer owns sentence grammar.
- **The hint becomes structural.** It names the replaced file-line count (`removedLineCount` from
  `genDiff`), the unserved count, and the exact absolute file lines as compressed runs. It prints
  no min..max envelope and therefore can never name a served line. A single unserved line renders
  `Unserved file line: N`, never `N-N`.
- **Strict stays fact-identical.** The strict voice keeps the same path (`path ?? "this file"`),
  the same replaced-span denominator, the same counts and the same absolute-line list. The only
  visible change is the capped remainder's number agreement: `(+1 more line)` where the old string
  always said `more lines`.
- **The cap stays 8.** ADR-0045 pins eight runs; upstream uses five. Downstream keeps its pin, so
  a strict refusal does not change shape at the boundary the existing suites assert.
- **The cap constant lives in the formatter module.** It cannot move to `src/constants.ts`:
  `constants.ts` imports `formatError` from `domain-errors.ts`, and `domain-errors.ts` imports this
  formatter, so a formatter → constants edge would close a cycle
  `domain-errors → unserved-span-message → constants → domain-errors`. The formatter is a
  zero-import leaf for the same reason.
- **The replaced-span denominator is a diff fact.** `genDiff` returns `removedLineCount`: every
  removed OLD line in the whole diff, independent of the fold cap and of the served mirror. The
  hint quotes that count, so a folded diff cannot shrink the denominator it states.

## Consequences

Both messages now name the same three facts: the replaced file-line denominator, the unserved
count, and the exact absolute file lines. The hint's disclosure is strictly more informative and
cannot name a line this session did serve. Strict output is unchanged for every plural case the
existing strict suites pin; the singular remainder and singular denominator now agree in grammar.
The shared formatter gives future edits one place to change grammar, so the two voices cannot
diverge again.

## What this deliberately does not do

- It does not add a producer site for `E_UNSERVED_RANGE`; `test/arch/range-family-signal.test.ts`
  still pins three.
- It does not change the strict facts, the eight-run cap, or the refusal's rowless shape.
- It does not move the cap constant into `src/constants.ts` (cycle, above).
- It does not absorb the upstream code layout wholesale: downstream has no `pipeline.ts`
  warning producer and no `serve-render.ts`; the hint payload is assembled in
  `src/edit-response.ts`.
- It does not move the absorption cursor; `cb50d94` is a targeted defect port outside the
  `0b1934c` range claim.

## References

- #223 — this change.
- [ADR-0045](0045-strict-span-mode.md) — the span-mode ladder and the eight-run cap.
- upstream `pi-better-edit@cb50d94` (`fix(edit): make unserved-interior messages structural`,
  PR #322) — the implementing source.
- upstream ADR-0019 §1–§4 — the EOL normalization the same upstream range introduced; not part of
  this port.
