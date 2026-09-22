import { describe, expect, it } from "vitest";
import { normalizeRequest as normReq } from "../../src/contract.js";

describe("normReq", () => {
  it("returns non-record input as-is", () => {
    expect(normReq("string")).toBe("string");
    expect(normReq(null)).toBe(null);
    expect(normReq(42)).toBe(42);
    expect(normReq(undefined)).toBe(undefined);
  });

  it("returns object input unchanged when no normalization needed", () => {
    const input = {
      path: "src/main.ts",
      anchor_from: "aB3",
      anchor_to: "aB3",
      replace_with: "new",
    };
    const result = normReq(input);
    expect(result).toEqual(input);
  });

  it("normalizes file_path to path", () => {
    const input = {
      file_path: "test.txt",
      anchor_from: "AAA",
      anchor_to: "BBB",
      replace_with: "new",
    };
    const result = normReq(input) as Record<string, unknown>;
    expect(result.path).toBe("test.txt");
    expect(result.file_path).toBeUndefined();
  });

  it("does not overwrite existing path with file_path", () => {
    const input = {
      path: "original.txt",
      file_path: "alias.txt",
      anchor_from: "AAA",
      anchor_to: "BBB",
      replace_with: "new",
    };
    const result = normReq(input) as Record<string, unknown>;
    expect(result.path).toBe("original.txt");
  });

  it("ignores file_path when path is already a string", () => {
    const input = {
      path: "src/main.ts",
      file_path: "other.ts",
    };
    const result = normReq(input) as Record<string, unknown>;
    expect(result.path).toBe("src/main.ts");
    expect(result.file_path).toBe("other.ts");
  });

  it("preserves other fields", () => {
    const input = {
      path: "test.txt",
      anchor_from: "AAA",
      anchor_to: "BBB",
      replace_with: "new",
      custom: "value",
    };
    const result = normReq(input) as Record<string, unknown>;
    expect(result.custom).toBe("value");
  });

  it("does not mutate the original input", () => {
    const input = {
      file_path: "src/main.ts",
      anchor_from: "AAA",
      anchor_to: "BBB",
      replace_with: "x",
    };
    const originalFilePath = input.file_path;
    const originalNewContent = input.replace_with;
    normReq(input);
    expect(input.file_path).toBe(originalFilePath);
    expect(input.replace_with).toBe(originalNewContent);
  });
});

describe("normReq — top-level shape", () => {
  it("keeps anchor_from/anchor_to and replace_with at top level", () => {
    const input = {
      path: "test.txt",
      anchor_from: "AAA",
      anchor_to: "BBB",
      replace_with: "new line",
    };
    const result = normReq(input) as Record<string, unknown>;
    expect(result.anchor_from).toEqual("AAA");
    expect(result.anchor_to).toEqual("BBB");
    expect(result.replace_with).toEqual("new line");
  });

  it("handles flat format with file_path alias", () => {
    const input = {
      file_path: "src/main.ts",
      anchor_from: "AAA",
      anchor_to: "BBB",
      replace_with: "new",
    };
    const result = normReq(input) as Record<string, unknown>;
    expect(result.path).toBe("src/main.ts");
    expect(result.anchor_from).toEqual("AAA");
    expect(result.anchor_to).toEqual("BBB");
  });

  it("does not mutate the original flat-format input", () => {
    const input = {
      path: "test.txt",
      anchor_from: "AAA",
      anchor_to: "BBB",
      replace_with: "new",
    };
    const origFrom = input.anchor_from;
    const origTo = input.anchor_to;
    const origNc = input.replace_with;
    normReq(input);
    expect(input.anchor_from).toBe(origFrom);
    expect(input.anchor_to).toBe(origTo);
    expect(input.replace_with).toBe(origNc);
  });
});
