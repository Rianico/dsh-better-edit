import { describe, expect, it } from "vitest";

import { producedCodesInText, stripComments, unionMembers } from "../support/arch-scan.js";

/**
 * Negative controls for the shared scanner (T4 CP1-r5 G5).
 *
 * Each cell plants an evasion on a FIXTURE STRING (not the live tree) and asserts
 * the scanner's answer, so the guard's reach is measured instead of assumed. The
 * DECLARED LIMITS live in the oracle now: C19 plants each undetectable producer
 * into a temp `src/` tree and asserts the **full oracle's** answer, so the blind
 * spot is recorded where it bites (a LOUD false “undeclared producer”) rather
 * than hidden. The durable fix for all three is the observational factory in
 * `test/support/arch-scan.ts`'s CEILING — DEFERRED paragraph; it is deliberately
 * not built here.
 */
describe("arch: registry scanner negative controls", () => {
  it("a producer-shaped line inside a comment is not a producer", () => {
    const lineComment = '// new DomainError("E_COMMENT_FAKE", { cause: "x" });\nconst real = 1;\n';
    expect(producedCodesInText(lineComment)).toEqual([]);
    const blockComment =
      '/* new DomainError("E_BLOCK_FAKE", { cause: "x" }); */\nconst real = 1;\n';
    expect(producedCodesInText(blockComment)).toEqual([]);
    const real = 'const x = () => new DomainError("E_REAL", { cause: "x" });\n';
    expect(producedCodesInText(real)).toEqual(["E_REAL"]);
    // And the comment stripper itself is not simply erasing the line's code:
    expect(stripComments(lineComment)).toContain("const real = 1;");
  });

  it("single-quoted union members and producers are recognised", () => {
    const plantedUnion = "export type DomainErrorCode =\n  | 'E_SQFAKE'\n  | 'E_OK';\n";
    expect(unionMembers(plantedUnion, "DomainErrorCode")).toEqual(["E_SQFAKE", "E_OK"]);
    const plantedProducer = "const x = () => new DomainError('E_SQFAKE', { cause: 'x' });\n";
    expect(producedCodesInText(plantedProducer)).toEqual(["E_SQFAKE"]);
    const mixed = "new DomainError('E_ONE', {});\nnew DomainError(\"E_TWO\", {});\n";
    expect(producedCodesInText(mixed).sort()).toEqual(["E_ONE", "E_TWO"]);
    expect(unionMembers("export type T =\n  | 'E_ONE'\n  | \"E_TWO\";\n", "T")).toEqual([
      "E_ONE",
      "E_TWO",
    ]);
    expect(
      producedCodesInText("throw new ServedRejectionError({ code: 'E_SQREJ', headline: 'h' });\n"),
    ).toEqual(["E_SQREJ"]);
  });

  it("digit-bearing code names are recognised", () => {
    expect(
      unionMembers('export type DomainErrorCode =\n  | "E_RANGE2";\n', "DomainErrorCode"),
    ).toEqual(["E_RANGE2"]);
    expect(producedCodesInText('new DomainError("E_RANGE2", { cause: "x" });\n')).toEqual([
      "E_RANGE2",
    ]);
    expect(
      producedCodesInText('throw new ServedRejectionError({ code: "W_SHAPE2", headline: "h" });\n'),
    ).toEqual(["W_SHAPE2"]);
  });
});
