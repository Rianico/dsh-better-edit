import { describe, it, expect } from "vitest";
import { splitLines, visLines } from "../../src/utils.js";
describe("coverage-utils2", () => {
  it("visLines and splitLines", () => {
    expect(visLines("")).toEqual([]);
    expect(visLines("a\nb\n")).toEqual(["a", "b"]);
    expect(visLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  });
});
