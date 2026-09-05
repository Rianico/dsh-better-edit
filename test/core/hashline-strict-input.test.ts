import { describe, expect, it } from "vitest";
import {
	applyEdit,
	lineHashes,
	resEdit,
	type HTEdit,
} from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("edit input validation", () => {
	it("rejects bare HASH| prefix in content with E_BAD_ANCHOR", async () => {
		const file = "foo\nbar";
		const hashes = await lineHashes(file, home.testPath);
		const toolEdit: HTEdit = { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_text: `${hashes[0]!}│FOO` };
		expect(() => applyEdit(file, resEdit(toolEdit))).toThrow(/\[E_BAD_ANCHOR\]/);
		expect(() => applyEdit(file, resEdit(toolEdit))).toThrow(/replacement_text line 1/);
		expect(() => applyEdit(file, resEdit(toolEdit))).toThrow(/1\/1 matched/);
	});

	it("rejects array replacement_text before patch-prefix validation", () => {
		const toolEdit: HTEdit = {
      remove_from: "ZZZ",
      remove_to: "ZZZ", replacement_text: ["+ZZZ:foo"],
    } as unknown as HTEdit;
    expect(() => resEdit(toolEdit)).toThrow(
      /must be a string with \\n line separators, not an array/i,
    );
	});

	it("passes through numbered deletion rows as literal content", () => {
		const toolEdit: HTEdit = { remove_from: "ZZZ",
		remove_to: "ZZZ", replacement_text: "-1    foo" };
    const resolved = resEdit(toolEdit);
		expect(resolved.content_lines).toEqual(["-1    foo"]);
	});

	it("accepts plain literal content unchanged", () => {
		const toolEdit: HTEdit = { remove_from: "ZZZ",
		remove_to: "ZZZ", replacement_text: "bar" };
    const resolved = resEdit(toolEdit);
		expect(resolved.content_lines).toEqual(["bar"]);
	});

	it("preserves '#' comment lines that do not match the strict prefix", () => {
		const toolEdit: HTEdit = { remove_from: "ZZZ",
		remove_to: "ZZZ", replacement_text: "# keep me" };
    const resolved = resEdit(toolEdit);
    expect(resolved.content_lines).toEqual(["# keep me"]);
	});
});

describe("partial hash prefixes copied into content (issue #24)", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("rejects a bare prefix that matches an existing file line hash", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const betaHash = hashes[1]!;
		const toolEdit: HTEdit = { remove_from: anchor,
			remove_to: anchor, replacement_text: `${betaHash}│### heading\nreal content` };
		expect(() => applyTool(toolEdit, hashes)).toThrow(/\[E_BAD_ANCHOR\]/);
		expect(() => applyTool(toolEdit, hashes)).toThrow(/1\/1 matched/);
		expect(() => applyTool(toolEdit, hashes)).not.toThrow(/literal content/);
	});

	it("rejects a bare prefix whose hash exists in the file hash set", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const gammaHash = hashes[2]!;
		const toolEdit: HTEdit = { remove_from: anchor,
			remove_to: anchor, replacement_text: `${gammaHash}│text` };
		expect(() => applyTool(toolEdit, hashes)).toThrow(/\[E_BAD_ANCHOR\]/);
		expect(() => applyTool(toolEdit, hashes)).toThrow(/1\/1 matched/);
	});

	it("rejects bare prefixes even when the hash is not in the file hash set", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const toolEdit: HTEdit = { remove_from: anchor,
			remove_to: anchor, replacement_text: "ZZZ│one\nZZP│two" };
		expect(() => applyTool(toolEdit, hashes)).toThrow(/\[E_BAD_ANCHOR\]/);
		expect(() => applyTool(toolEdit, hashes)).toThrow(/0 matched/);
		expect(() => applyTool(toolEdit, hashes)).toThrow(/literal 'HASH│' content/);
	});

	it("reports the replacement_text line for each rejected line", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const toolEdit: HTEdit = { remove_from: anchor,
			remove_to: anchor, replacement_text: "ZZZ│one\nreal\nZZP│two" };
		expect(() => applyTool(toolEdit, hashes)).toThrow(/\[E_BAD_ANCHOR\]/);
		expect(() => applyTool(toolEdit, hashes)).toThrow(/replacement_text line 1, replacement_text line 3/);
	});

	it("rejects indented prefix with E_BAD_ANCHOR", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const toolEdit: HTEdit = { remove_from: anchor,
			remove_to: anchor, replacement_text: `  ${hashes[1]!}│  indented` };
		expect(() => applyTool(toolEdit, hashes)).toThrow(/\[E_BAD_ANCHOR\]/);
	});

	it("accepts a single legit 'TS: TypeScript' line without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_text: "TS: TypeScript" },
    hashes);
    expect(result.warnings ?? []).toEqual([]);
		expect(result.content).toContain("TS: TypeScript");
	});

	it("does not false-positive on shorter valid-content prefixes like '#' or '+'", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_text: "# heading" },
    hashes);
    expect(result.warnings ?? []).toEqual([]);
	});

	it("rejects prefixes on long lines with E_BAD_ANCHOR", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const betaHash = hashes[1]!;
		const longLine = `${betaHash}│${"y".repeat(500)}`;
		const toolEdit: HTEdit = { remove_from: anchor,
			remove_to: anchor, replacement_text: longLine };
		expect(() => applyTool(toolEdit, hashes)).toThrow(/\[E_BAD_ANCHOR\]/);
	});
});

