import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WARNING_REGISTRY } from "../../src/domain-errors.js";
import { firedWarnings, listSources, stripComments } from "../support/arch-scan.js";

/**
 * Applied-notice tier oracle (#115).
 *
 * Two channels, two header families: an applied mutation's notice is a `[W_*]`
 * line (composed by `formatWarning`), a refusal is an `[E_*]` line (composed by
 * `formatError`). #115 reported an `[E_*]` header on a success path — a
 * null-file `Autocorrected` notice rendered from `formatError`. #117 retired
 * that producer at admission (a null file is now `E_BAD_PAYLOAD`), so this
 * oracle pins the tier for the paths that remain: no applied-notice expression
 * may carry an error composer, and every applied notice must come from
 * `formatWarning` with a registry `W_*` code.
 *
 * Method: the shared scanner (`test/support/arch-scan.ts`) reads text, so the
 * same guard runs over the live `src/` tree AND over planted fixture strings.
 * The planted cells are the refutability evidence: a guard whose pattern was
 * deleted would pass the live tree vacuously, but fails the plant.
 *
 * Two independent referents: the live tree (`listSources` + regex scan) versus
 * this test's expectations, and `WARNING_REGISTRY`'s declared keys versus the
 * `formatWarning("<CODE>"` call sites `firedWarnings` finds. Neither side reads
 * the other back.
 *
 * ── DECLARED LIMIT — variable indirection (a DIFFERENT class, not a widening gap) ──
 * A text scanner sees SHAPES, not VALUES (the ceiling stated in
 * `test/support/arch-scan.ts`). The original defect flowed through a variable —
 * `const fileWarning = formatError(…)` then `warnings.unshift(fileWarning)` —
 * and `warnings.push(...list)` (live today at `src/mutation/engine.ts:730,734`)
 * spreads a list whose elements are invisible here. No pattern below claims to
 * see either: they are MISSED by construction, and the probe cell pins that
 * miss instead of hiding it.
 *
 * Behavioural backstop for this class: `test/core/notice-tier-e2e.test.ts`
 * drives real applied paths (reversed-range heal, literal-mode bypass) and
 * asserts the RENDERED output lacks `[E_`. A variable-carried error header that
 * reaches an applied notice reddens there, whatever the source shape.
 */

const SRC_ROOT = join(process.cwd(), "src");

/** One file's text: the live tree and the planted fixtures share this shape. */
type ScanSource = { file: string; text: string };
/** The sole composer of `[E_*]` headers and sole producer of `[W_*]` headers. */
const COMPOSER_FILE = join(SRC_ROOT, "domain-errors.ts");

/**
 * Per-target, never a count: a count changes with every deletion, so it asserts
 * the tree's SIZE (and rots on edits unrelated to this scan) instead of the
 * walk's REACH. Naming the producer hosts makes the assertion the same fact the
 * scan depends on, and a misrooted walk REDs with the missing file's path — an
 * actionable name — rather than a bare number.
 *
 * `domain-errors.ts` holds both composers and is asserted separately as
 * `COMPOSER_FILE`; these are the three hosts that produce the `W_*` codes the
 * positive control below names. Paths are relative to `SRC_ROOT`.
 */
const REFERENT_FILES = [
  "hashline/anchor-pipeline.ts", // W_REVERSED_ANCHORS, W_LITERAL_BYPASS, W_UNICODE_LITERAL
  "hashline/served-guard.ts", // W_SERVED_PREFIX_MISMATCH, W_NEVER_SERVED_SHAPE
  "mutation/engine.ts", // W_NOOP (batch) + the declared-limit spread
] as const;

/**
 * The forbidden shapes, each named in the failure so a RED is actionable.
 * Comments are stripped before matching (prose may name the shapes; this very
 * docblock does).
 *
 * The channel names — `warning(s)` and `notice(s)` — are those of the applied
 * tier; the composer positions are the property, the channel method
 * (`push`/`unshift`, the historical carrier was `warnings.unshift(…)`), and any
 * binding assignment (`const`/`let`/`var` or bare).
 */
