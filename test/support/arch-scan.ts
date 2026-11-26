import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

/**
 * DECLARED LIMIT 3's former availability trigger (H4/H7) has retired. It was a
 * predicate over the live manifest: `holds()` failed the moment a tokenizer
 * entered `package.json`, forcing this entry's reconciliation instead of letting
 * it rot. It fired when `@babel/parser` arrived with the comment gate (ADR-0056),
 * so lexing is now an available next step rather than a blocked one. The limit
 * itself stays declared and asserted by the oracle's C19 cell.
 */

/**
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
 */

/** The code shape: digits are legal. Keep in sync with any new pattern below. */
export const CODE_SHAPE = "[EW]_[A-Z0-9_]+";

/** A quoted code, either quote style. */
export const QUOTED_CODE = `["'](${CODE_SHAPE})["']`;

/** Vitest runs with the package root as cwd. The oracles scan `src/` only. */
export function listSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * String-literal-aware comment stripper.
 *
 * INPUT ASSUMPTION (H5): this function assumes **lexically well-formed input** —
 * it has no newline or closure check for `quote`, and its block-comment loop runs
 * to EOF. So an **unterminated block comment deletes the rest of the file from
 * the scan**, and an **unterminated string keeps the rest verbatim, comments
 * included**, which would let a comment-fake pass again. Safe today for one
 * stated reason: `tsc --noEmit` runs in CI, so only well-formed files are ever
 * scanned — the guard inherits the compiler's guarantee (see the PREMISE
 * paragraph in this file's header). If a scanned path could ever be untypechecked
 * (issue #75), that assumption stops holding, silently.
 *
 * The N2 fix stands: the naive regex version treated a `/*` (or `//`) inside a
 * string literal — e.g. the glob `"src/**\/*.ts"` — as a comment opener and
 * silently deleted real source from the scan (N2). This tracks `'`, `"`, `` ` ``
 * (with backslash escapes) and only strips `//` and `/* … *\/` outside a string.
 * Newlines inside block comments are preserved so reported line numbers stay
 * stable.
 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | undefined;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote !== undefined) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < text.length) out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Replace string-literal CONTENTS with spaces, keeping quotes, newlines and
 * length. Brace matching runs on this mask so a `throw …({` inside a string is
 * neither located nor brace-counted, while code tokens stay readable in the
 * un-masked text at the same offsets.
 */
export function maskStrings(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | undefined;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
        out += ch;
        i += 1;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Members of `export type <name> = …` — the member literal derives from
 * `QUOTED_CODE`, so there is no private copy of the shape here (H2). Comments
 * are stripped first: a `;` inside prose must not terminate the union block early
 * and silently drop trailing members.
 */
export function unionMembers(source: string, name: string): string[] {
  const bare = stripComments(source);
  const block = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(bare);
  expect(block?.[1], `${name} union block parses`).toBeDefined();
  const members = [...block![1]!.matchAll(new RegExp(QUOTED_CODE, "g"))].map((m) => m[1]!);
  expect(new Set(members).size).toBe(members.length);
  return members;
}

/**
 * The 8 APPLIED-tier producer positions. Only registry-call positions are matched, which is
 * what keeps errno codes out by construction. The read tier has its own pattern below
 * (`READ_PRODUCER_PATTERNS`), deliberately NOT merged into this list: `firedWarnings` and
 * `PRODUCER_PATTERNS` are the applied tier's referent, and a read-tier code must never count as
 * an applied-tier firing (nor the reverse).
 */
export const PRODUCER_PATTERNS: Array<{ re: RegExp; code: (m: RegExpMatchArray) => string }> = [
  { re: new RegExp(`new\\s+DomainError\\(\\s*${QUOTED_CODE}`, "g"), code: (m) => m[1]! },
  { re: new RegExp(`formatError\\(\\s*${QUOTED_CODE}`, "g"), code: (m) => m[1]! },
  { re: new RegExp(`formatWarning\\(\\s*${QUOTED_CODE}`, "g"), code: (m) => m[1]! },
  { re: /new\s+EditHashEchoError\(/g, code: () => "E_SUSPICIOUS_TEXT" },
  { re: /new\s+BadAnchorError\(/g, code: () => "E_MALFORMED_ANCHOR" },
  { re: /new\s+AnchorSpaceExhaustedError\(/g, code: () => "E_LARGE_FILE" },
  { re: new RegExp(`new\\s+AnchorMismatchError\\(\\s*${QUOTED_CODE}`, "g"), code: (m) => m[1]! },
  {
    re: new RegExp(`new\\s+ServedRejectionError\\(\\s*\\{\\s*code:\\s*${QUOTED_CODE}`, "g"),
    code: (m) => m[1]!,
  },
];

/**
 * The read tier's producer position: `formatReadWarning("<CODE>"`. Separate from
 * `PRODUCER_PATTERNS` on purpose — the applied tier's scans (`producedCodes`, `firedWarnings`,
 * `test/arch/applied-notice-tier.test.ts`) compare against `WARNING_REGISTRY`, and a read-tier
 * code appearing there would claim a firing the applied tier never had.
 */
export const READ_PRODUCER_PATTERNS: Array<{
  re: RegExp;
  code: (m: RegExpMatchArray) => string;
}> = [{ re: new RegExp(`formatReadWarning\\(\\s*${QUOTED_CODE}`, "g"), code: (m) => m[1]! }];

/**
 * Producer codes in one text. Comments are stripped first — a producer-shaped
 * line inside a comment is prose, not a producer (G1).
 */
export function producedCodesInText(text: string): string[] {
  const bare = stripComments(text);
  const found: string[] = [];
  for (const { re, code } of PRODUCER_PATTERNS) {
    re.lastIndex = 0;
    for (const m of bare.matchAll(re)) found.push(code(m));
  }
  return found;
}

/** Read-tier producer codes in one text, under the same comment-stripping rule. */
export function producedReadCodesInText(text: string): string[] {
  const bare = stripComments(text);
  const found: string[] = [];
  for (const { re, code } of READ_PRODUCER_PATTERNS) {
    re.lastIndex = 0;
    for (const m of bare.matchAll(re)) found.push(code(m));
  }
  return found;
}

/** Producer codes across files. */
export function producedCodes(files: string[]): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    for (const code of producedCodesInText(readFileSync(file, "utf-8"))) found.add(code);
  }
  return found;
}

/** Read-tier producer codes across files. */
export function producedReadCodes(files: string[]): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    for (const code of producedReadCodesInText(readFileSync(file, "utf-8"))) found.add(code);
  }
  return found;
}

/**
 * The injected witness for `DEFERRED_PRODUCERS` (T6 CP2, F2): the warning codes whose
 * producer call sites are visible in `files`. A READ of the tree — production carries no
 * latch, so the witness is stateless, order-independent, and cannot be satisfied by
 * another test's earlier render. `producedCodes` already matches `formatWarning("<CODE>"`
 * call sites, so a planted producer is visible here by construction (the ledger's `T6M3`
 * for one code, `T6M5` for the other, prove the isolation).
 */
export function firedWarnings(files: string[]): ReadonlySet<string> {
  return new Set([...producedCodes(files)].filter((code) => code.startsWith("W_")));
}

/**
 * Occurrences of the given code names in **code** (comments stripped) across
 * files, as `file:code` strings. Prose may name a code; code may not.
 */
export function namesInCode(files: string[], names: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf-8"));
    for (const name of names) if (code.includes(name)) offenders.push(`${file}:${name}`);
  }
  return offenders;
}
