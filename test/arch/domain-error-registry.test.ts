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
  // Strip comments first: a `;` inside prose must not terminate the union
  // block early and silently drop trailing members. `stripComments` is the
  // string-literal-aware scanner (N2) — the naive regex version could also
  // delete real source when a string held `//`.
  const bare = stripComments(source);
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

// F3 (strengthened): ANY [E_*]/[W_*] header literal is forbidden — audience
// or not. Comments/docblocks are stripped before scanning (prose may name
// codes), and src/utils.ts's CODED_RE is allowlisted by name: it is the
// legacy header *reader* (message-convention fallback), not a producer.
const RAW_HEADER_RE = /\[(E|W)_[A-Z_]+\]/;

// N2: string-literal-aware comment stripper. The naive regex version
// treated a `/*` (or `//`) inside a string literal — e.g. a glob like
// "src/**/*.ts" — as a comment opener and silently deleted real source
// from the scan. This scanner tracks ', ", ` (with backslash escapes) and
// only strips // and /* … */ outside a string. Newlines inside block
// comments are preserved so reported line numbers stay stable.
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

/** Per-file raw-header scan; factored for the N2 self-check below. */
function findRawHeaders(file: string, text: string): string[] {
  const hits: string[] = [];
  const lines = stripComments(text).split("\n");
  lines.forEach((line, index) => {
    if (!RAW_HEADER_RE.test(line)) return;
    // Allowlist by name: CODED_RE is the legacy header reader, not a producer.
    if (file.endsWith("src/utils.ts") && line.includes("CODED_RE")) return;
    hits.push(`${file}:${index + 1}:${line.trim().slice(0, 80)}`);
  });
  return hits;
}

// A2′ (F10): the deferral is pinned BY IDENTITY, not by shape. An owner that
// changes must touch this test, which makes the change deliberate instead of
// silent.
const DEFERRED_OWNERS = {
  W_NEVER_SERVED_SHAPE: {
    owner: "T6 (multi-window read / region-scoped serves)",
    trigger: "region-scoped serves land",
  },
  W_SERVED_PREFIX_MISMATCH: {
    owner: "T6 (multi-window read / region-scoped serves)",
    trigger: "region-scoped serves land",
  },
} as const;