const FORBIDDEN_SHAPES: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: "a `warning:`/`notice:` property composed from `formatError(` — an [E_*] header bound to the applied-notice channel",
    re: /\b(?:warnings?|notices?)\s*:\s*formatError\s*\(/g,
  },
  {
    name: "a `warnings.push(`/`warnings.unshift(` of `formatError(` — an [E_*] header pushed into the applied-notice channel",
    re: /\b(?:warnings?|notices?)\s*\.\s*(?:push|unshift)\s*\(\s*formatError\s*\(/g,
  },
  {
    name: "a warning-/notice-named binding assigned from `formatError(` (declared or bare, annotated or not)",
    re: /\b(?:warnings?|notices?)\b[^=\n]*=(?!=)\s*formatError\s*\(/g,
  },
  {
    name: "a raw `[TO <AUDIENCE>] [E_*]` header literal",
    re: /\[TO (?:MODEL|USER)\] \[E_/g,
  },
];

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * Applied-notice violations in `sources`. Takes text so the live tree and a
 * planted fixture run through the identical guard; `domain-errors.ts` is
 * skipped wholesale because it is where both composers live by construction.
 */
function appliedNoticeViolations(sources: readonly ScanSource[]): string[] {
  const offenders: string[] = [];
  for (const { file, text } of sources) {
    if (file === COMPOSER_FILE) continue;
    const bare = stripComments(text);
    for (const { name, re } of FORBIDDEN_SHAPES) {
      re.lastIndex = 0;
      for (const match of bare.matchAll(re)) {
        offenders.push(`${file}:${lineOf(bare, match.index!)} ${name}`);
      }
    }
  }
  return offenders;
}

function liveSources(): ScanSource[] {
  return listSources(SRC_ROOT).map((file) => ({ file, text: readFileSync(file, "utf-8") }));
}

/** One planted line, scanned alone so a miss cannot hide behind another match. */
function offendersOf(text: string): string[] {
  return appliedNoticeViolations([{ file: "/planted/engine.ts", text: `${text}\n` }]);
}

describe("applied-notice tier: no [E_*] header on an applied notice (#115)", () => {
  it("the live src/ tree never composes an error header into the applied-notice channel", () => {
    const sources = liveSources();
    const files = sources.map((source) => source.file);
    // Non-vacuity: an emptied or misrooted walk would pass every scan below.
    expect(sources.length, "the src/ walk is not empty").toBeGreaterThan(0);
    expect(files, "the walk visits the composer").toContain(COMPOSER_FILE);
    for (const rel of REFERENT_FILES) {
      expect(files, `the walk reaches ${rel}`).toContain(join(SRC_ROOT, rel));
    }

    const offenders = appliedNoticeViolations(sources);
    expect(
      offenders,
      `an applied notice must not render an [E_*] header (formatWarning is the sole W producer; ` +
        `formatError the sole E composer, both in src/domain-errors.ts). Offenders: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });

  it("every declared W_* code has a literal formatWarning producer in src/ (positive control)", () => {
    const sources = liveSources();
    const fired = firedWarnings(sources.map((source) => source.file));
    const declared = Object.keys(WARNING_REGISTRY).sort();

    // A guard that scanned nothing would report an empty set: pin the known
    // producers by name first, then require the scan to be exactly the registry.
    for (const code of [
      "W_REVERSED_ANCHORS",
      "W_NOOP",
      "W_LITERAL_BYPASS",
      "W_UNICODE_LITERAL",
      "W_SERVED_PREFIX_MISMATCH",
      "W_NEVER_SERVED_SHAPE",
    ]) {
      expect(fired.has(code), `${code} is produced by a literal formatWarning call`).toBe(true);
    }
    // Both directions: every declared warning fires, and no undeclared W_* exists.
    expect([...fired].sort()).toEqual(declared);
  });

  // ---- planted violations: the guard must be able to fail ----

  it("negative control: a planted `warning: formatError(` fixture fails the scan", () => {
    const planted: ScanSource[] = [
      {
        file: "/planted/noop-guard.ts",
        text: 'const notice = { warning: formatError("E_BAD_PAYLOAD", { message: "x" }) };\n',
      },
    ];
    const offenders = appliedNoticeViolations(planted);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("`warning:`/`notice:` property");

    // Control on the control: the same shape through the warning composer is clean.
    expect(
      appliedNoticeViolations([
        {
          file: "/planted/noop-guard.ts",
          text: 'const warning: string = formatWarning("W_NOOP", { reason: "x" });\n',
        },
      ]),
    ).toEqual([]);
  });

  it("negative control: a planted `notice:`/`notices:` property fails the scan", () => {
    for (const line of [
      'const row = { notice: formatError("E_BAD_PAYLOAD", { message: "x" }) };',
      'const row = { notices: formatError("E_BAD_PAYLOAD", { message: "x" }) };',
    ]) {
      const offenders = offendersOf(line);
      expect(offenders, line).toHaveLength(1);
      expect(offenders[0]).toContain("`warning:`/`notice:` property");
    }
  });

  it("negative control: a planted `warnings.push(formatError(` fixture fails the scan", () => {
    const offenders = offendersOf('warnings.push(formatError("E_BAD_PAYLOAD", { message: "x" }));');
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("`warnings.push(`/`warnings.unshift(`");
  });

  it("negative control: a planted `warnings.unshift(formatError(` fixture fails the scan", () => {
    // The historical carrier was `warnings.unshift(...)` — `push` alone was blind.
    for (const line of [
      'warnings.unshift(formatError("E_BAD_PAYLOAD", { message: "x" }));',
      'notices.unshift(formatError("E_BAD_PAYLOAD", { message: "x" }));',
    ]) {
      const offenders = offendersOf(line);
      expect(offenders, line).toHaveLength(1);
      expect(offenders[0]).toContain("`warnings.push(`/`warnings.unshift(`");
    }
  });

  it("negative control: a bare warning assignment fails the scan", () => {
    // A bare assignment (no const/let/var) is the same defect with less syntax.
    const offenders = offendersOf('warnings = formatError("E_BAD_PAYLOAD", { message: "x" });');
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("binding assigned from `formatError(`");
  });

  it("negative control: a type-annotated warning local fails the scan", () => {
    // `const warning: string = formatError(…)` slips the property shape because
    // the annotation sits between name and `=`; the binding shape owns it.
    const offenders = offendersOf(
      'const warning: string = formatError("E_BAD_PAYLOAD", { message: "x" });',
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("binding assigned from `formatError(`");
  });

  it("negative control: a planted raw E-header literal fails the scan", () => {
    const offenders = offendersOf('const header = "[TO MODEL] [E_BAD_PAYLOAD] boom";');
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("raw");
  });

  // The reach table, one row per carrier class the review probed. CAUGHT rows are
  // the guard; MISSED rows are the DECLARED LIMIT in the header, pinned so the
  // miss is a recorded fact rather than an assumed closure.
  it("shape reach: the eight probed carriers, caught and declared-missed", () => {
    const probe: Array<{ carrier: string; text: string; caught: boolean }> = [
      // Historical producer (the pre-#117 flow): a variable, invisible by construction.
      {
        carrier: "historical producer",
        text: "warnings.unshift(first.fileWarning);",
        caught: false,
      },
      { carrier: "unshift(var)", text: "warnings.unshift(warning);", caught: false },
      {
        carrier: "unshift(direct)",
        text: 'warnings.unshift(formatError("E_BAD_PAYLOAD", { message: "x" }));',
        caught: true,
      },
      {
        carrier: "notice: property",
        text: 'const row = { notice: formatError("E_BAD_PAYLOAD", { message: "x" }) };',
        caught: true,
      },
      {
        carrier: "notices: property",
        text: 'const row = { notices: formatError("E_BAD_PAYLOAD", { message: "x" }) };',
        caught: true,
      },
      {
        carrier: "notices.push",
        text: 'notices.push(formatError("E_BAD_PAYLOAD", { message: "x" }));',
        caught: true,
      },
      {
        carrier: "bare assignment",
        text: 'warnings = formatError("E_BAD_PAYLOAD", { message: "x" });',
        caught: true,
      },
      // Spread of a list whose elements are values, not shapes: invisible here.
      { carrier: "spread", text: "warnings.push(...list);", caught: false },
    ];

    for (const { carrier, text, caught } of probe) {
      const offenders = offendersOf(text);
      expect(offenders.length > 0, `${carrier}: ${caught ? "CAUGHT" : "MISSED"} — ${text}`).toBe(
        caught,
      );
      if (caught) expect(offenders).toHaveLength(1);
    }
  });
});
