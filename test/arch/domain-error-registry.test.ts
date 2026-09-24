import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  CODE_SHAPE,
  REGEX_LIMIT_TRIGGER,
  listSources,
  namesInCode,
  producedCodes,
  producedCodesInText,
  stripComments,
  unionMembers,
} from "../support/arch-scan.js";

/**
 * Arch oracle for the domain-error registry (T1 contract ticket; guards hardened
 * in T4 CP1-r5 and CP1-r6).
 *
 * Method: the shared scanner (`test/support/arch-scan.ts`) reads `src/**` and
 * matches precise regexes (no imports of the scanned modules, so the oracle
 * cannot be fooled by runtime shape). Runtime registry imports are used only
 * where a ticket names them (union membership via `isDomainErrorCode` /
 * `isDomainWarningCode`, the allowlists, audience declarations).
 *
 * Read `test/support/arch-scan.ts`'s header before adding a guard here. It holds
 * the scanner's method, naming rules, errno exclusion, the **CEILING — DEFERRED**
 * item (a text scanner cannot establish “every registry code has a producer”; the
 * durable form is observational, via a construction-recording factory), the
 * **TWO INDEPENDENT REFERENTS** rule (a guard comparing one referent to itself is
 * a tautology wearing a test's clothes), the **PREMISE** (`tsc --noEmit` in CI is
 * what makes the scanner sound) and **DECLARED LIMIT 3** (regex literals — a
 * different class, whose failure mode is LOUD). C19 below asserts the three
 * declared limits on a planted temp tree; C20 asserts the premise is stated.
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
const SCANNER_FILE = join(process.cwd(), "test/support/arch-scan.ts");

// F3 (strengthened, G3/H2): ANY [E_*]/[W_*] header literal is forbidden —
// audience or not, digits included. Derived from the shared shape, so it cannot
// drift from the union/producer scans. Comments/docblocks are stripped before
// scanning (prose may name codes), and src/utils.ts's CODED_RE is allowlisted by
// name: it is the legacy header *reader* (message-convention fallback), not a
// producer.
const RAW_HEADER_RE = new RegExp(`\\[${CODE_SHAPE}\\]`);

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
 * H6: when the scan hides a producer the guard fails with
 * `undeclared producers: E_X`. That message must name the declared limits, so a
 * false RED is diagnosable instead of inviting a weaker guard.
 */
export const UNDECLARED_PRODUCER_POINTER =
  "if a real producer exists, see DECLARED LIMITS in test/support/arch-scan.ts (regex literals; .mjs; variable-held)";

/** The exact message the totality guard renders — used by the guard and by C19. */
export function undeclaredProducerMessage(missing: readonly string[]): string {
  return `undeclared producers: ${missing.join(", ")} — ${UNDECLARED_PRODUCER_POINTER}`;
}

/**
 * C7/C16 (A2′, G6/G7): the allowlists pinned BY IDENTITY — the test's own copy
 * of the data half. `owner` values are addressable identities
 * (`ADDRESSABLE_OWNER_RE`), never bare lane letters: `T6` alone is ambiguous
 * (`docs/absorption-plan.md:35` = README+CONTEXT merge; the T4 brief = multi-
 * window read), so the deferred owners carry `Q-T6` plus the disambiguating
 * content. The predicates are pinned in C17 and asserted separately in the cells
 * below, so they are never recycled as their own referent.
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

/**
 * C17 (H1/H7): the predicates pinned BY SOURCE TEXT. A behavioural pin cannot
 * refute `holds: () => true` — the ticket measured it passing `tsc` and the whole
 * oracle — because “the entry's predicate holds” and “no producer exists” are
 * different propositions. A predicate change must touch this table.
 */
const FIELD_PREDICATES = {
  remedy: '() => Object.values(ERROR_REGISTRY).some((spec) => "remedy" in spec)',
} as const;

