import { describe, expect, it } from "vitest";
import {
  applyEdit,
  lineHashes,
  resEdit,
} from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("applyEdit — recovery scenarios", () => {
  it("autocorrects reversed range (start > end)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[3]!,
      remove_to: hashes[1]!, replacement_text: "X" },
    ));
    expect(result.content).toBe("a\nX\ne");
    expect(result.warnings?.[0]).toMatch(/reversed remove_from\/remove_to/);
  });

  it("rejects stale anchor", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(content, resEdit(
        { remove_from: hashes[0]!,
        remove_to: hashes[1]!, replacement_text: "X\nY" },
      ), undefined, ["STALE", "STALE", "STALE", "STALE", "STALE"])
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("shows current context around the resolved anchor when only one anchor of a range is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleStart = "ZZZ";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { remove_from: staleStart,
        remove_to: hashes[2]!, replacement_text: "X" },
      ));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/E_STALE_ANCHOR/);
    expect(caught!.message).toMatch(/Current context around resolved anchor/);
    expect(caught!.message).toContain(` 3: ${hashes[2]}│c`);
  });

  it("shows context anchored on the start when only the end is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleEnd = "ZZZ";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { remove_from: hashes[0]!,
        remove_to: staleEnd, replacement_text: "X" },
      ));
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
      applyEdit(content, resEdit(
        { remove_from: "ZZZ",
        remove_to: "YYY", replacement_text: "X" },
      ));
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
      applyEdit(content, resEdit(
        { remove_from: hashes[0]!,
        remove_to: hashes[0]!, replacement_text: "X" },
      ), undefined, forgedHashes)
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("rejects unknown fields in edit items", () => {
    const edit = { remove_from: "ZZZ", remove_to: "ZZZ", replacement_text: "x", extra: true } as any;
    expect(() => resEdit(edit)).toThrow(/unknown or unsupported fields/);
  });

  it("rejects missing replacement_text", () => {
    const edit = { remove_from: "ZZZ",
    remove_to: "ZZZ" } as any;
    expect(() => resEdit(edit)).toThrow(/requires a "replacement_text" field/);
  });

  it("rejects null replacement_text", () => {
    const edit = { remove_from: "ZZZ",
    remove_to: "ZZZ", replacement_text: null } as any;
    expect(() => resEdit(edit)).toThrow(/must be a string with \\n line separators, not an array/);
  });

  it("rejects array replacement_text", () => {
    const edit = { remove_from: "ZZZ",
    remove_to: "ZZZ", replacement_text: ["hello", "world"] } as any;
    expect(() => resEdit(edit)).toThrow(/must be a string with \\n line separators, not an array/);
  });

  it("accepts string replacement_text with line separators", () => {
    const edit = { remove_from: "ZZZ",
    remove_to: "ZZZ", replacement_text: "hello\nworld\n" } as any;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["hello", "world", ""]);
  });

  it("rejects malformed hash_bounds", () => {
    const edit = { remove_from: "not-valid",
    remove_to: "not-valid", replacement_text: "x" };
    expect(() => resEdit(edit)).toThrow(/Invalid anchor/);
  });

	it("rejects bare hash prefix in content_lines with E_BAD_ANCHOR", async () => {
		const content = "a\nb\nc\nd\ne";
		const hashes = await lineHashes(content, home.testPath);
		expect(() => applyEdit(content, resEdit(
			{ remove_from: hashes[1]!,
			remove_to: hashes[2]!, replacement_text: `${hashes[1]!}│b\nX` },
		))).toThrow(/\[E_BAD_ANCHOR\]/);
		expect(() => applyEdit(content, resEdit(
			{ remove_from: hashes[1]!,
			remove_to: hashes[2]!, replacement_text: `${hashes[1]!}│b\nX` },
		))).toThrow(/stripped "HASH│" prefix/);
	});

	it("rejects diff preview rows in content_lines with E_BAD_ANCHOR", async () => {
		const content = "a\nb\nc";
		const hashes = await lineHashes(content, home.testPath);
		expect(() => applyEdit(content, resEdit(
			{ remove_from: hashes[1]!,
			remove_to: hashes[1]!, replacement_text: `+${hashes[1]!}│B` },
		))).toThrow(/\[E_BAD_ANCHOR\]/);
		expect(() => applyEdit(content, resEdit(
			{ remove_from: hashes[1]!,
			remove_to: hashes[1]!, replacement_text: `+${hashes[1]!}│B` },
		))).toThrow(/stripped diff-preview marker/);
	});

  it("warns on unicode escape sequences in content", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[1]!, replacement_text: "\\uDDDD" },
    ));
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("\\uDDDD");
  });

  it("handles tab characters in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!,
      remove_to: hashes[2]!, replacement_text: "\t\treplaced" },
    ));
    expect(result.content).toBe("a\nb\n\t\treplaced");
  });

  it("preserves literal tab in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!,
      remove_to: hashes[2]!, replacement_text: "\t\treplaced" },
    ));
    expect(result.content).toContain("\t\treplaced");
  });

  it("detects noop when content unchanged", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[1]!, replacement_text: "b" },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("detects noop for range", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[2]!, replacement_text: "b\nc" },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("handles single-line file", async () => {
    const content = "hello";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!,
      remove_to: hashes[0]!, replacement_text: "world" },
    ));
    expect(result.content).toBe("world");
  });

  it("handles append to last line", async () => {
    const content = "a\nb";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[1]!, replacement_text: "b\nc" },
    ));
    expect(result.content).toBe("a\nb\nc");
  });

  it("handles delete of first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!,
      remove_to: hashes[0]!, replacement_text: "" },
    ));
    expect(result.content).toBe("b\nc");
  });

  it("handles delete of last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!,
      remove_to: hashes[2]!, replacement_text: "" },
    ));
    expect(result.content).toBe("a\nb");
  });

  it("handles edit of entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!,
      remove_to: hashes[2]!, replacement_text: "x\ny" },
    ));
    expect(result.content).toBe("x\ny");
  });
});
