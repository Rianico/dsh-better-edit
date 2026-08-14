import { beforeAll, describe, expect, it } from "vitest";
import { detectEnding, toLF, restoreEndings, stripBOM, genDiff } from "../../src/edit-diff.js";
import { _lineHashesPure, initHasher } from "../../src/hashline/index.js";

beforeAll(async () => {
  await initHasher();
});

describe("detectEnding", () => {
  it("detects CRLF when \\r\\n appears first", () => {
    expect(detectEnding("hello\r\nworld")).toBe("\r\n");
  });

  it("defaults to LF when only \\n is present", () => {
    expect(detectEnding("hello\nworld")).toBe("\n");
  });

  it("detects CRLF when both exist but CRLF comes first", () => {
    expect(detectEnding("line1\r\nline2\nline3")).toBe("\r\n");
  });

  it("defaults to LF when no line endings exist", () => {
    expect(detectEnding("hello world")).toBe("\n");
  });

  it("defaults to LF for empty string", () => {
    expect(detectEnding("")).toBe("\n");
  });

  it("detects lone CR when no LF is present", () => {
    expect(detectEnding("hello\rworld")).toBe("\r");
  });

  it("detects lone CR for a single trailing CR", () => {
    expect(detectEnding("a\r")).toBe("\r");
  });

  it("prefers CRLF over lone CR when both appear", () => {
    expect(detectEnding("a\r\nb\rc")).toBe("\r\n");
  });

  it("defaults to LF when LF appears before any CR", () => {
    expect(detectEnding("a\nb\rc")).toBe("\n");
  });
});

describe("toLF", () => {
  it("converts \\r\\n to \\n", () => {
    expect(toLF("hello\r\nworld")).toBe("hello\nworld");
  });

  it("converts bare \\r to \\n", () => {
    expect(toLF("hello\rworld")).toBe("hello\nworld");
  });

  it("leaves already-LF text unchanged", () => {
    expect(toLF("hello\nworld")).toBe("hello\nworld");
  });

  it("handles mixed line endings", () => {
    expect(toLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("returns empty string for empty input", () => {
    expect(toLF("")).toBe("");
  });
});

describe("stripBOM", () => {
  it("strips \\uFEFF prefix", () => {
    const result = stripBOM("\uFEFFhello");
    expect(result).toEqual({ bom: "\uFEFF", text: "hello" });
  });

  it("returns empty bom when no BOM present", () => {
    const result = stripBOM("hello");
    expect(result).toEqual({ bom: "", text: "hello" });
  });

  it("handles empty string with BOM only", () => {
    const result = stripBOM("\uFEFF");
    expect(result).toEqual({ bom: "\uFEFF", text: "" });
  });

  it("handles plain empty string", () => {
    const result = stripBOM("");
    expect(result).toEqual({ bom: "", text: "" });
  });
});

describe("restoreEndings", () => {
  it("converts LF back to CRLF when original used CRLF", () => {
    expect(restoreEndings("hello\nworld", "\r\n")).toBe("hello\r\nworld");
  });

  it("leaves LF unchanged when original used LF", () => {
    expect(restoreEndings("hello\nworld", "\n")).toBe("hello\nworld");
  });

  it("handles empty string with CRLF target", () => {
    expect(restoreEndings("", "\r\n")).toBe("");
  });

  it("handles empty string with LF target", () => {
    expect(restoreEndings("", "\n")).toBe("");
  });

  it("handles multiple lines with CRLF target", () => {
    expect(restoreEndings("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
  });

  it("preserves content without newlines", () => {
    expect(restoreEndings("hello", "\r\n")).toBe("hello");
    expect(restoreEndings("hello", "\n")).toBe("hello");
    expect(restoreEndings("hello", "\r")).toBe("hello");
  });

  it("converts LF back to CR when original used lone CR", () => {
    expect(restoreEndings("hello\nworld", "\r")).toBe("hello\rworld");
  });

  it("round-trips lone CR through toLF", () => {
    expect(restoreEndings(toLF("a\rb\r"), "\r")).toBe("a\rb\r");
  });
});

describe("genDiff", () => {
  it("renders a literal __ELLIPSIS__ line as content, not as a truncation marker", () => {
    const oldContent = "a\n__ELLIPSIS__\nc\nd\n";
    const newContent = "a\n__ELLIPSIS__\nc\nD\n";
    const { diff } = genDiff(oldContent, newContent, 3);
    const lines = diff.split("\n");
    expect(lines.some((line) => line.endsWith("│__ELLIPSIS__"))).toBe(true);
    expect(lines.filter((line) => line.trim() === "...")).toHaveLength(0);
  });

  it("keeps hashes aligned when a literal __ELLIPSIS__ line sits in diff context", () => {
    const oldContent = "a\n__ELLIPSIS__\nc\nd\n";
    const newContent = "a\n__ELLIPSIS__\nc\nD\n";
    const hashes = _lineHashesPure(newContent);
    const { diff } = genDiff(oldContent, newContent, 2, hashes);
    const cLine = diff.split("\n").find((line) => line.endsWith("│c"))!;
    expect(cLine.startsWith(` ${hashes[2]}`)).toBe(true);
  });
});
