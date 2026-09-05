import { describe, expect, it } from "vitest";
import { editRequestFrom, sanitizePath } from "../../src/contract.js";
import { EDIT_DESCRIPTION } from "../../src/prompts.js";

describe("gemma-4 tool-call bleed hardening (#55)", () => {
	it("keeps EDIT_DESCRIPTION under 800 chars with canonical shape", () => {
		expect(EDIT_DESCRIPTION.length).toBeLessThan(800);
		expect(EDIT_DESCRIPTION).toContain('{ "path": path, "edits":');
		expect(EDIT_DESCRIPTION).toContain("[MODEL]");
		expect(EDIT_DESCRIPTION).toContain("[USER]");
	});

	it("leaves clean paths untouched", () => {
		expect(sanitizePath("a.py")).toBe("a.py");
		expect(sanitizePath("dir/sub/file.ts")).toBe("dir/sub/file.ts");
		expect(sanitizePath(null)).toBeNull();
		expect(sanitizePath(123)).toBeNull();
	});

	it("strips <|> wrappers", () => {
		expect(sanitizePath("<|>a.py<|>")).toBe("a.py");
		expect(sanitizePath("<|>a.py")).toBe("a.py");
		expect(sanitizePath("a.py<|>")).toBe("a.py");
	});

	it("strips separator and pipe wrappers", () => {
		expect(sanitizePath("│a.py│")).toBe("a.py");
		expect(sanitizePath("|a.py|")).toBe("a.py");
	});

	it("strips quote and backtick wrappers, iteratively", () => {
		expect(sanitizePath('"a.py"')).toBe("a.py");
		expect(sanitizePath("'a.py'")).toBe("a.py");
		expect(sanitizePath("`a.py`")).toBe("a.py");
		expect(sanitizePath('"<|>a.py<|>"')).toBe("a.py");
	});

	it("rejects empty remainders", () => {
		expect(sanitizePath("")).toBeNull();
		expect(sanitizePath("   ")).toBeNull();
		expect(sanitizePath('""')).toBeNull();
		expect(sanitizePath("<|>")).toBeNull();
	});

	it("normalizes wrapped paths in editRequestFrom", () => {
		const req = editRequestFrom({ path: "<|>a.py<|>", edits: [["a", "b", "c"]] });
		expect(req?.path).toBe("a.py");
		expect(editRequestFrom({ path: "a.py", edits: [["a", "b", "c"]] })?.path).toBe("a.py");
		expect(editRequestFrom({ path: null, edits: [["a", "b", "c"]] })?.path).toBeNull();
	});

	it("rejects emptied paths in editRequestFrom", () => {
		expect(editRequestFrom({ path: '""', edits: [["a", "b", "c"]] })).toBeUndefined();
		expect(editRequestFrom({ path: "", edits: [["a", "b", "c"]] })).toBeUndefined();
	});
});
