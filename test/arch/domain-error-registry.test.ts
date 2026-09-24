import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADDRESSABLE_OWNER_RE,
  DECLARATION_ONLY_FIELDS,
  DEFERRED_PRODUCERS,
  ERROR_REGISTRY,
  WARNING_REGISTRY,
  isDomainErrorCode,
  isDomainWarningCode,
} from "../../src/domain-errors.js";
import {
  listSources,
  namesInCode,
  producedCodes,
  stripComments,
  unionMembers,
} from "../support/arch-scan.js";

/**
 * Arch oracle for the domain-error registry (T1 contract ticket; guards hardened
 * in T4 CP1-r5).
 *
 * Method: the shared scanner (`test/support/arch-scan.ts`) reads `src/**` and
 * matches precise regexes (no imports of the scanned modules, so the oracle
 * cannot be fooled by runtime shape). Runtime registry imports are used only
 * where a ticket names them (union membership via `isDomainErrorCode` /
 * `isDomainWarningCode`, the allowlists, audience declarations).
 *
 * The scanner's own method, naming rules, errno exclusion, the **CEILING —
 * DEFERRED** item (a text scanner cannot establish “every registry code has a
 * producer”; the durable form is observational, via a construction-recording
 * factory; trigger = the next evasion class or the next ticket that touches
 * domain-error construction; owner unassigned post-map; NOT built in T4) and the
 * **TWO INDEPENDENT REFERENTS** rule (every guard compares a `src/` source of
 * truth against the test's own expectation — one referent is a tautology wearing
 * a test's clothes) all live in that file's header. Read it before adding a
 * guard here; the two DECLARED LIMIT cells in `registry-scan-controls.test.ts`
 * are the honest floor under this oracle's claims.
 *
 * Producer positions counted (per code), all quote-style aware and digits-legal:
 * - `new DomainError("<CODE>"`, `formatError("<CODE>"`
 * - `formatWarning("<CODE>"` (warnings)
 * - subclass constructions with a fixed code: `new EditHashEchoError(` →
 *   E_SUSPICIOUS_TEXT, `new BadAnchorError(` → E_MALFORMED_ANCHOR,
 *   `new AnchorSpaceExhaustedError(` → E_LARGE_FILE
 * - subclass constructions with a literal code argument:
 *   `new AnchorMismatchError("<CODE>", …)`,
 *   `new ServedRejectionError({ code: "<CODE>", … })`
 */

// Vitest runs with the package root as cwd; the oracle scans the source tree
// (never test/), so producer evidence cannot come from fixtures.
const SRC_ROOT = join(process.cwd(), "src");
const REGISTRY_FILE = join(SRC_ROOT, "domain-errors.ts");

// F3 (strengthened, T4 CP1-r5 G3): ANY [E_*]/[W_*] header literal is forbidden —
// audience or not, digits included. Comments/docblocks are stripped before
// scanning (prose may name codes), and src/utils.ts's CODED_RE is allowlisted by
// name: it is the legacy header *reader* (message-convention fallback), not a
// producer.
const RAW_HEADER_RE = /\[(E|W)_[A-Z0-9_]+\]/;

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

/**
 * C7/C16 (A2′, T4 CP1-r5 G6/G7): the allowlists pinned BY IDENTITY — the test's
 * own copy of the data half. `owner` values are addressable identities
 * (`ADDRESSABLE_OWNER_RE`), never bare lane letters: `T6` alone is ambiguous
 * (`docs/absorption-plan.md:35` = README+CONTEXT merge; the T4 brief = multi-
 * window read), so the deferred owners carry `Q-T6` plus the disambiguating
 * content. The predicates are asserted separately (see the cells) so they are
 * never recycled as their own referent.
 */
const DEFERRED_OWNERS = {
  W_NEVER_SERVED_SHAPE: {
    owner: "Q-T6 (multi-window read — brief.md:70; NOT absorption-plan.md:35's T6)",
    trigger: { text: "Q-T6" },
  },
  W_SERVED_PREFIX_MISMATCH: {
    owner: "Q-T6 (multi-window read — brief.md:70; NOT absorption-plan.md:35's T6)",
    trigger: { text: "Q-T6" },
  },
} as const;

const FIELD_OWNERS = {
  remedy: {
    owner: "src/domain-errors.ts",
    trigger: { text: "src/domain-errors.ts" },
  },
} as const;

// A3′ (F10): the keys the renderer actually reads. `formatError`/`formatWarning`
// compose `[${spec.audience}] [${code}] ${spec.format(payload)}` and no other
// field is touched (measured at `3f4aca6`: `.audience` → 3 readers, `.format`
// → 2, `.remedy` → 0). Every other declared key must be in the src allowlist.
const RENDERED_FIELDS = new Set(["audience", "format"]);

