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
 */

const SRC_ROOT = join(process.cwd(), "src");

/** One file's text: the live tree and the planted fixtures share this shape. */
type ScanSource = { file: string; text: string };
/** The sole composer of `[E_*]` headers and sole producer of `[W_*]` headers. */
const COMPOSER_FILE = join(SRC_ROOT, "domain-errors.ts");

/**
 * Floor, not a pin: a growing `src/` keeps passing, an emptied walk (wrong root,
 * broken recursion) fails. Today: 66 `.ts` files under `src/`.
 */
const MIN_SOURCE_FILES = 66;

/**
 * The forbidden shapes, each named in the failure so a RED is actionable.
 * Comments are stripped before matching (prose may name the shapes; this very
 * docblock does).
 */
const FORBIDDEN_SHAPES: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: "`warning: formatError(` — an [E_*] header bound to the applied-notice channel",
    re: /\bwarnings?\s*:\s*formatError\s*\(/g,
  },
  {
    name: "`warnings.push(formatError(` — an [E_*] header pushed into the applied-notice channel",
    re: /\bwarnings\s*\.\s*push\s*\(\s*formatError\s*\(/g,
  },
  {
    name: "a warning-named local initialised from `formatError(` (annotated or not)",
    re: /\b(?:const|let|var)\s+(?:warnings?|notices?)\b[^=\n]*=\s*formatError\s*\(/g,
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

describe("applied-notice tier: no [E_*] header on an applied notice (#115)", () => {
  it("the live src/ tree never composes an error header into the applied-notice channel", () => {
    const sources = liveSources();
    // Non-vacuity: an emptied or misrooted walk would pass every scan below.
    expect(sources.length, "the src/ walk is not empty").toBeGreaterThanOrEqual(MIN_SOURCE_FILES);
    expect(
      sources.map((source) => source.file),
      "the walk visits the composer",
    ).toContain(COMPOSER_FILE);

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
    expect(offenders[0]).toContain("warning: formatError(");

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

  it("negative control: a planted `warnings.push(formatError(` fixture fails the scan", () => {
    const offenders = appliedNoticeViolations([
      {
        file: "/planted/engine.ts",
        text: 'warnings.push(formatError("E_BAD_PAYLOAD", { message: "x" }));\n',
      },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("warnings.push(formatError(");
  });

  it("negative control: a type-annotated warning local fails the scan", () => {
    // The first fixture run found this gap: `const warning: string = formatError(…)`
    // slips the property shape because the annotation sits between name and `=`.
    const offenders = appliedNoticeViolations([
      {
        file: "/planted/noop-guard.ts",
        text: 'const warning: string = formatError("E_BAD_PAYLOAD", { message: "x" });\n',
      },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("warning-named local");
  });

  it("negative control: a planted raw E-header literal fails the scan", () => {
    const offenders = appliedNoticeViolations([
      {
        file: "/planted/edit-response.ts",
        text: 'const header = "[TO MODEL] [E_BAD_PAYLOAD] boom";\n',
      },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("raw");
  });
});
