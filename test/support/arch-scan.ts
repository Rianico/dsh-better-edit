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
 * Shared, pure-ish scanner for the arch oracles (`test/arch/**`), fed the live
 * `src/` tree or a planted fixture string.
 * The PREMISE (stated once, for the whole scanner): `stripComments` is sound only
 * because `tsc --noEmit` runs in CI, so a `.mjs` file is never scanned.
 * DECLARED LIMIT 3 — regex literals (a DIFFERENT class): a `//` inside a regex
 * truncates a producer line, and FAILURE MODE: LOUD. C19/C20 assert these limits
 * and the TWO INDEPENDENT REFERENTS rule; method, naming rules, the CEILING —
 * DEFERRED item and the retired deferral record live in
 * `docs/agents/arch-guard-inventory.md`.
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
 * INPUT ASSUMPTION (H5): lexically well-formed input only. An unterminated block comment deletes the rest of the
 * file from the scan; an unterminated string keeps the rest verbatim, comments included. Safe because `tsc --noEmit`
 * runs in CI (see the PREMISE); a path that could be untypechecked (issue #75) breaks the assumption silently.
 * The N2 fix stands: `'`, `"` and backtick (with escapes) are tracked, so a `/*` inside a string is not a comment
 * opener; newlines inside block comments are preserved so reported line numbers stay stable.
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