/** Data half of an allowlist map: `{ key: { owner, trigger: { text } } }`. */
function dataHalf(map: Readonly<Record<string, { owner: string; trigger: { text: string } }>>) {
  return Object.fromEntries(
    Object.entries(map).map(([key, entry]) => [
      key,
      { owner: entry.owner, trigger: { text: entry.trigger.text } },
    ]),
  );
}

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
    // Identity FIRST: the data half is pinned by value, so an owner change must
    // touch this test. Shape checks are secondary — `/ticket/i` could not fail
    // while a rot-marker string was present (decision-r1 §1), which is how
    // "range-family ticket (leases)" survived a whole lane.
    expect(dataHalf(DEFERRED_PRODUCERS)).toEqual(DEFERRED_OWNERS);
    for (const code of deferred) {
      // REFERENT 1 (src): the entry's own predicate over live objects.
      expect(
        DEFERRED_PRODUCERS[code]!.trigger.holds(),
        `${code} trigger no longer holds — the entry must be removed or reconciled`,
      ).toBe(true);
      // REFERENT 2 (test): the producer scan, recomputed here — never read back
      // out of the entry it is checking.
      expect(
        produced.has(code),
        `${code} gained a producer — remove it from DEFERRED_PRODUCERS`,
      ).toBe(false);
      expect(
        ADDRESSABLE_OWNER_RE.test(DEFERRED_PRODUCERS[code]!.owner),
        `${code} owner "${DEFERRED_PRODUCERS[code]!.owner}" is not an addressable identity — a bare lane letter is ambiguous (T6 collides)`,
      ).toBe(true);
      expect(
        ADDRESSABLE_OWNER_RE.test(DEFERRED_PRODUCERS[code]!.trigger.text),
        `${code} trigger text "${DEFERRED_PRODUCERS[code]!.trigger.text}" is not an addressable artifact`,
      ).toBe(true);
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
    expect(namesInCode(files, deleted), "re-declared without a producer (code, not prose)").toEqual(
      [],
    );
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

  // C15 (T4 CP1-r5 G4): the other direction — every declared union member (and
  // every warning member) must have a registry entry, so a code cannot be
  // declared with no spec. Measured at HEAD: errors 24/24, warnings 6/6, no
  // leaks in either direction for either union.
  it("union and registry agree in both directions", () => {
    const errorKeys = new Set(Object.keys(ERROR_REGISTRY));
    const warningKeys = new Set(Object.keys(WARNING_REGISTRY));
    const declaredWithoutSpec = [
      ...errorMembers.filter((c) => !errorKeys.has(c)),
      ...warningMembers.filter((c) => !warningKeys.has(c)),
    ];
    expect(declaredWithoutSpec, `union members with no registry entry`).toEqual([]);
    const specWithoutMember = [
      ...[...errorKeys].filter((c) => !errorMembers.includes(c)),
      ...[...warningKeys].filter((c) => !warningMembers.includes(c)),
    ];
    expect(specWithoutMember, `registry entries with no union member`).toEqual([]);
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

  // C8 (A3′/A4, F10 + T4 CP1-r5 G6): FORWARD — every declared field is rendered
  // or in the src allowlist; SHRINK-ONLY — an allowlisted field that gains a
  // reader must leave the list. The reader scan is the oracle's own referent.
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
    for (const field of Object.keys(DECLARATION_ONLY_FIELDS)) {
      const readers = readersOfField(files, field);
      expect(
        readers,
        `${field} gained a reader (${readers.join(", ")}) — remove it from DECLARATION_ONLY_FIELDS`,
      ).toEqual([]);
    }
  });

  // C16 (T4 CP1-r5 G6/G7): the field allowlist pinned by identity, with the owner
  // and trigger as ADDRESSABLE identities, and BOTH referents asserted: the
  // src-side predicate and the oracle's independent recomputation.
  it("the field allowlist is pinned by identity and its predicates hold", () => {
    expect(dataHalf(DECLARATION_ONLY_FIELDS)).toEqual(FIELD_OWNERS);
    for (const [field, entry] of Object.entries(DECLARATION_ONLY_FIELDS)) {
      expect(
        ADDRESSABLE_OWNER_RE.test(entry.owner),
        `${field} owner "${entry.owner}" is not an addressable identity (a bare lane letter or a sentence must fail)`,
      ).toBe(true);
      expect(
        ADDRESSABLE_OWNER_RE.test(entry.trigger.text),
        `${field} trigger text "${entry.trigger.text}" is not an addressable artifact`,
      ).toBe(true);
      // REFERENT 1 (src): the entry's own predicate over live objects.
      expect(
        entry.trigger.holds(),
        `${field} trigger no longer holds — the entry must be removed or reconciled`,
      ).toBe(true);
      // REFERENT 2 (test): the reader scan, recomputed here.
      expect(readersOfField(files, field), `${field} is no longer declaration-only`).toEqual([]);
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

/** The oracle's own referent for "this field is declaration-only". */
function readersOfField(files: string[], field: string): string[] {
  return files.filter((file) =>
    new RegExp(`\\.${field}\\b`).test(stripComments(readFileSync(file, "utf-8"))),
  );
}
