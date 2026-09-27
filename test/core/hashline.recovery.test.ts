import { describe, expect, it } from "vitest";
import { applyEdit, lineHashes, resEdit } from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("applyEdit — recovery scenarios", () => {
  it("autocorrects reversed range (start > end)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[3]!, anchor_to: hashes[1]!, replace_with: "X" }),
    );
    expect(result.content).toBe("a\nX\ne");
    expect(result.warnings?.[0]).toBe(
      `[USER] [W_REVERSED_ANCHORS] anchor_from/anchor_to were reversed (${hashes[3]} after ${hashes[1]}); healed and applied with the range swapped.`,
    );
  });

  it("rejects stale anchor", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(
        content,
        resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[1]!, replace_with: "X\nY" }),
        undefined,
        ["STALE", "STALE", "STALE", "STALE", "STALE"],
      ),
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("shows current context around the resolved anchor when only one anchor of a range is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleStart = "ZZZ";
    let caught: Error | undefined;
    try {
      applyEdit(
        content,
        resEdit({ anchor_from: staleStart, anchor_to: hashes[2]!, replace_with: "X" }),
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    // F6 pin: headline + context block, no `Current range:` heading, no retry hint.
    expect(caught!.message).toBe(
      `[TO MODEL] [E_STALE_ANCHOR] 1 stale anchor: "ZZZ". Re-read for fresh anchors.\n\n` +
        `  Current context around resolved anchor "${hashes[2]}" (line 3):\n` +
        `    2: ${hashes[1]}│b\n` +
        `    3: ${hashes[2]}│c\n` +
        `    4: ${hashes[3]}│d`,
    );
    expect(caught!.message).not.toContain("Current range:");
    expect(caught!.message).not.toContain("Retry with these anchors");
  });

  it("shows context anchored on the start when only the end is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleEnd = "ZZZ";
    let caught: Error | undefined;
    try {
      applyEdit(
        content,
        resEdit({ anchor_from: hashes[0]!, anchor_to: staleEnd, replace_with: "X" }),
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/Current context around resolved anchor/);
    expect(caught!.message).toContain(` 1: ${hashes[0]}│a`);
  });

  it("omits context when both anchors are stale", async () => {
    const content = "a\nb\nc";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit({ anchor_from: "ZZZ", anchor_to: "YYY", replace_with: "X" }));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toMatch(/Current context around resolved anchor/);
  });

  it("rejects ambiguous anchor", async () => {
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

  it("rejects unknown fields in edit items", () => {
    const edit = {
      anchor_from: "ZZZ",
      anchor_to: "ZZZ",
      replace_with: "x",
      extra: true,
    } as any;
    expect(() => resEdit(edit)).toThrow(/unknown or unsupported fields/);
  });

  it("rejects missing replace_with", () => {
    const edit = { anchor_from: "ZZZ", anchor_to: "ZZZ" } as any;
    expect(() => resEdit(edit)).toThrow(/requires a "replace_with" field/);
  });

  it("rejects null replace_with", () => {
    const edit = { anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: null } as any;
    expect(() => resEdit(edit)).toThrow(/must be a string with \\n line separators, not an array/);
  });

  it("rejects array replace_with", () => {
    const edit = {
      anchor_from: "ZZZ",
      anchor_to: "ZZZ",
      replace_with: ["hello", "world"],
    } as any;
    expect(() => resEdit(edit)).toThrow(/must be a string with \\n line separators, not an array/);
  });

  it("accepts string replace_with with line separators", () => {
    const edit = {
      anchor_from: "ZZZ",
      anchor_to: "ZZZ",
      replace_with: "hello\nworld\n",
    } as any;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["hello", "world", ""]);
  });

  it("rejects malformed hash_bounds", () => {
    const edit = { anchor_from: "not-valid", anchor_to: "not-valid", replace_with: "x" };
    expect(() => resEdit(edit)).toThrow(/Invalid anchor/);
  });

  it("rejects bare hash prefix in content_lines with E_MALFORMED_ANCHOR", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(
        content,
        resEdit({
          anchor_from: hashes[1]!,
          anchor_to: hashes[2]!,
          replace_with: `${hashes[1]!}│b\nX`,
        }),
      ),
    ).toThrow(/\[E_MALFORMED_ANCHOR\]/);
    expect(() =>
      applyEdit(
        content,
        resEdit({
          anchor_from: hashes[1]!,
          anchor_to: hashes[2]!,
          replace_with: `${hashes[1]!}│b\nX`,
        }),
      ),
    ).toThrow(/stripped "HASH│" prefix/);
  });

  it("rejects diff preview rows in content_lines with E_MALFORMED_ANCHOR", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(
        content,
        resEdit({
          anchor_from: hashes[1]!,
          anchor_to: hashes[1]!,
          replace_with: `+${hashes[1]!}│B`,
        }),
      ),
    ).toThrow(/\[E_MALFORMED_ANCHOR\]/);
    expect(() =>
      applyEdit(
        content,
        resEdit({
          anchor_from: hashes[1]!,
          anchor_to: hashes[1]!,
          replace_with: `+${hashes[1]!}│B`,
        }),
      ),
    ).toThrow(/stripped diff-preview marker/);
  });

  it("warns on unicode escape sequences in content", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "\\uDDDD" }),
    );
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("\\uDDDD");
  });

  it("handles tab characters in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[2]!, anchor_to: hashes[2]!, replace_with: "\t\treplaced" }),
    );
    expect(result.content).toBe("a\nb\n\t\treplaced");
  });

  it("preserves literal tab in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[2]!, anchor_to: hashes[2]!, replace_with: "\t\treplaced" }),
    );
    expect(result.content).toContain("\t\treplaced");
  });

  it("detects noop when content unchanged", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "b" }),
    );
    expect(result.noopEdit).toBeDefined();
  });

  it("detects noop for range", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[2]!, replace_with: "b\nc" }),
    );
    expect(result.noopEdit).toBeDefined();
  });

  it("handles single-line file", async () => {
    const content = "hello";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "world" }),
    );
    expect(result.content).toBe("world");
  });

  it("handles append to last line", async () => {
    const content = "a\nb";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "b\nc" }),
    );
    expect(result.content).toBe("a\nb\nc");
  });

  it("handles delete of first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "" }),
    );
    expect(result.content).toBe("b\nc");
  });

  it("handles delete of last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[2]!, anchor_to: hashes[2]!, replace_with: "" }),
    );
    expect(result.content).toBe("a\nb");
  });

  it("handles edit of entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(
      content,
      resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[2]!, replace_with: "x\ny" }),
    );
    expect(result.content).toBe("x\ny");
  });
});