// A3′ (F10): the keys the renderer actually reads. `formatError`/`formatWarning`
// compose `[${spec.audience}] [${code}] ${spec.format(payload)}` and no other
// field is touched (measured at `3f4aca6`: `.audience` → 3 readers, `.format`
// → 2, `.remedy` → 0). Every other declared key must be listed below with an
// owner and a trigger, so a NEW unrendered field fails immediately.
const RENDERED_FIELDS = new Set(["audience", "format"]);
const DECLARATION_ONLY_FIELDS = {
  remedy: {
    owner: "registry header — declaration-only (the WHY `remedy` is never rendered note)",
    trigger:
      "removed when remedy gains a renderer (then delete the entry), or the field itself is deleted",
  },
} as const;
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

  it("totality backward: deferred codes name a ticket and a trigger", () => {
    // Identity FIRST: every entry is pinned by value, so an owner change must
    // touch this test. Shape checks are secondary — `/ticket/i` could not fail
    // while a rot-marker string was present (decision-r1 §1), which is how
    // "range-family ticket (leases)" survived a whole lane.
    expect(DEFERRED_PRODUCERS).toEqual(DEFERRED_OWNERS);
    for (const code of deferred) {
      expect(
        produced.has(code),
        `${code} gained a producer — remove it from DEFERRED_PRODUCERS`,
      ).toBe(false);
      expect(DEFERRED_PRODUCERS[code]!.owner, `${code} owner is ticket-shaped`).toMatch(/^T\d+/);
      expect(
        DEFERRED_PRODUCERS[code]!.trigger.trim().length,
        `${code} trigger is non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  // C9 (F10): the deletion is a commitment, not a tidy-up. The four names may
  // live in PROSE — the `DEFERRED_PRODUCERS` doc comment is the record — never
  // in code, so the scan strips comments first. The union half is what a ported
  // upstream producer trips: the code must come back WITH its producer.
  it("deleting a deferred code's producer *stays* deleted", () => {
    const deleted = [
      "E_UNKNOWN_ANCHOR",
      "E_FOREIGN_ANCHOR",
      "E_TARGET_LOST",
      "E_UNVERIFIED_RANGE",
    ] as const;
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf-8"));
      for (const name of deleted) {
        if (code.includes(name)) offenders.push(`${file}:${name}`);
      }
    }
    expect(offenders, `re-declared without a producer: ${offenders.join(", ")}`).toEqual([]);
    for (const name of deleted) {
      expect(
        isDomainErrorCode(name),
        `${name} is a union member again — it must come back WITH a producer`,
      ).toBe(false);
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

  it("header uniqueness: no raw [E_*]/[W_*] literal outside domain-errors.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === REGISTRY_FILE) continue;
      const lines = findRawHeaders(file, readFileSync(file, "utf-8"));
      offenders.push(...lines);
    }
    expect(offenders, `raw headers in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("remedy eligibility: the remedy-free codes carry no remedy", () => {
    for (const code of ["E_UNKNOWN", "E_NOOP_LOOP"] as const) {
      expect(
        "remedy" in ERROR_REGISTRY[code],
        `${code} must carry no remedy (see registry header docs for WHY)`,
      ).toBe(false);
    }
  });

  // A3′/A4 (F10): FORWARD — every declared field is rendered or allowlisted
  // with an owner+trigger; SHRINK-ONLY — an allowlisted field that gains a
  // reader must leave the list. `remedy` is the only such field today
  // (measured: `git grep -n -E '\.remedy' 3f4aca6 -- src` → 0 reads).
  it("every registry field is rendered or declaration-only", () => {
    const entries = [...Object.entries(ERROR_REGISTRY), ...Object.entries(WARNING_REGISTRY)];
    for (const [code, spec] of entries) {
      for (const key of Object.keys(spec)) {
        expect(
          RENDERED_FIELDS.has(key) || key in DECLARATION_ONLY_FIELDS,
          `${code}.${key} is neither rendered nor declaration-only — render it, or add it to DECLARATION_ONLY_FIELDS with an owner+trigger`,
        ).toBe(true);
      }
    }
    for (const [field, entry] of Object.entries(DECLARATION_ONLY_FIELDS)) {
      expect(entry.owner.trim().length, `${field} allowlist entry needs an owner`).toBeGreaterThan(
        0,
      );
      expect(
        entry.trigger.trim().length,
        `${field} allowlist entry needs a trigger`,
      ).toBeGreaterThan(0);
      const readers = files.filter((file) =>
        new RegExp(`\\.${field}\\b`).test(stripComments(readFileSync(file, "utf-8"))),
      );
      expect(
        readers,
        `${field} gained a reader (${readers.join(", ")}) — remove it from DECLARATION_ONLY_FIELDS`,
      ).toEqual([]);
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
  // N2 self-check (planted evidence): a `/*` inside a string literal must
  // not swallow the real header on the next line. With the naive regex
  // stripper this reported [] (blind); the string-aware scanner reports line 2.
  it("scanner stays sighted when a string holds comment syntax (N2)", () => {
    const planted =
      'const glob = "src/**/*.ts /* not a comment";\nconst x = "[MODEL] [E_PLANTED] boom";\n/* real comment */\n';
    const hits = findRawHeaders("src/fake.ts", planted);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(":2:");
    expect(hits[0]).toContain("[E_PLANTED]");
    // And a real // comment holding a header stays stripped (prose is free).
    expect(findRawHeaders("src/fake.ts", "// [MODEL] [E_PLANTED] prose\nconst ok = 1;\n")).toEqual(
      [],
    );
  });
});
