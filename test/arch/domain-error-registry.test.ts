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
  formatReadWarning,
  isDomainErrorCode,
  isDomainWarningCode,
} from "../../src/domain-errors.js";
import {
  CODE_SHAPE,
  listSources,
  namesInCode,
  producedCodes,
  producedCodesInText,
  producedReadCodes,
  stripComments,
  unionMembers,
  firedWarnings,
} from "../support/arch-scan.js";
/**
 * Arch oracle for the domain-error registry. Method: the shared scanner in
 * `test/support/arch-scan.ts` reads `src/**` and matches precise regexes, never
 * importing the scanned modules; runtime imports are used only where a ticket
 * names them.
 * The scanner header (and `docs/agents/arch-guard-inventory.md`) owns the method,
 * naming rules, the CEILING — DEFERRED item, the TWO INDEPENDENT REFERENTS rule,
 * the PREMISE (`tsc --noEmit`) and DECLARED LIMIT 3; C19 asserts the three
 * declared limits on a planted tree and C20 the premise.
 * Producer positions: `new DomainError("<CODE>"`, `formatError("<CODE>"`,
 * `formatWarning("<CODE>"`, fixed-code and literal-code subclasses.
 */

const SRC_ROOT = join(process.cwd(), "src");
const SCANNER_FILE = join(process.cwd(), "test/support/arch-scan.ts");

const RAW_HEADER_RE = new RegExp(`\\[${CODE_SHAPE}\\]`);

