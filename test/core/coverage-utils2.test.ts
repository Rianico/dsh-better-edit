import { describe, it, expect } from "vitest";
import { cntDiff } from "../../src/utils.js";
describe("coverage-utils2", () => {
  it("cntDiff", () => {
    expect(cntDiff("", "+")).toBe(0);
    expect(cntDiff("hello", "+")).toBe(0);
    expect(cntDiff("+a\n", "+")).toBe(1);
  });
});
