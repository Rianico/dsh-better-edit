import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFERRED_PRODUCERS,
  ERROR_REGISTRY,
  WARNING_REGISTRY,
  isDomainErrorCode,
  isDomainWarningCode,
} from "../../src/domain-errors.js";

/**
 * Arch oracle for the domain-error registry (T1 contract ticket).
 *
 * Method: read `src/**` with node:fs and match with precise regexes (no
 * imports of the scanned modules, so the oracle cannot be fooled by runtime
 * shape). Runtime registry imports are used only where the ticket names them
 * (union membership via isDomainErrorCode / isDomainWarningCode, remedy and
 * audience declarations).
 *
 * Producer positions counted (per code):
 * - `new DomainError("<CODE>"`, `formatError("<CODE>"`
 * - `formatWarning("<CODE>"` (warnings)
 * - subclass constructions with a fixed code: `new EditHashEchoError(` →
 *   E_SUSPICIOUS_TEXT, `new BadAnchorError(` → E_MALFORMED_ANCHOR,
 *   `new AnchorSpaceExhaustedError(` → E_LARGE_FILE
 * - subclass constructions with a literal code argument:
 *   `new AnchorMismatchError("<CODE>", …)`,
 *   `new ServedRejectionError({ code: "<CODE>", … })`
 *
 * Errno exclusion: every producer regex requires a quoted literal starting
 * `E_`/`W_` followed by `[A-Z_]+`. Errno-style codes (ENOENT, EACCES, EPERM,
 * ELOOP) have no underscore after the E and never match; moreover only
 * registry-call positions are scanned, so errno comparisons elsewhere
 * (`code === "ENOENT"`) are outside the scan by construction.
 */

// Vitest runs with the package root as cwd; the oracle scans the source tree
// (never test/), so producer evidence cannot come from fixtures.
const SRC_ROOT = join(process.cwd(), "src");
const REGISTRY_FILE = join(SRC_ROOT, "domain-errors.ts");

function listSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

function unionMembers(source: string, name: string): string[] {
  // Strip comments first: a `;` inside prose (e.g. the RETIRING note) must
  // not terminate the union block early and silently drop trailing members.
  const bare = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const block = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(bare);
  expect(block?.[1], `${name} union block parses`).toBeDefined();
  const members = [...block![1].matchAll(/"([EW]_[A-Z_]+)"/g)].map((m) => m[1]!);
  expect(new Set(members).size).toBe(members.length);
  return members;
}

const PRODUCER_PATTERNS: Array<{ re: RegExp; code: (m: RegExpMatchArray) => string }> = [
  { re: /new\s+DomainError\(\s*"([EW]_[A-Z_]+)"/g, code: (m) => m[1]! },
  { re: /formatError\(\s*"([EW]_[A-Z_]+)"/g, code: (m) => m[1]! },
  { re: /formatWarning\(\s*"([EW]_[A-Z_]+)"/g, code: (m) => m[1]! },
  { re: /new\s+EditHashEchoError\(/g, code: () => "E_SUSPICIOUS_TEXT" },
  { re: /new\s+BadAnchorError\(/g, code: () => "E_MALFORMED_ANCHOR" },
  { re: /new\s+AnchorSpaceExhaustedError\(/g, code: () => "E_LARGE_FILE" },
  { re: /new\s+AnchorMismatchError\(\s*"([EW]_[A-Z_]+)"/g, code: (m) => m[1]! },
  { re: /new\s+ServedRejectionError\(\s*\{\s*code:\s*"([EW]_[A-Z_]+)"/g, code: (m) => m[1]! },
];

function producedCodes(files: string[]): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    for (const { re, code } of PRODUCER_PATTERNS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) found.add(code(m));
    }
  }
  return found;
}

const RAW_HEADER_RE = /\[(MODEL|USER)\]\s*\[(E_|W_)[A-Z_]+\]/;

describe("arch: domain-error registry", () => {
  const files = listSources(SRC_ROOT);
  const registrySource = readFileSync(REGISTRY_FILE, "utf-8");
  const errorMembers = unionMembers(registrySource, "DomainErrorCode");
  const warningMembers = unionMembers(registrySource, "DomainWarningCode");
  const produced = producedCodes(files);
  const deferred = new Set(Object.keys(DEFERRED_PRODUCERS));

  it("totality forward: every code is produced or deferred", () => {
    const missingErrors = errorMembers.filter((c) => !produced.has(c) && !deferred.has(c));
    expect(missingErrors, `undeclared producers: ${missingErrors.join(", ")}`).toEqual([]);
    const missingWarnings = warningMembers.filter((c) => !produced.has(c) && !deferred.has(c));
    expect(missingWarnings, `undeclared producers: ${missingWarnings.join(", ")}`).toEqual([]);
  });

  it("totality backward (shrink-only): deferred codes have no producer and name a ticket", () => {
    for (const code of deferred) {
      expect(
        produced.has(code),
        `${code} gained a producer — remove it from DEFERRED_PRODUCERS`,
      ).toBe(false);
      expect(DEFERRED_PRODUCERS[code]).toMatch(/ticket/i);
    }
  });

  it("no inverse leaks: produced codes are declared union members", () => {
    for (const code of produced) {
      expect(
        isDomainErrorCode(code) || isDomainWarningCode(code),
        `${code} is produced but not a declared union member`,
      ).toBe(true);
    }
  });

  it("header uniqueness: no raw [AUDIENCE] [CODE] literal outside domain-errors.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === REGISTRY_FILE) continue;
      if (RAW_HEADER_RE.test(readFileSync(file, "utf-8"))) offenders.push(file);
    }
    expect(offenders, `raw headers in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("remedy eligibility: the five remedy-free codes carry no remedy", () => {
    for (const code of [
      "E_UNKNOWN",
      "E_UNKNOWN_ANCHOR",
      "E_FOREIGN_ANCHOR",
      "E_UNVERIFIED_RANGE",
      "E_NOOP_LOOP",
    ] as const) {
      expect(
        "remedy" in ERROR_REGISTRY[code],
        `${code} must carry no remedy (see registry header docs for WHY)`,
      ).toBe(false);
    }
  });

  it("audience: applied-tier warnings are USER, lease-shape warnings are MODEL", () => {
    for (const code of [
      "W_REVERSED_ANCHORS",
      "W_UNICODE_LITERAL",
      "W_LITERAL_BYPASS",
      "W_NOOP",
    ] as const) {
      expect(WARNING_REGISTRY[code].audience).toBe("USER");
    }
    for (const code of ["W_NEVER_SERVED_SHAPE", "W_SERVED_PREFIX_MISMATCH"] as const) {
      expect(WARNING_REGISTRY[code].audience).toBe("MODEL");
    }
  });
});