const DEFERRED_PREDICATES = {
  W_NEVER_SERVED_SHAPE: '() => isDomainWarningCode("W_NEVER_SERVED_SHAPE")',
  W_SERVED_PREFIX_MISMATCH: '() => isDomainWarningCode("W_SERVED_PREFIX_MISMATCH")',
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

interface RegistryFindings {
  files: string[];
  produced: Set<string>;
  undeclaredProducers: string[];
  rawHeaders: string[];
}

/**
 * THE FULL ORACLE's computation, over any `src/` root. Factored out so C19 can
 * run the *actual* guard over a planted temp tree instead of a unit-level probe.
 */
function registryFindings(srcRoot: string): RegistryFindings {
  const files = listSources(srcRoot);
  const registryFile = join(srcRoot, "domain-errors.ts");
  const registrySource = readFileSync(registryFile, "utf-8");
  const produced = producedCodes(files);
  const deferred = new Set(Object.keys(DEFERRED_PRODUCERS));
  const members = [
    ...unionMembers(registrySource, "DomainErrorCode"),
    ...unionMembers(registrySource, "DomainWarningCode"),
  ];
  const rawHeaders: string[] = [];
  for (const file of files) {
    if (file === registryFile) continue;
    rawHeaders.push(...findRawHeaders(file, readFileSync(file, "utf-8")));
  }
  return {
    files,
    produced,
    undeclaredProducers: members.filter((c) => !produced.has(c) && !deferred.has(c)),
    rawHeaders,
  };
}

/** Run the full oracle over a temp copy of `src/` with one plant applied. */
function findingsAfterPlant(plant: (dest: string) => void): RegistryFindings {
  const root = mkdtempSync(join(tmpdir(), "arch-plant-"));
  try {
    const dest = join(root, "src");
    cpSync(SRC_ROOT, dest, { recursive: true });
    plant(dest);
    return registryFindings(dest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Declare an extra union member in a temp tree's registry. */
function declareMember(dest: string, name: string): void {
  const file = join(dest, "domain-errors.ts");
  const text = readFileSync(file, "utf-8");
  const anchor = '  | "E_STALE_RANGE"';
  expect(text.includes(anchor), "plant anchor exists in the temp registry").toBe(true);
  writeFileSync(file, text.replace(anchor, `${anchor}\n  | "${name}"`), "utf-8");
}

/** The oracle's own referent for “this field is declaration-only”. */
function readersOfField(files: string[], field: string): string[] {
  return files.filter((file) =>
    new RegExp(`\\.${field}\\b`).test(stripComments(readFileSync(file, "utf-8"))),
  );
}

describe("arch: domain-error registry", () => {
  const files = listSources(SRC_ROOT);
  const registrySource = readFileSync(join(SRC_ROOT, "domain-errors.ts"), "utf-8");
  const errorMembers = unionMembers(registrySource, "DomainErrorCode");
  const warningMembers = unionMembers(registrySource, "DomainWarningCode");
  const produced = producedCodes(files);
  const deferred = new Set(Object.keys(DEFERRED_PRODUCERS));

  it("totality forward: every code is produced or deferred", () => {
    const findings = registryFindings(SRC_ROOT);
    // H6: the failure message names the declared limits (asserted end-to-end in C19).
    expect(
      findings.undeclaredProducers,
      undeclaredProducerMessage(findings.undeclaredProducers),
    ).toEqual([]);
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

  // C17 (H1/H7): the predicate itself is pinned by source text, for BOTH
  // allowlists. `holds: () => true` passes every behavioural check in this file
  // (measured: tsc accepted, oracle green) — only a text pin refutes it.
  it("`holds` predicates are pinned by source text, both allowlists (C17)", () => {
    for (const [field, entry] of Object.entries(DECLARATION_ONLY_FIELDS)) {
      expect(String(entry.trigger.holds), `${field} holds source text`).toBe(
        FIELD_PREDICATES[field as keyof typeof FIELD_PREDICATES],
      );
    }
    for (const [code, entry] of Object.entries(DEFERRED_PRODUCERS)) {
      expect(String(entry.trigger.holds), `${code} holds source text`).toBe(
        DEFERRED_PREDICATES[code as keyof typeof DEFERRED_PREDICATES],
      );
    }
    // DECLARED LIMIT 3's trigger is multi-line, so it is pinned by its
    // discriminating tokens — still refutable: `() => true` contains none.
    const limitSource = String(REGEX_LIMIT_TRIGGER.holds);
    expect(limitSource).toContain("package.json");
    expect(limitSource).toContain("PARSER_DEPS.some");
    expect(limitSource).not.toContain("=> true");
    expect(REGEX_LIMIT_TRIGGER.holds(), "no parser dependency has arrived yet").toBe(true);
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

  // C15 (G4): the other direction — every declared union member (and every
  // warning member) must have a registry entry, so a code cannot be declared
  // with no spec. Measured at HEAD: errors 24/24, warnings 6/6, no leaks in
  // either direction for either union.
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
    const offenders = registryFindings(SRC_ROOT).rawHeaders;
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

  // C8 (A3′/A4, F10 + G6): FORWARD — every declared field is rendered or in the
  // src allowlist; SHRINK-ONLY — an allowlisted field that gains a reader must
  // leave the list. The reader scan is the oracle's own referent.
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

  // C16 (G6/G7): the field allowlist pinned by identity, with the owner and
  // trigger as ADDRESSABLE identities, and BOTH referents asserted: the src-side
  // predicate and the oracle's independent recomputation.
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

  // C18 (H2): one knob. Every consumer of the code shape derives from
  // CODE_SHAPE/QUOTED_CODE — no private copy can survive a narrowing.
  it("every shape literal derives from CODE_SHAPE/QUOTED_CODE (C18)", () => {
    // (1) Behavioral: a digit-bearing name must be seen by all three consumers.
    expect(unionMembers('export type T =\n  | "E_RANGE2";\n', "T")).toEqual(["E_RANGE2"]);
    expect(producedCodesInText('new DomainError("E_RANGE2", { cause: "x" });\n')).toEqual([
      "E_RANGE2",
    ]);
    expect(findRawHeaders("src/fake.ts", 'const x = "[MODEL] [E_RANGE2] boom";\n')).toHaveLength(1);
    // (2) The oracle's header regex is built from the shared shape.
    expect(RAW_HEADER_RE.source).toContain(CODE_SHAPE);
    // (3) Structural: the only bracketed shape literal in the scanner is the
    // CODE_SHAPE definition itself — a private copy fails here.
    const scanner = stripComments(readFileSync(SCANNER_FILE, "utf-8"));
    const shapeLines = scanner.split("\n").filter((line) => line.includes(CODE_SHAPE));
    expect(shapeLines, `shape literals: ${shapeLines.join(" | ")}`).toHaveLength(1);
    expect(shapeLines[0]).toContain("CODE_SHAPE");
  });

  // C19 (H3/H4/H6): the three DECLARED LIMITS, asserted by running the FULL
  // oracle over a temp copy of `src/` with the undetectable producer planted —
  // the limit is recorded where it bites. Each limit's failure is LOUD (a false
  // “undeclared producer”), which is the trade we accept over a silent hide.
  it("DECLARED LIMIT (full oracle): a variable-held producer reports LOUD", () => {
    const findings = findingsAfterPlant((dest) => {
      declareMember(dest, "E_HELD_R2");
      const file = join(dest, "domain-errors.ts");
      writeFileSync(
        file,
        `${readFileSync(file, "utf-8")}\nconst HELD_CODE = "E_HELD_R2";\nvoid new DomainError(HELD_CODE, { cause: "held" });\n`,
        "utf-8",
      );
    });
    expect(findings.undeclaredProducers).toContain("E_HELD_R2");
    // H6: the false RED is diagnosable, not confusing.
    expect(undeclaredProducerMessage(findings.undeclaredProducers)).toContain(
      UNDECLARED_PRODUCER_POINTER,
    );
  });

  it("DECLARED LIMIT (full oracle): a .mjs producer reports LOUD", () => {
    const findings = findingsAfterPlant((dest) => {
      declareMember(dest, "E_MJS_R2");
      writeFileSync(
        join(dest, "planted-producer.mjs"),
        'new DomainError("E_MJS_R2", { cause: "mjs" });\n',
        "utf-8",
      );
    });
    expect(findings.undeclaredProducers).toContain("E_MJS_R2");
    // The scan covers *.ts by design (the PREMISE: a .mjs is never typechecked).
    expect(findings.files.some((file) => file.endsWith(".mjs"))).toBe(false);
  });

  it("DECLARED LIMIT (full oracle): a regex-literal `//` hides a producer LOUDLY", () => {
    // The measured plant (r6): a legal regex literal whose raw text holds `//`.
    const PRODUCER = 'throw new DomainError("E_AMBIGUOUS_MATCH", { path: rawPath, matches });';
    const plantOnProducerLine = (prefix: string) => (dest: string) => {
      const file = join(dest, "tool-str-replace-editor.ts");
      const text = readFileSync(file, "utf-8");
      expect(text.includes(PRODUCER), "producer line found in the temp tree").toBe(true);
      writeFileSync(file, text.replace(PRODUCER, `${prefix}${PRODUCER}`), "utf-8");
    };
    const blind = findingsAfterPlant(plantOnProducerLine("void /[//]/; "));
    expect(blind.undeclaredProducers).toContain("E_AMBIGUOUS_MATCH");
    // CONTROL: identical line shape, a regex without `//` — the producer is seen.
    const control = findingsAfterPlant(plantOnProducerLine("void /a/; "));
    expect(control.undeclaredProducers).not.toContain("E_AMBIGUOUS_MATCH");
  });

  // C20 (H5/H8): the stripper's input assumption is stated, and the premise that
  // keeps it true is stated once — a doc cell so neither can be deleted silently.
  it("the stripper's doc comment states the well-formed-input premise (C20)", () => {
    const source = readFileSync(SCANNER_FILE, "utf-8");
    const doc = source.slice(
      source.indexOf("String-literal-aware comment stripper"),
      source.indexOf("export function stripComments"),
    );
    expect(doc).toContain("INPUT ASSUMPTION");
    expect(doc).toContain("well-formed");
    expect(doc).toContain("unterminated block comment deletes the rest");
    expect(doc).toContain("unterminated string keeps the rest verbatim");
    expect(doc).toContain("tsc --noEmit");
    expect(doc).toContain("issue #75");
    // The premise is stated in the header, names the .mjs limit, and keeps the
    // regex-literal limit in its own class (H8).
    const header = source.slice(source.indexOf("The PREMISE (stated once"));
    expect(header).toContain(".mjs");
    expect(header).toContain("DECLARED LIMIT 3 — regex literals (a DIFFERENT class");
    expect(header).toContain("FAILURE MODE: LOUD");
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
