import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

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
 * as *declared limits* in `registry-scan-controls.test.ts`, not assumed closed.
 * The durable form is OBSERVATIONAL: route construction through a factory that
 * records the code, then assert every registry key except the declaration-only
 * allowlist was CONSTRUCTED AT LEAST ONCE by the suite. **Trigger:** the next
 * evasion class, or the next ticket that touches domain-error construction.
 * **Owner:** unassigned after the T1–T8 map — record it there when it lands.
 * NOT built in T4; this paragraph is the deferral record and the two limit cells
 * are what keep it honest.
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
 * String-literal-aware comment stripper. The naive regex version treated a `/*`
 * (or `//`) inside a string literal — e.g. the glob `"src/**\/*.ts"` — as a
 * comment opener and silently deleted real source from the scan (N2). This
 * tracks `'`, `"`, `` ` `` (with backslash escapes) and only strips `//` and
 * `/* … *\/` outside a string. Newlines inside block comments are preserved so
 * reported line numbers stay stable.
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
 * Members of `export type <name> = …` — both quote styles, digits legal. Comments
 * are stripped first: a `;` inside prose must not terminate the union block early
 * and silently drop trailing members.
 */
export function unionMembers(source: string, name: string): string[] {
  const bare = stripComments(source);
  const block = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(bare);
  expect(block?.[1], `${name} union block parses`).toBeDefined();
  const members = [...block![1]!.matchAll(/["']([EW]_[A-Z0-9_]+)["']/g)].map((m) => m[1]!);
  expect(new Set(members).size).toBe(members.length);
  return members;
}

/**
 * The 8 producer positions. Only registry-call positions are matched, which is
 * what keeps errno codes out by construction.
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

/** Producer codes across files. */
export function producedCodes(files: string[]): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    for (const code of producedCodesInText(readFileSync(file, "utf-8"))) found.add(code);
  }
  return found;
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
