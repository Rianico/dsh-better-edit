import { describe, expect, it } from "vitest";
import {
  applyEdit,
  lineHashes,
  resEdit,
} from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("resAnchor (via applyEdit)", () => {
  it("resolves a hash that exists exactly once", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: "X\nY" },
    ));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("reports not_found for a hash that does not exist", () => {
    const content = "a\nb\nc\nd\ne";
    expect(() =>
      applyEdit(content, 
resEdit(
        { remove_from: "ZZZ", remove_to: "ZZZ", replacement_text: "X" },
      ))
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("reports ambiguous when hash matches multiple lines (synthetic collision)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const forgedHashes = [hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!];
    expect(() =>
      applyEdit(content, 
resEdit(
        { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_text: "X" },
      ), undefined, forgedHashes)
    ).toThrow(/E_AMBIGUOUS_ANCHOR/);
  });
});

describe("checkBoundaryDup (via applyEdit) — auto-fix", () => {
  it("auto-fixes trailing duplication", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: "X\nd" },
    ));
    expect(result.content).toBe("a\nX\nd");
    expect(result.autoFixes).toBeDefined();
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
  });

  it("auto-fixes leading duplication", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: "a\nX" },
    ));
    expect(result.content).toBe("a\nX\nd");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
  });

  it("does not auto-fix when replacement does not duplicate adjacent lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: "X\nY" },
    ));
    expect(result.autoFixes ?? []).toHaveLength(0);
  });

  it("does not auto-fix when replacement edge is empty string", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: "" },
    ));
    expect(result.autoFixes ?? []).toHaveLength(0);
  });

  it("auto-fixes trailing duplication when content_lines has trailing empty lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: `X\nd\n` },
    ));
    expect(result.content).toBe("a\nX\n\nd");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
    expect(result.autoFixes![0]!.removedLine).toBe("d");
  });

  it("auto-fixes leading duplication when content_lines has leading empty lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: `\na\nX` },
    ));
    expect(result.content).toBe("a\n\nX\nd");
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
    expect(result.autoFixes![0]!.removedLine).toBe("a");
  });

  it("auto-fixes both trailing and leading in one edit", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: "a\nd" },
    ));
    expect(result.content).toBe("a\nd");
    expect(result.autoFixes).toHaveLength(2);
  });
});

describe("resToSpan (via applyEdit)", () => {
  it("branch: non-empty replacement in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: "X\nY" },
    ));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("branch: empty replacement (deletion) in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: "" },
    ));
    expect(result.content).toBe("a\nd\ne");
  });

  it("branch: empty replacement covering entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(content, 
resEdit(
        { remove_from: hashes[0]!, remove_to: hashes[2]!, replacement_text: "" },
      ))
    ).toThrow(/E_WOULD_EMPTY/);
  });

  it("branch: empty replacement ending at last line (not full file)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[2]!, remove_to: hashes[4]!, replacement_text: "" },
    ));
    expect(result.content).toBe("a\nb");
  });

  it("branch: noop detection returns noop span", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "b" },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("branch: replacement at first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_text: "X" },
    ));
    expect(result.content).toBe("X\nb\nc");
  });

  it("branch: replacement at last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[2]!, remove_to: hashes[2]!, replacement_text: "X" },
    ));
    expect(result.content).toBe("a\nb\nX");
  });

  it("branch: deletion of first line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_text: "" },
    ));
    expect(result.content).toBe("b\nc");
  });

  it("branch: deletion of last line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[2]!, remove_to: hashes[2]!, replacement_text: "" },
    ));
    expect(result.content).toBe("a\nb");
  });
});

describe("assemble (via applyEdit)", () => {
  it("applies a single edit in the middle", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_text: "A" },
    ));
    expect(result.content).toBe("A\nb\nc\nd\ne");
  });
});

describe("auto-fix via applyEdit", () => {
  it("auto-fixes trailing duplication", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: `new one\nnew two\nafter` },
    ));
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
    expect(result.autoFixes![0]!.removedLine).toBe("after");
    expect(result.content).toBe("before\nnew one\nnew two\nafter");
  });

  it("auto-fixes leading duplication", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: `before\nnew one\nnew two` },
    ));
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("leading");
    expect(result.autoFixes![0]!.removedLine).toBe("before");
    expect(result.content).toBe("before\nnew one\nnew two\nafter");
  });

  it("auto-fixes both leading and trailing in one edit", async () => {
    const content = "ctx1\nctx2\nold1\nold2\nctx3\nctx4";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[2]!, remove_to: hashes[3]!, replacement_text: `ctx2\ndup\ndup\nctx3` },
    ));
    expect(result.autoFixes).toBeDefined();
    expect(result.autoFixes).toHaveLength(2);
    expect(result.content).toBe("ctx1\nctx2\ndup\ndup\nctx3\nctx4");
  });
});

describe("boundary-dup autocorrection (via applyEdit)", () => {
  it("strips a trailing duplicate without a warning", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: "X\nd" },
    ));
    expect(result.content).toBe("a\nX\nd");
    expect(result.warnings).toBeUndefined();
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
    expect(result.autoFixes![0]!.removedLineIndex).toBe(1);
  });

  it("strips a new line duplicating a unique line after the range (noop)", async () => {
    const content = "class A {\n  x = 1;\n\n  constructor() {}\n}\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[0]!, remove_to: hashes[2]!, replacement_text: "class A {\n  x = 1;\n\n  constructor() {}\n}" },
    ));
    expect(result.content).toBe(content);
    expect(result.noopEdit).toBeDefined();
    expect(result.warnings).toBeUndefined();
    expect(result.autoFixes).toBeUndefined();
  });

  it("strips a new line duplicating a unique line before the range (noop)", async () => {
    const content = "foo();\nbar();\nbaz();\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[2]!, replacement_text: "bar();\nbaz();\nfoo();" },
    ));
    expect(result.content).toBe(content);
    expect(result.noopEdit).toBeDefined();
    expect(result.autoFixes).toBeUndefined();
  });

  it("does not strip new-line duplicates when the adjacent line is not unique in the file", async () => {
    const content = "if (a) {\n  x();\n}\nif (b) {\n  y();\n}\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: hashes[3]!, remove_to: hashes[4]!, replacement_text: "if (b) {\n  yNew();\n}" },
    ));
    expect(result.content).toBe("if (a) {\n  x();\n}\nif (b) {\n  yNew();\n}\n");
    expect(result.warnings).toBeUndefined();
    expect(result.autoFixes).toHaveLength(1);
    expect(result.autoFixes![0]!.kind).toBe("trailing");
  });
});
