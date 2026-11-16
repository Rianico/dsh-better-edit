import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #108 banned-hint scan — the tool must never hand the model an unverified coordinate.
 *
 * A literal-only grep cannot see this defect class: both shipped hints were TEMPLATE
 * interpolations, so no fixed full sentence survived to grep for. Each pattern below is the
 * template's fixed prefix, which is what makes the scan refutable against the templates:
 *
 *   T1 (`firstHashFromBlock`):  `extracted first hash "<hash>" from <n>-line block — use bare "<hash>" next time`
 *   T2 (`diagRef` pipe+newline): `… — use only the first hash "<first>" as anchor_from and "<last>" as anchor_to …`
 *
 * The prefixes are also the phrases the repair removed, so this file is the durable
 * `rg -n 'extracted first hash|use bare "|use only the first hash' src/` empty contract.
 *
 * Scope is `src/` only: the fixtures and the neighbouring tests quote these phrases on
 * purpose, and a scan that included `test/` would ban its own evidence.
 */

const SRC_ROOT = join(import.meta.dirname, "..", "..", "src");

type BannedHint = {
  /** What the hint taught the model to do. */
  name: string;
  pattern: RegExp;
  /** Pre-fix sample, verbatim from `009b922`, proving the pattern reaches the template. */
  preFixSample: string;
};

const BANNED_HINTS: BannedHint[] = [
  {
    name: "extracted-first-hash starter",
    pattern: /extracted first hash/,
    preFixSample: 'extracted first hash "set" from 4-line block — use bare "set" next time',
  },
  {
    name: '"use bare" retry hint',
    pattern: /use bare "/,
    preFixSample: 'extracted first hash "set" from 4-line block — use bare "set" next time',
  },
  {
    name: "use-only-the-first-hash instruction",
    pattern: /use only the first hash/,
    preFixSample:
      'Received 2 lines starting "abc│line one…" — use only the first hash "abc" as anchor_from and "def" as anchor_to',
  },
];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/** 1-based line numbers of `text` matching any banned hint (the scanner's core). */
function offenderLines(text: string, hints: BannedHint[] = BANNED_HINTS): number[] {
  const hits: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (hints.some((hint) => hint.pattern.test(line))) hits.push(index + 1);
  });
  return hits;
}

async function offenders(): Promise<string[]> {
  const found: string[] = [];
  for (const file of await sourceFiles(SRC_ROOT)) {
    for (const lineNumber of offenderLines(await readFile(file, "utf8"))) {
      found.push(`${file.slice(SRC_ROOT.length + 1)}:${lineNumber}`);
    }
  }
  return found;
}

describe("unverified-anchor hints are banned from src/ (#108)", () => {
  it("every pattern reaches its pre-fix template (the scan is not decorative)", () => {
    for (const hint of BANNED_HINTS) {
      expect(hint.pattern.test(hint.preFixSample), hint.name).toBe(true);
    }
    // One planted line per hint: T1's sample twice (two patterns reach it) then T2's.
    expect(offenderLines(BANNED_HINTS.map((hint) => hint.preFixSample).join("\n"))).toEqual([1, 2, 3]);
  });

  it("the scanner reports the line of a planted hint", () => {
    const planted = 'const reason = `use bare "${hash}" next time`;\nconst clean = "ok";\n';
    expect(offenderLines(planted)).toEqual([1]);
    expect(offenderLines('const clean = "ok";\n')).toEqual([]);
  });

  it("keeps these hint shapes out of src/", async () => {
    // A vacuous pass (an empty or broken walk) must not read as green; src/ holds ~66 modules.
    expect((await sourceFiles(SRC_ROOT)).length).toBeGreaterThan(50);
    expect(await offenders()).toEqual([]);
  });
});
