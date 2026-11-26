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
  "hashline/anchor-pipeline.ts",
  "hashline/served-guard.ts",
  "mutation/engine.ts",
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
    expect([...fired].sort()).toEqual(declared);
  });

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
    const offenders = offendersOf('warnings = formatError("E_BAD_PAYLOAD", { message: "x" });');
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("binding assigned from `formatError(`");
  });

  it("negative control: a type-annotated warning local fails the scan", () => {
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

  it("shape reach: the eight probed carriers, caught and declared-missed", () => {
    const probe: Array<{ carrier: string; text: string; caught: boolean }> = [
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
