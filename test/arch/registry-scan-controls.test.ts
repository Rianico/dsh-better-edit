import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  listSources,
  producedCodesInText,
  stripComments,
  unionMembers,
} from "../support/arch-scan.js";

/**
 * Negative controls for the shared scanner (T4 CP1-r5 G5).
 *
 * Each cell plants an evasion on a FIXTURE STRING (not the live tree) and asserts
 * the scanner's answer, so the guard's reach is measured instead of assumed. The
 * last two cells are **DECLARED LIMITS**: they assert what the scanner *cannot*
 * see, so the blind spot is recorded rather than hidden. The durable fix for both
 * is the observational factory described in `test/support/arch-scan.ts`'s
 * CEILING — DEFERRED paragraph; it is deliberately not built here.
 *
 * Mutants M11–M13 revert the fixes these cells pin.
 */
describe("arch: registry scanner negative controls", () => {
  // C12 (G1) — M11 reverts stripComments in producedCodesInText.
  it("a producer-shaped line inside a comment is not a producer", () => {
    const lineComment = '// new DomainError("E_COMMENT_FAKE", { cause: "x" });\nconst real = 1;\n';
    expect(producedCodesInText(lineComment)).toEqual([]);
    const blockComment =
      '/* new DomainError("E_BLOCK_FAKE", { cause: "x" }); */\nconst real = 1;\n';
    expect(producedCodesInText(blockComment)).toEqual([]);
    // Control: the same text OUTSIDE the comment IS a producer.
    const real = 'const x = () => new DomainError("E_REAL", { cause: "x" });\n';
    expect(producedCodesInText(real)).toEqual(["E_REAL"]);
    // And the comment stripper itself is not simply erasing the line's code:
    expect(stripComments(lineComment)).toContain("const real = 1;");
  });

  // C13 (G2) — M12 reverts the quote-style tolerance.
  it("single-quoted union members and producers are recognised", () => {
    const plantedUnion = "export type DomainErrorCode =\n  | 'E_SQFAKE'\n  | 'E_OK';\n";
    expect(unionMembers(plantedUnion, "DomainErrorCode")).toEqual(["E_SQFAKE", "E_OK"]);
    const plantedProducer = "const x = () => new DomainError('E_SQFAKE', { cause: 'x' });\n";
    expect(producedCodesInText(plantedProducer)).toEqual(["E_SQFAKE"]);
    // Both styles in one fixture — the scanner must not stop at the first.
    const mixed = "new DomainError('E_ONE', {});\nnew DomainError(\"E_TWO\", {});\n";
    expect(producedCodesInText(mixed).sort()).toEqual(["E_ONE", "E_TWO"]);
    expect(unionMembers("export type T =\n  | 'E_ONE'\n  | \"E_TWO\";\n", "T")).toEqual([
      "E_ONE",
      "E_TWO",
    ]);
    // The nested-object producer position accepts single quotes too (M12's target).
    expect(
      producedCodesInText("throw new ServedRejectionError({ code: 'E_SQREJ', headline: 'h' });\n"),
    ).toEqual(["E_SQREJ"]);
  });

  // C14 (G3) — M13 reverts the digit-legal character class.
  it("digit-bearing code names are recognised", () => {
    expect(
      unionMembers('export type DomainErrorCode =\n  | "E_RANGE2";\n', "DomainErrorCode"),
    ).toEqual(["E_RANGE2"]);
    expect(producedCodesInText('new DomainError("E_RANGE2", { cause: "x" });\n')).toEqual([
      "E_RANGE2",
    ]);
    // The whole shape, including a warning-side digit name and the
    // ServedRejectionError({ code: … }) position.
    expect(
      producedCodesInText('throw new ServedRejectionError({ code: "W_SHAPE2", headline: "h" });\n'),
    ).toEqual(["W_SHAPE2"]);
  });

  // C15a — DECLARED LIMIT. Not a defect to fix by scanning harder: the value is
  // not in the text. The observational factory is the durable form (see the
  // scanner's CEILING paragraph).
  it("DECLARED LIMIT: a variable-held producer is not detectable (by construction)", () => {
    const planted =
      'const code = "E_HELD";\nconst x = () => new DomainError(code, { cause: "x" });\n';
    expect(producedCodesInText(planted)).toEqual([]);
    expect(planted).toContain("E_HELD"); // the name IS in the text: a text scan cannot join the two
  });

  // C15b — DECLARED LIMIT. `listSources` keeps `*.ts` by design, so a producer in
  // a `.mjs` (or any non-.ts) file is out of the scan's reach.
  it("DECLARED LIMIT: a .mjs producer is outside the scan (it covers *.ts by design)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-scan-limit-"));
    try {
      writeFileSync(join(dir, "producer.ts"), 'new DomainError("E_TS_FILE", { cause: "x" });\n');
      writeFileSync(join(dir, "producer.mjs"), 'new DomainError("E_MJS_FILE", { cause: "x" });\n');
      const sources = listSources(dir);
      expect(sources.map((f) => f.slice(dir.length + 1))).toEqual(["producer.ts"]);
      expect(producedCodesInText('new DomainError("E_MJS_FILE", { cause: "x" });\n')).toEqual([
        "E_MJS_FILE",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
