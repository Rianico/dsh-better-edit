# Arch guard inventory

Moved here verbatim from `test/support/arch-scan.ts`'s module header when the comment gate capped that header at
12 lines ([ADR-0056](../adr/0056-comment-gate-ratchet.md)). The code is authoritative; this page preserves the
method, the CEILING — DEFERRED item, the PREMISE, DECLARED LIMIT 3, the TWO INDEPENDENT REFERENTS rule and the
naming/matching rules for review and for the next guard author.

```text
 * Shared, pure-ish scanner for the arch oracles (`test/arch/**`). It is fed
 * either the live `src/` tree (`listSources` + `readFileSync`) or a planted
 * fixture string (the negative-control cells in
 * `test/arch/registry-scan-controls.test.ts`), which is why the scanning
 * functions take text rather than paths wherever possible.
 *
 * Method: match with precise regexes over text — no imports of the scanned
 * modules, so the scanner cannot be fooled by runtime shape.
 *
 * ── CEILING — DEFERRED (do not try to close this by scanning the text harder) ──
 * A text scanner cannot establish “every registry code has a producer”. It sees
 * *shapes*, not values: a producer held in a variable
 * (`const code = "E_X"; new DomainError(code, …)`) or written in a `.mjs` /
 * generated file is invisible **by construction** — those two cases are asserted
 * as *declared limits* in the oracle's C19 cells, not assumed closed.
 * The durable form is OBSERVATIONAL: route construction through a factory that
 * records the code, then assert every registry key except the declaration-only
 * allowlist was CONSTRUCTED AT LEAST ONCE by the suite. **Trigger:** the next
 * evasion class, or the next ticket that touches domain-error construction.
 * **Owner:** unassigned after the T1–T8 map — record it there when it lands.
 * NOT built in T4; this paragraph is the deferral record and the C19 cells are
 * what keep it honest.
 *
 * ── The PREMISE (stated once, for the whole scanner) ──
 * `stripComments` is sound ONLY because `tsc --noEmit` runs in CI, so every file
 * this scanner reads is lexically well-formed and typechecked. That premise is
 * what makes the `.mjs` limit acceptable — a `.mjs` file is never typechecked,
 * so it is outside the scan by construction — and it is what bounds the
 * stripper's unterminated-input behaviours (see its doc comment). Corollary: if
 * a scanned path could ever be untypechecked (issue #75), the scanner's
 * soundness degrades silently, so that dependency belongs in #75's conversation
 * too. **A guard's failure message must name the limits** — see
 * `UNDECLARED_PRODUCER_POINTER` in the oracle; a confusing false RED is how a
 * real guard gets “fixed” by weakening it.
 *
 * ── DECLARED LIMIT 3 — regex literals (a DIFFERENT class, not the premise) ──
 * A producer on a line containing a regex literal with `//` (e.g.
 * `void /[//]/; throw new DomainError("E_AMBIGUOUS_MATCH", …)`) is invisible:
 * the quote-only stripper treats `/` as an ordinary character, so the `//`
 * inside the literal opens a phantom line comment and truncates the rest of the
 * line. This is context-dependent division-vs-regex lexing, which only a real
 * tokenizer can decide — it is NOT covered by the well-formed-input premise.
 * **FAILURE MODE: LOUD.** A hidden producer is reported as `undeclared
 * producers: E_X` — a false RED the author must look at. We refuse to trade it
 * for a quiet defect: the standard division-vs-regex heuristic (`/` after an
 * identifier is division) guesses, and a wrong guess over-truncates and hides
 * REAL producers silently. Measured (r6): `void /[//]/;` + the
 * `E_AMBIGUOUS_MATCH` producer on one line ⇒ `tsc --noEmit` exit 0, oracle
 * `1 failed | 10 passed` (RED); control `void /a/;` + the same producer ⇒
 * `11 passed` (GREEN).
 * **RETIRED DEFERRAL (it was a predicate, not a phrase):** the trigger fired — a
 * real JS tokenizer (`@babel/parser`) is a dev dependency since ADR-0056, so
 * lexing the input is an available next step, not a blocked one. The C19 cell
 * keeps this blindness asserted on a planted temp tree until that conversion
 * lands.
 *
 * ── TWO INDEPENDENT REFERENTS (the rule that made the field allowlist structural) ──
 * Every guard here must compare two independently produced values: a source of
 * truth in `src/` (a registry object, a union member, a scanned file) versus the
 * test's own expectation. A guard that compares one referent to itself — a
 * constant against the same constant, a predicate that re-reads the entry it is
 * checking — is a tautology wearing a test's clothes. Concretely: allowlist
 * `owner`/`trigger.text` are pinned by identity *and* the entry's predicate is
 * recomputed in the oracle; “has no producer” is recomputed by the producer scan,
 * never read back out of the deferral entry; `DECLARATION_ONLY_FIELDS.remedy`
 * carries a src-side predicate *and* the oracle's independent 0-reader scan.
 *
 * ── Naming / matching rules ──
 * The code shape is `[EW]_[A-Z0-9_]+` — **digits are legal** (`E_RANGE2`), and a
 * regex that omits them is blind end-to-end (union parse *and* every producer
 * pattern). Quotes are accepted in both styles (`"E_X"` and `'E_X'`). Errno
 * exclusion: every producer pattern requires a quoted literal starting `E_`/`W_`
 * followed by the shape, so `ENOENT`/`EACCES`/`EPERM`/`ELOOP` never match (no
 * underscore after the leading `E`), and only registry-call positions are
 * scanned, so errno comparisons elsewhere are outside the scan by construction.
 * Comments are stripped before scanning (`stripComments`); **string literals are
 * kept** (producers contain them), so `maskStrings` exists for callers that need
 * to brace-match code only.
```
