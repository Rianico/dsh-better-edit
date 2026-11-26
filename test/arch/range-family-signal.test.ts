import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Arch oracle for the range-family payload shape (T4 CP1-r2, F5; re-pointed by T6).
 *
 * Method: read `src/**` with node:fs and match with precise regexes (no imports of the
 * scanned modules, so the oracle cannot be fooled by runtime shape). The `ErrorPayloadMap`
 * shape check reads `src/domain-errors.ts` as text for the same reason.
 */

const SRC_ROOT = join(process.cwd(), "src");
const REGISTRY_FILE = join(SRC_ROOT, "domain-errors.ts");

const RANGE_CODES = ["E_STALE_RANGE", "E_UNSERVED_RANGE"] as const;
type RangeCode = (typeof RANGE_CODES)[number];

/**
 * Expected production arm counts per code (T4 CP0 enumeration, 3f4aca6: 11 + 2).
 * E_STALE_RANGE is 12 since FU-3: the gate's merged `null || undefined` arm was split into a
 * truncated-slot arm and a boundary-never-served arm (upstream ADR-0024 decision 1, adopted;
 * the interior hole now `continue`s instead of throwing, so no arm was added for it).
 * E_UNSERVED_RANGE is 3 since #144 T2 — strict span mode's aggregated rowless interior refusal is
 * a new producer beside the mirror-route scan and the boundary arm. Keep the E_STALE_RANGE
 * wording intact.
 */
const EXPECTED_SITES: Record<RangeCode, number> = { E_STALE_RANGE: 12, E_UNSERVED_RANGE: 3 };

function listSources(root: string): string[] {
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
 * String-literal-aware comment stripper. A `//` or `/*` inside a string literal is not a
 * comment opener (the naive regex version deleted real source from the scan — see
 * `test/arch/domain-error-registry.test.ts` N2). Newlines are preserved so reported line
 * numbers stay stable.
 */
function stripComments(text: string): string {
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
 * Replace string-literal CONTENTS with spaces, keeping quotes, newlines and length.
 * Brace matching runs on this mask so a `throw …({` inside a string literal is neither
 * located nor brace-counted, while code tokens (`code: "E_…"`, `reread:`) stay readable
 * in the un-masked text at the same offsets.
 */
function maskStrings(text: string): string {
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

/** The brace-balanced region starting at `openBraceIndex`, ignoring braces in strings. */
function bracedRegion(text: string, openBraceIndex: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openBraceIndex, i + 1);
    }
  }
  throw new Error("unbalanced braces in scanned source");
}

interface Site {
  code: string;
  file: string;
  line: number;
  reread: boolean;
}

const SITE_RE = /throw new ServedRejectionError\(\s*\{/g;
const CODE_RE = /code:\s*"([EW]_[A-Z_]+)"/;

/** Every `throw new ServedRejectionError({ code: "…" })` arm in one source text. */
function sitesFromText(text: string, file: string): Site[] {
  const bare = stripComments(text);
  const masked = maskStrings(bare);
  const out: Site[] = [];
  for (const m of masked.matchAll(SITE_RE)) {
    const openBrace = m.index! + m[0].length - 1;
    const regionLength = bracedRegion(masked, openBrace).length;
    const region = bare.slice(openBrace, openBrace + regionLength);
    const code = CODE_RE.exec(region)?.[1];
    if (code === undefined) continue;
    out.push({
      code,
      file,
      line: bare.slice(0, m.index!).split("\n").length,
      reread: /reread:\s*true/.test(region),
    });
  }
  return out;
}

function allSites(files: string[]): Site[] {
  return files.flatMap((file) => sitesFromText(readFileSync(file, "utf-8"), file));
}

/** The `E_*` member block of `export interface ErrorPayloadMap`. */
function payloadMapRegion(): string {
  const bare = stripComments(readFileSync(REGISTRY_FILE, "utf-8"));
  const start = bare.indexOf("export interface ErrorPayloadMap {");
  expect(start, "ErrorPayloadMap declaration found").toBeGreaterThan(-1);
  return bracedRegion(maskStrings(bare), bare.indexOf("{", start));
}

function payloadBlock(region: string, code: RangeCode): string {
  const m = new RegExp(`\\b${code}:\\s*\\{`).exec(region);
  expect(m, `${code} payload entry declared`).toBeTruthy();
  return bracedRegion(region, m!.index + m![0].length - 1);
}

describe("arch: range-family re-read signal (T4)", () => {
  const files = listSources(SRC_ROOT);
  const sites = allSites(files);

  it("no range-family arm carries the deleted retry flag (arm counts pinned)", () => {
    for (const code of RANGE_CODES) {
      const arms = sites.filter((s) => s.code === code);
      expect(arms.length, `${code} production arm count`).toBe(EXPECTED_SITES[code]);
      const flagged = arms.filter((s) => s.reread).map((s) => `${s.file}:${s.line} (${s.code})`);
      expect(flagged, `arms that re-add the deleted flag: ${flagged.join(", ")}`).toEqual([]);
    }
  });

  it("neither range payload-map entry redeclares the deleted flag", () => {
    const region = payloadMapRegion();
    for (const code of RANGE_CODES) {
      expect(payloadBlock(region, code), `${code} redeclares reread`).not.toMatch(
        /reread\?\s*:\s*boolean/,
      );
    }
  });

  it("scanner stays sighted on the flag in both directions", () => {
    const without = sitesFromText(
      "function f() {\n" +
        "  throw new ServedRejectionError({\n" +
        '    code: "E_STALE_RANGE",\n' +
        '    headline: "h",\n' +
        "    servedRows: [],\n" +
        '    servedBlock: "",\n' +
        "  });\n" +
        "}\n",
      "planted.ts",
    );
    expect(without).toHaveLength(1);
    expect(without[0]!.code).toBe("E_STALE_RANGE");
    expect(without[0]!.reread).toBe(false);
    const withFlag = sitesFromText(
      'throw new ServedRejectionError({ code: "E_STALE_RANGE", reread: true });\n',
      "planted.ts",
    );
    expect(withFlag.map((s) => s.reread)).toEqual([true]);
    const commented =
      '// throw new ServedRejectionError({ code: "E_STALE_RANGE", reread: true });\n' +
      'const s = "throw new ServedRejectionError({";\n';
    expect(sitesFromText(commented, "commented.ts")).toHaveLength(0);
  });
});
