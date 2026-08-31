import { describe, expect, it } from "vitest";
import { initHasher, lineHashesPure } from "../../src/hashline/hash-assign.js";
import { applyEdit, resEdit } from "../../src/hashline/anchor-pipeline.js";
import { splitLines } from "../../src/utils.js";

await initHasher();

// Regression for #38: boundaryDups must NOT splice. Tool is pure range+replacement.
// Before fix, trailingDups removed last line when it equaled fileLines[endLine].
// Correct: loud duplicate is kept, model fixes next turn.

describe("regression #38 — boundaryDups removed (no auto-fix)", () => {
	it("minimal a/b — a\\nb over a → 3 lines (not 2)", () => {
		const content = "a\nb\n";
		const hashes = lineHashesPure(content);
		const edit = resEdit({ remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_text: "a\nb" }, []);
		const res = applyEdit(content, edit, undefined, hashes, "test.txt", [...hashes]);
		expect(splitLines(res.content)).toEqual(["a", "b", "b"]);
		expect(res.content).toBe("a\nb\nb\n");
		expect(res.autoFixes ?? []).toHaveLength(0);
	});

	it("minimal with trailing newline in replacement — still kept", () => {
		const content = "a\nb\n";
		const hashes = lineHashesPure(content);
		const edit = resEdit({ remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_text: "a\nb\n" }, []);
		const res = applyEdit(content, edit, undefined, hashes, "test.txt", [...hashes]);
		// replacement ["a","b",""] → last non-empty "b" equals file "b", before fix would splice to ["a",""]
		expect(res.autoFixes ?? []).toHaveLength(0);
		expect(splitLines(res.content)).toEqual(["a", "b", "", "b"]);
	});

	it("cpp case A/B — 9→10 lines, brace preserved", () => {
		const cpp = "void foo()\n{\n\tswitch (type) {\n\tcase A:\n\t{\n\t\tbody;\n\t}\n\t}\n}\n";
		const hashes = lineHashesPure(cpp);
		const lines = splitLines(cpp);
		const idxA = lines.indexOf("\tcase A:"); // 3 (0-based)
		const idxClose = lines.indexOf("\t}", idxA + 1); // first } after case
		const edit = resEdit(
			{ remove_from: hashes[idxA]!, remove_to: hashes[idxClose]!, replacement_text: "\tcase A:\n\tcase B:\n\t{\n\t\tbody;\n\t}" },
			[],
		);
		const res = applyEdit(cpp, edit, undefined, hashes, "test.txt", [...hashes]);
		expect(splitLines(res.content).length).toBe(10);
		expect(res.content).toBe(
			"void foo()\n{\n\tswitch (type) {\n\tcase A:\n\tcase B:\n\t{\n\t\tbody;\n\t}\n\t}\n}\n",
		);
		expect(res.autoFixes ?? []).toHaveLength(0);
	});

	it("does not splice leading dup either", () => {
		const content = "x\ny\nz\n";
		const hashes = lineHashesPure(content);
		const edit = resEdit({ remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "x\ny2" }, []);
		const res = applyEdit(content, edit, undefined, hashes, "test.txt", [...hashes]);
		expect(res.autoFixes ?? []).toHaveLength(0);
		expect(splitLines(res.content)).toEqual(["x", "x", "y2", "z"]);
	});
});