describe("diff preview rows copied into content", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("rejects +HASH│ addition rows with E_BAD_ANCHOR", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const toolEdit: HTEdit = { remove_from: anchor,
			remove_to: anchor, replacement_text: `+${hashes[1]!}│### heading\nreal content` };
		expect(() => applyTool(toolEdit, hashes)).toThrow(/\[E_BAD_ANCHOR\]/);
		expect(() => applyTool(toolEdit, hashes)).toThrow(/stripped diff-preview marker/);
		expect(() => applyTool(toolEdit, hashes)).toThrow(/replacement_text line 1/);
	});

	it("rejects -HASH│ and -   │ deletion rows with E_BAD_ANCHOR", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const toolEdit: HTEdit = { remove_from: anchor,
			remove_to: anchor, replacement_text: `-${hashes[1]!}│one\n-   │two` };
		expect(() => applyTool(toolEdit, hashes)).toThrow(/\[E_BAD_ANCHOR\]/);
		expect(() => applyTool(toolEdit, hashes)).toThrow(/replacement_text line 1, replacement_text line 2/);
	});

	it("leaves numbered deletion rows as literal content without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_text: "-1    foo" },
    hashes);
		expect(result.content).toBe("-1    foo\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves plain +x / -x unified-diff lines as literal content without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_text: "+added\n-removed" },
    hashes);
		expect(result.content).toBe("+added\n-removed\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});
});

describe("diff-prefix false-positive guards (tightened shapes)", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("leaves literal '+ HASH│' content with a space after the plus untouched", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_text: `+ ${hashes[1]!}│one` },
    hashes);
		expect(result.content).toBe(`+ ${hashes[1]!}│one\nbeta\ngamma\ndelta`);
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves literal '- HASH│' content with a space after the minus untouched", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_text: `- ${hashes[1]!}│one` },
    hashes);
		expect(result.content).toBe(`- ${hashes[1]!}│one\nbeta\ngamma\ndelta`);
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves literal '+ abc│' / '- xyz│' lines untouched", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: anchor,
      remove_to: anchor, replacement_text: "+ abc│def\n- xyz│uvw" },
    hashes);
		expect(result.content).toBe("+ abc│def\n- xyz│uvw\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});

	it("rejects exact +HASH│ rows without a space", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const toolEdit: HTEdit = { remove_from: anchor,
			remove_to: anchor, replacement_text: `+${hashes[1]!}│one` };
		expect(() => applyTool(toolEdit, hashes)).toThrow(/\[E_BAD_ANCHOR\]/);
		expect(() => applyTool(toolEdit, hashes)).toThrow(/stripped diff-preview marker/);
	});

	it("rejects exact -HASH│ and -   │ rows", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const toolEdit: HTEdit = { remove_from: anchor,
			remove_to: anchor, replacement_text: `-${hashes[1]!}│one\n-   │two` };
		expect(() => applyTool(toolEdit, hashes)).toThrow(/\[E_BAD_ANCHOR\]/);
		expect(() => applyTool(toolEdit, hashes)).toThrow(/stripped diff-preview marker/);
	});
});