/** Per-file raw-header scan; factored for the N2 self-check below. */
function findRawHeaders(file: string, text: string): string[] {
  const hits: string[] = [];
  const lines = stripComments(text).split("\n");
  lines.forEach((line, index) => {
    if (!RAW_HEADER_RE.test(line)) return;
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
const UNDECLARED_PRODUCER_POINTER =
  "if a real producer exists, see DECLARED LIMITS in test/support/arch-scan.ts (regex literals; .mjs; variable-held)";

/** The exact message the totality guard renders — used by the guard and by C19. */
function undeclaredProducerMessage(missing: readonly string[]): string {
  return `undeclared producers: ${missing.join(", ")} — ${UNDECLARED_PRODUCER_POINTER}`;
}

/**
 * C7/C16 (A2′, G6/G7): the allowlists pinned BY IDENTITY — the test's own copy
 * of the data half. `owner` values are addressable identities
 * (`ADDRESSABLE_OWNER_RE`), never bare lane letters or schedule slots: T6 replaced
 * the ambiguous `Q-T6` lane id with the producer seam the deferral waits on, so the
 * entry names a FILE that a landing producer must touch. The predicates are pinned
 * in C17 and asserted separately in the cells below, so they are never recycled as
 * their own referent (T6 R15: the mutant must break the real predicate, not a
 * caricature of it).
 */
const DEFERRED_OWNERS = {} as const;

const FIELD_OWNERS = {
  remedy: {
    owner: "src/domain-errors.ts",
    trigger: { text: "src/domain-errors.ts" },
  },
} as const;

/**
 * C17 (H1/H7; re-pointed by T6 CP2 F2): the `DECLARATION_ONLY_FIELDS` predicate is pinned
 * by source text; the `DEFERRED_PRODUCERS` predicates are pinned BEHAVIOURALLY (its own
 * code falsifies it, another code does not, an empty witness holds). A behavioural pin
 * refutes `holds: () => true` directly — stronger than a text copy of the body — and the
 * source scan recomputed in this file stays the independent second referent (C7).
 * Consequence for a future edit: changing a deferred predicate must touch the behavioural
 * cells below, never this table.
 */
const FIELD_PREDICATES = {
  remedy: '() => Object.values(ERROR_REGISTRY).some((spec) => "remedy" in spec)',
} as const;

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
  /** Read-tier producers (`formatReadWarning("<CODE>"`), a separate referent from `produced`. */
  readProduced: Set<string>;
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
  const readProduced = producedReadCodes(files);
  const deferred = new Set(Object.keys(DEFERRED_PRODUCERS));
  const members = [
    ...unionMembers(registrySource, "DomainErrorCode"),
    ...unionMembers(registrySource, "DomainWarningCode"),
    ...unionMembers(registrySource, "ReadWarningCode"),
  ];
  const rawHeaders: string[] = [];
  for (const file of files) {
    if (file === registryFile) continue;
    rawHeaders.push(...findRawHeaders(file, readFileSync(file, "utf-8")));
  }
  return {
    files,
    produced,
    readProduced,
    undeclaredProducers: members.filter(
      (c) => !produced.has(c) && !readProduced.has(c) && !deferred.has(c),
    ),
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
  const registryFile = join(SRC_ROOT, "domain-errors.ts");
  const registrySource = readFileSync(registryFile, "utf-8");
  const errorMembers = unionMembers(registrySource, "DomainErrorCode");
  const warningMembers = unionMembers(registrySource, "DomainWarningCode");
  const produced = producedCodes(files);
  const fired = firedWarnings(files);
  const deferred = new Set(Object.keys(DEFERRED_PRODUCERS));

  it("totality forward: every code is produced or deferred", () => {
    const findings = registryFindings(SRC_ROOT);
    expect(
      findings.undeclaredProducers,
      undeclaredProducerMessage(findings.undeclaredProducers),
    ).toEqual([]);
  });

  it("totality backward: deferred codes name a ticket and a trigger", () => {
    expect(dataHalf(DEFERRED_PRODUCERS)).toEqual(DEFERRED_OWNERS);
    for (const code of deferred) {
      expect(
        DEFERRED_PRODUCERS[code]!.trigger.holds(new Set()),
        `${code} trigger no longer holds — the entry must be removed or reconciled`,
      ).toBe(true);
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

  it("`holds` predicates are pinned by source text and by behaviour (C17)", () => {
    for (const [field, entry] of Object.entries(DECLARATION_ONLY_FIELDS)) {
      expect(String(entry.trigger.holds), `${field} holds source text`).toBe(
        FIELD_PREDICATES[field as keyof typeof FIELD_PREDICATES],
      );
    }
    // Ref: docs/adr/0056-comment-gate-ratchet.md — the limit-3 availability trigger retired with @babel/parser; the C19 cell keeps the regex-literal blind spot asserted.
  });

  it("the deferred predicates refute a constant: their own code falsifies, others do not", () => {
    for (const code of deferred) {
      const entry = DEFERRED_PRODUCERS[code]!;
      expect(String(entry.trigger.holds), `${code} names its own code`).toContain(code);
      expect(String(entry.trigger.holds), `${code} is not a constant`).not.toContain("=> true");
      expect(entry.trigger.holds(new Set()), `${code} holds with an empty witness`).toBe(true);
      expect(entry.trigger.holds(new Set([code])), `${code} falls on its own firing`).toBe(false);
      const others = [...deferred].filter((other) => other !== code);
      expect(entry.trigger.holds(new Set(others)), `${code} survives other codes`).toBe(true);
    }
  });

  it("W_NEVER_SERVED_SHAPE is a union member with a literal producer (FU-5)", () => {
    expect(isDomainWarningCode("W_NEVER_SERVED_SHAPE")).toBe(true);
    expect(fired.has("W_NEVER_SERVED_SHAPE")).toBe(true);
  });

  it("W_SERVED_PREFIX_MISMATCH is a union member with a literal producer (FU-5)", () => {
    expect(isDomainWarningCode("W_SERVED_PREFIX_MISMATCH")).toBe(true);
    expect(fired.has("W_SERVED_PREFIX_MISMATCH")).toBe(true);
  });

  it("the witness is per-call: a different source set yields a different witness and verdicts", () => {
    const dir = mkdtempSync(join(tmpdir(), "t6-witness-"));
    try {
      const plantedNever = join(dir, "planted-never.ts");
      writeFileSync(
        plantedNever,
        'export const x = formatWarning("W_NEVER_SERVED_SHAPE", { count: 1 });\n',
        "utf-8",
      );
      const plantedMismatch = join(dir, "planted-mismatch.ts");
      writeFileSync(
        plantedMismatch,
        'export const x = formatWarning("W_SERVED_PREFIX_MISMATCH", { k: 1, anchor: "aaa", servedLine: 1 });\n',
        "utf-8",
      );
      expect([...firedWarnings([plantedNever])].sort()).toEqual(["W_NEVER_SERVED_SHAPE"]);
      expect([...firedWarnings([plantedMismatch])].sort()).toEqual(["W_SERVED_PREFIX_MISMATCH"]);
      expect(firedWarnings([]).size).toBe(0);
      expect(fired.has("W_NEVER_SERVED_SHAPE")).toBe(true);
      expect(fired.has("W_SERVED_PREFIX_MISMATCH")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(namesInCode([registryFile], ["PRODUCED_WARNINGS", "firedWarnings"])).toEqual([]);
  });

  it("the four ported codes are union members WITH literal producers (C9, FU-4)", () => {
    const ported = [
      "E_UNKNOWN_ANCHOR",
      "E_FOREIGN_ANCHOR",
      "E_TARGET_LOST",
      "E_UNVERIFIED_RANGE",
    ] as const;
    for (const name of ported) {
      expect(isDomainErrorCode(name), `${name} is a declared union member`).toBe(true);
      expect(produced.has(name), `${name} has a literal-visible producer in src/`).toBe(true);
    }
  });

  it("no inverse leaks: produced codes are declared union members", () => {
    for (const code of produced) {
      expect(
        isDomainErrorCode(code) || isDomainWarningCode(code),
        `${code} is produced but not a declared union member`,
      ).toBe(true);
    }
    const readMembers = unionMembers(registrySource, "ReadWarningCode");
    for (const code of producedReadCodes(files)) {
      expect(
        readMembers.includes(code),
        `${code} is produced by formatReadWarning but not a declared ReadWarningCode member`,
      ).toBe(true);
    }
  });

  it("read-tier totality: every declared read warning is produced by formatReadWarning", () => {
    const readMembers = unionMembers(registrySource, "ReadWarningCode");
    expect(readMembers).toEqual(["W_MIXED_EOL"]);
    expect([...producedReadCodes(files)].sort()).toEqual([...readMembers].sort());
  });

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

  it("the audience-prefixed rejection header is composed only by formatError", () => {
    const hits: string[] = [];
    for (const file of listSources(SRC_ROOT)) {
      if (file.endsWith(join("src", "domain-errors.ts"))) continue;
      const text = stripComments(readFileSync(file, "utf-8"));
      for (const [index, line] of text.split("\n").entries()) {
        if (/\[TO (?:MODEL|USER)\] \[E_/.test(line) || /\[TO \$\{/.test(line)) {
          hits.push(`${file}:${index + 1}`);
        }
      }
    }
    expect(hits).toEqual([]);
    const registry = stripComments(readFileSync(join(SRC_ROOT, "domain-errors.ts"), "utf-8"));
    expect(registry.match(/\[TO \$\{/g)).toHaveLength(1);
    const planted = 'const leaked = "[TO MODEL] [E_STALE_RANGE] x";';
    expect(/\[TO (?:MODEL|USER)\] \[E_/.test(planted)).toBe(true);
    const plantedComposer = "const leaked = `[TO ${spec.audience}] [${code}] ${body}`;";
    expect(/\[TO \$\{/.test(plantedComposer)).toBe(true);
  });

  it("applied-tier warning headers are composed only by formatWarning", () => {
    const hits: string[] = [];
    for (const file of listSources(SRC_ROOT)) {
      if (file.endsWith(join("src", "domain-errors.ts"))) continue;
      const text = stripComments(readFileSync(file, "utf-8"));
      for (const [index, line] of text.split("\n").entries()) {
        if (/\[(?:MODEL|USER)\] \[W_/.test(line) || /\[\$\{[^}]+\}\] \[\$\{code\}\]/.test(line)) {
          hits.push(`${file}:${index + 1}`);
        }
      }
    }
    expect(hits).toEqual([]);
    const registry = stripComments(readFileSync(join(SRC_ROOT, "domain-errors.ts"), "utf-8"));
    expect(registry.match(/\[(?:TO )?\$\{spec\.audience\}\] \[\$\{code\}\]/g)).toHaveLength(2);
    const planted = 'const leaked = "[MODEL] [W_NOOP] x";';
    expect(/\[(?:MODEL|USER)\] \[W_/.test(planted)).toBe(true);
    const plantedComposer = "const leaked = `[${spec.audience}] [${code}] ${body}`;";
    expect(/\[\$\{[^}]+\}\] \[\$\{code\}\]/.test(plantedComposer)).toBe(true);
  });
  it("read-tier header carries no audience prefix", () => {
    const rendered = formatReadWarning("W_MIXED_EOL", {
      crlf: 1,
      lf: 1,
      cr: 0,
      target: "LF",
      source: "file",
    });
    expect(rendered.startsWith("[W_MIXED_EOL] ")).toBe(true);
    expect(rendered).not.toMatch(/\[(?:MODEL|USER)\]/);
  });

  it("remedy eligibility: the remedy-free codes carry no remedy", () => {
    for (const code of ["E_UNKNOWN", "E_NOOP_LOOP"] as const) {
      expect(
        "remedy" in ERROR_REGISTRY[code],
        `${code} must carry no remedy (see registry header docs for WHY)`,
      ).toBe(false);
    }
  });

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

  it("the field allowlist is pinned by identity and its predicates hold", () => {
    expect(dataHalf(DECLARATION_ONLY_FIELDS)).toEqual(FIELD_OWNERS);
    const fired = firedWarnings(files);
    for (const [field, entry] of Object.entries(DECLARATION_ONLY_FIELDS)) {
      expect(
        ADDRESSABLE_OWNER_RE.test(entry.owner),
        `${field} owner "${entry.owner}" is not an addressable identity (a bare lane letter or a sentence must fail)`,
      ).toBe(true);
      expect(
        ADDRESSABLE_OWNER_RE.test(entry.trigger.text),
        `${field} trigger text "${entry.trigger.text}" is not an addressable artifact`,
      ).toBe(true);
      expect(
        entry.trigger.holds(fired),
        `${field} trigger no longer holds — the entry must be removed or reconciled`,
      ).toBe(true);
      expect(readersOfField(files, field), `${field} is no longer declaration-only`).toEqual([]);
    }
  });

  it("every shape literal derives from CODE_SHAPE/QUOTED_CODE (C18)", () => {
    expect(unionMembers('export type T =\n  | "E_RANGE2";\n', "T")).toEqual(["E_RANGE2"]);
    expect(producedCodesInText('new DomainError("E_RANGE2", { cause: "x" });\n')).toEqual([
      "E_RANGE2",
    ]);
    expect(findRawHeaders("src/fake.ts", 'const x = "[TO MODEL] [E_RANGE2] boom";\n')).toHaveLength(
      1,
    );
    expect(RAW_HEADER_RE.source).toContain(CODE_SHAPE);
    const scanner = stripComments(readFileSync(SCANNER_FILE, "utf-8"));
    const shapeLines = scanner.split("\n").filter((line) => line.includes(CODE_SHAPE));
    expect(shapeLines, `shape literals: ${shapeLines.join(" | ")}`).toHaveLength(1);
    expect(shapeLines[0]).toContain("CODE_SHAPE");
  });

  it("DECLARED LIMIT (full oracle): a variable-held producer reports LOUD", () => {
    const findings = findingsAfterPlant((dest) => {
      declareMember(dest, "E_HELD_R");
      const file = join(dest, "domain-errors.ts");
      writeFileSync(
        file,
        `${readFileSync(file, "utf-8")}\nconst HELD_CODE = "E_HELD_R";\nvoid new DomainError(HELD_CODE, { cause: "held" });\n`,
        "utf-8",
      );
    });
    expect(findings.undeclaredProducers).toContain("E_HELD_R");
    expect(undeclaredProducerMessage(findings.undeclaredProducers)).toContain(
      UNDECLARED_PRODUCER_POINTER,
    );
  });

  it("DECLARED LIMIT (full oracle): a .mjs producer reports LOUD", () => {
    const findings = findingsAfterPlant((dest) => {
      declareMember(dest, "E_MJS_R");
      writeFileSync(
        join(dest, "planted-producer.mjs"),
        'new DomainError("E_MJS_R", { cause: "mjs" });\n',
        "utf-8",
      );
    });
    expect(findings.undeclaredProducers).toContain("E_MJS_R");
    expect(findings.files.some((file) => file.endsWith(".mjs"))).toBe(false);
  });

  it("DECLARED LIMIT (full oracle): a regex-literal `//` hides a producer LOUDLY", () => {
    const PRODUCER = 'throw new DomainError("E_AMBIGUOUS_MATCH", { path: rawPath, matches });';
    const plantOnProducerLine = (prefix: string) => (dest: string) => {
      const file = join(dest, "tool-str-replace-editor.ts");
      const text = readFileSync(file, "utf-8");
      expect(text.includes(PRODUCER), "producer line found in the temp tree").toBe(true);
      writeFileSync(file, text.replace(PRODUCER, `${prefix}${PRODUCER}`), "utf-8");
    };
    const blind = findingsAfterPlant(plantOnProducerLine("void /[//]/; "));
    expect(blind.undeclaredProducers).toContain("E_AMBIGUOUS_MATCH");
    const control = findingsAfterPlant(plantOnProducerLine("void /a/; "));
    expect(control.undeclaredProducers).not.toContain("E_AMBIGUOUS_MATCH");
  });

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
    const header = source.slice(source.indexOf("The PREMISE (stated once"));
    expect(header).toContain(".mjs");
    expect(header).toContain("DECLARED LIMIT 3 — regex literals (a DIFFERENT class");
    expect(header).toContain("FAILURE MODE: LOUD");
  });

  it("audience: model-actionable warnings are MODEL, passive applied notices USER", () => {
    for (const code of ["W_REVERSED_ANCHORS", "W_UNICODE_LITERAL", "W_LITERAL_BYPASS"] as const) {
      expect(WARNING_REGISTRY[code].audience).toBe("USER");
    }
    for (const code of ["W_NOOP", "W_NEVER_SERVED_SHAPE", "W_SERVED_PREFIX_MISMATCH"] as const) {
      expect(WARNING_REGISTRY[code].audience).toBe("MODEL");
    }
  });

  it("scanner stays sighted when a string holds comment syntax (N2)", () => {
    const planted =
      'const glob = "src/**/*.ts /* not a comment";\nconst x = "[TO MODEL] [E_PLANTED] boom";\n/* real comment */\n';
    const hits = findRawHeaders("src/fake.ts", planted);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(":2:");
    expect(hits[0]).toContain("[E_PLANTED]");
    // And a real // comment holding a header stays stripped (prose is free).
    expect(
      findRawHeaders("src/fake.ts", "// [TO MODEL] [E_PLANTED] prose\nconst ok = 1;\n"),
    ).toEqual([]);
  });
});
