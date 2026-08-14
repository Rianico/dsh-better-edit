import { describe, expect, it } from "vitest";
import { parseText, parseHashRef } from "../../src/hashline/index.js";

describe("parseHashRef", () => {
	it("parses a hash anchor without # prefix", () => {
		const ref = parseHashRef("aB3");
		expect(ref).toEqual({ hash: "aB3" });
	});

	it("rejects trailing content after the anchor", () => {
		expect(() => parseHashRef("aB3:const x = 1;")).toThrow(
			/Expected a 3-char alphanumeric anchor/,
		);
	});

	it("rejects a full HASH│content line copied into remove_from/remove_to", () => {
		expect(() => parseHashRef("aB3│const x = 1;")).toThrow(
			/remove_from and remove_to must contain the 3-char hash only/,
		);
	});
	it("rejects leading >>> markers (strict mode: no marker stripping)", () => {
		expect(() => parseHashRef(">>> aB3")).toThrow(/E_BAD_REF/);
	});

	it("rejects + and - diff markers (strict mode: anchor only)", () => {
		expect(() => parseHashRef("+aB3")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-aB3")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-#aB3")).toThrow(/E_BAD_REF/);
	});

	it("rejects - and _ anywhere in the anchor (not in the alphabet)", () => {
		expect(() => parseHashRef("-qk")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-_-")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("---")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("aB_")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("aB-")).toThrow(/E_BAD_REF/);
	});

	it("rejects + as a hash body character (not in alphabet)", () => {
		expect(() => parseHashRef("+qk")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("#+qk")).toThrow(/E_BAD_REF/);
	});

	it("rejects malformed anchors with E_BAD_REF", () => {
		expect(() => parseHashRef("invalid")).toThrow(/^\[E_BAD_REF\]/);
	});

	it("rejects legacy LINE#HASH format", () => {
		expect(() => parseHashRef("5aB3")).toThrow(
			/Use the hash alone/,
		);
	});

	it("rejects wrong-length anchors", () => {
		expect(() => parseHashRef("aB")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("aB3x")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("#aB3x")).toThrow(/E_BAD_REF/);
	});

	it("rejects anchors with invalid alphabet", () => {
		expect(() => parseHashRef("!@#")).toThrow(/^\[E_BAD_REF\]/);
	});
});

describe("parseText", () => {
	it("rejects null with a clear error", () => {
		expect(() => parseText(null as unknown as string)).toThrow(/^\[E_BAD_SHAPE\].*must be a string with \\n line separators/);
	});

	it("rejects array input with clear error (must use string)", () => {
		expect(() => parseText(["a", "b"] as unknown as string)).toThrow(
			/must be a string with \\n line separators, not an array/,
		);
	});

	it("splits a string on \\n separators", () => {
		expect(parseText("a\nb")).toEqual(["a", "b"]);
	});

	it("returns [] for empty string (delete range)", () => {
		expect(parseText("")).toEqual([]);
	});

	it("treats a trailing newline as an extra empty line (no special case)", () => {
		expect(parseText("a\nb\n")).toEqual(["a", "b", ""]);
	});

	it("represents a single newline as one blank line", () => {
		expect(parseText("\n")).toEqual([""]);
	});

	it("represents two newlines as two blank lines", () => {
		expect(parseText("\n\n")).toEqual(["", ""]);
	});

	it("normalizes CRLF and CR line endings to LF", () => {
		expect(parseText("a\r\nb\rc")).toEqual(["a", "b", "c"]);
	});

	it("preserves '# keep me' comment lines (no autocorrection)", () => {
		expect(parseText("# keep me")).toEqual(["# keep me"]);
	});

	it("preserves literal '+' prefixed content (no autocorrection)", () => {
		expect(parseText("+added")).toEqual(["+added"]);
	});

	it("passes through diff-preview rows verbatim (marker stripping happens in applyEdit)", () => {
		expect(parseText("+aB3│foo\n+xYp│bar")).toEqual(["+aB3│foo", "+xYp│bar"]);
		expect(parseText(" aB3│keep\n-10    old\n xYp│after")).toEqual([" aB3│keep", "-10    old", " xYp│after"]);
		expect(parseText(" aB3│keep\n-   │old\n xYp│after")).toEqual([" aB3│keep", "-   │old", " xYp│after"]);
		expect(parseText("-aB3│old\n- aB3│old")).toEqual(["-aB3│old", "- aB3│old"]);
	});

	it("passes through numbered deletion rows as literal content", () => {
		expect(parseText("-10    old")).toEqual(["-10    old"]);
	});

	it("accepts literal minus-prefixed content that is not a diff row", () => {
		expect(parseText("-   something\n-abc\n- old style")).toEqual(["-   something", "-abc", "- old style"]);
	});
});
