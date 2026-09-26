import { describe, expect, it } from "vitest";
import { applyEdit, lineHashes, resEdit } from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("resAnchor (via applyEdit)", () => {
  it("resolves a hash that exists exactly once", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: "X\nY" }),
    );
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("reports not_found for a hash that does not exist", () => {
    const content = "a\nb\nc\nd\ne";
    expect(() =>
      applyEdit(content, resEdit({ anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "X" })),
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("reports ambiguous when hash matches multiple lines (synthetic collision)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const forgedHashes = [hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!];
    expect(() =>
      applyEdit(
        content,
        resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "X" }),
        undefined,
        forgedHashes,
      ),
    ).toThrow(/E_STALE_ANCHOR/);
  });
});

describe("checkBoundaryDup (via applyEdit) — no auto-fix (removed)", () => {
  it("keeps trailing duplication (no auto-fix)", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: "X\nd" }),
    );
    expect(result.content).toBe("a\nX\nd\nd");
  });

  it("keeps leading duplication (no auto-fix)", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: "a\nX" }),
    );
    expect(result.content).toBe("a\na\nX\nd");
  });

  it("does not auto-fix when replacement does not duplicate adjacent lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: "X\nY" }),
    );
  });

  it("does not auto-fix when replacement edge is empty string", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: "" }),
    );
  });

  it("keeps trailing duplication when content_lines has trailing empty lines (no auto-fix)", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: `X\nd\n` }),
    );
    expect(result.content).toBe("a\nX\nd\n\nd");
  });

  it("keeps leading duplication when content_lines has leading empty lines (no auto-fix)", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: `\na\nX` }),
    );
    expect(result.content).toBe("a\n\na\nX\nd");
  });

  it("keeps both trailing and leading duplication in one edit (no auto-fix)", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: "a\nd" }),
    );
    expect(result.content).toBe("a\na\nd\nd");
  });
});

describe("resToSpan (via applyEdit)", () => {
  it("branch: non-empty replacement in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: "X\nY" }),
    );
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("branch: empty replacement (deletion) in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: "" }),
    );
    expect(result.content).toBe("a\nd\ne");
  });

  it("branch: empty replacement covering entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(
        content,
        resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[2]!, replace_with: "" }),
      ),
    ).toThrow(/E_EMPTY_RANGE/);
  });

  it("branch: empty replacement ending at last line (not full file)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[2]!, anchor_to: hashes[4]!, replace_with: "" }),
    );
    expect(result.content).toBe("a\nb");
  });

  it("branch: noop detection returns noop span", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "b" }),
    );
    expect(result.noopEdit).toBeDefined();
  });

  it("branch: replacement at first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "X" }),
    );
    expect(result.content).toBe("X\nb\nc");
  });

  it("branch: replacement at last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[2]!, anchor_to: hashes[2]!, replace_with: "X" }),
    );
    expect(result.content).toBe("a\nb\nX");
  });

  it("branch: deletion of first line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "" }),
    );
    expect(result.content).toBe("b\nc");
  });

  it("branch: deletion of last line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[2]!, anchor_to: hashes[2]!, replace_with: "" }),
    );
    expect(result.content).toBe("a\nb");
  });
});

describe("assemble (via applyEdit)", () => {
  it("applies a single edit in the middle", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "A" }),
    );
    expect(result.content).toBe("A\nb\nc\nd\ne");
  });
});

describe("no auto-fix via applyEdit (removed)", () => {
  it("keeps trailing duplication (no auto-fix)", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({
        anchor_from: hashes[1]!,
        anchor_to: hashes[2]!,
        replace_with: `new one\nnew two\nafter`,
      }),
    );
    expect(result.content).toBe("before\nnew one\nnew two\nafter\nafter");
  });

  it("keeps leading duplication (no auto-fix)", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({
        anchor_from: hashes[1]!,
        anchor_to: hashes[2]!,
        replace_with: `before\nnew one\nnew two`,
      }),
    );
    expect(result.content).toBe("before\nbefore\nnew one\nnew two\nafter");
  });

  it("keeps both leading and trailing duplication (no auto-fix)", async () => {
    const content = "ctx1\nctx2\nold1\nold2\nctx3\nctx4";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({
        anchor_from: hashes[2]!,
        anchor_to: hashes[3]!,
        replace_with: `ctx2\ndup\ndup\nctx3`,
      }),
    );
    expect(result.content).toBe("ctx1\nctx2\nctx2\ndup\ndup\nctx3\nctx3\nctx4");
  });
});

describe("boundary-dup no autocorrection (removed)", () => {
  it("keeps a trailing duplicate (no auto-fix)", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: "X\nd" }),
    );
    expect(result.content).toBe("a\nX\nd\nd");
    expect(result.warnings).toBeUndefined();
  });

  it("keeps duplicate after range (no auto-fix, not noop)", async () => {
    const content = "class A {\n  x = 1;\n\n  constructor() {}\n}\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({
        anchor_from: hashes[0]!,
        anchor_to: hashes[2]!,
        replace_with: "class A {\n  x = 1;\n\n  constructor() {}\n}",
      }),
    );
    // With no dedup, replacement duplicates the following line, so not noop
    expect(result.content).toBe(
      "class A {\n  x = 1;\n\n  constructor() {}\n}\n  constructor() {}\n}\n",
    );
    expect(result.noopEdit).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it("keeps duplicate even when unique line before range (no auto-fix, not noop)", async () => {
    const content = "foo();\nbar();\nbaz();\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({
        anchor_from: hashes[1]!,
        anchor_to: hashes[2]!,
        replace_with: "bar();\nbaz();\nfoo();",
      }),
    );
    expect(result.content).toBe("foo();\nbar();\nbaz();\nfoo();\n");
    expect(result.noopEdit).toBeUndefined();
  });

  it("keeps new-line duplicates even when adjacent line is not unique (no auto-fix)", async () => {
    const content = "if (a) {\n  x();\n}\nif (b) {\n  y();\n}\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({
        anchor_from: hashes[3]!,
        anchor_to: hashes[4]!,
        replace_with: "if (b) {\n  yNew();\n}",
      }),
    );
    expect(result.content).toBe("if (a) {\n  x();\n}\nif (b) {\n  yNew();\n}\n}\n");
    expect(result.warnings).toBeUndefined();
  });
});
