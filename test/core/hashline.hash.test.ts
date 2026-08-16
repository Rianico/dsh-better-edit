import { describe, expect, it } from "vitest";
import {
	applyEdit,
	lineHashes,
	lineHashesPure,
	parseText,
} from "../../src/hashline/index.js";
import { splitLines } from "../../src/utils.js";
import { useTestHome } from "../support/fixtures.js";
const home = useTestHome();

describe("strict hashline contract", () => {
	it("preserves internal spaces when hashing", async () => {
		const hashes = await lineHashes("a b", home.testPath);
		const hashes2 = await lineHashes("ab", home.testPath);
		expect(hashes[0]).not.toBe(hashes2[0]);
	});

	it("trims trailing spaces when hashing", async () => {
		const hashes = await lineHashes("value  ", home.testPath);
		const hashes2 = await lineHashes("value", home.testPath);
		expect(hashes[0]).toBe(hashes2[0]);
	});

	it("preserves explicit blank trailing line in string input", () => {
		expect(parseText("alpha\n")).toEqual(["alpha", ""]);
		expect(parseText("alpha\n\n")).toEqual(["alpha", "", ""]);
	});

	it("rejects stale anchors instead of relocating by hash", () => {
		const content = ["a", "INSERTED", "b", "target", "c"].join("\n");
		const stale = {
      hash_bounds: [{ hash: "ZZZZ" }, { hash: "ZZZZ" }], content_lines: ["updated"],
    } as any;
		expect(() => applyEdit(content, stale)).toThrow(/stale anchor/);
	});
});

describe("perfect hashing", () => {
	it("returns one hash per line, indexed 0-based by line number", async () => {
		const hashes = await lineHashes("alpha\nbeta\ngamma", home.testPath);
		expect(hashes).toHaveLength(3);
		expect(hashes[0]).toMatch(/^[A-Za-z0-9]{3}$/);
		expect(hashes[1]).toMatch(/^[A-Za-z0-9]{3}$/);
		expect(hashes[2]).toMatch(/^[A-Za-z0-9]{3}$/);
	});

	it("assigns different hashes to identical content at different positions", async () => {
		const file = [
			"import { foo } from 'bar';",
			"import { baz } from 'qux';",
			"import { foo } from 'bar';",
		].join("\n");
		const hashes = await lineHashes(file, home.testPath);
		expect(hashes[0]).not.toBe(hashes[2]);
		expect(hashes[0]).not.toBe(hashes[1]);
		expect(hashes[1]).not.toBe(hashes[2]);
	});

	it("assigns different hashes to symbol-only lines at different positions", async () => {
		const file = [
			"function a() {",
			"  return 1;",
			"}",
			"function b() {",
			"  return 2;",
			"}",
		].join("\n");
		const hashes = await lineHashes(file, home.testPath);
		expect(hashes[2]).not.toBe(hashes[5]);
	});

	it("lets the edit tool target a specific occurrence when content is duplicated", async () => {
		const file = [
			"const x = 1;",
			"const y = 2;",
			"const x = 1;",
		].join("\n");
		const hashes = await lineHashes(file, home.testPath);
		const result = applyEdit(file, { hash_bounds: [{ hash: hashes[2]! }, { hash: hashes[2]! }], content_lines: ["const x = 999;"] });
    expect(result.content).toBe("const x = 1;\nconst y = 2;\nconst x = 999;");
	});

	it("stale-anchor error shows the file's current state for context", () => {
		const file = ["const x = 1;", "const y = 2;", "const x = 1;"].join("\n");
		const staleHash = "ZZZZ";
		let caught: Error | undefined;
		try {
			applyEdit(file, { hash_bounds: [{ hash: staleHash }, { hash: staleHash }], content_lines: ["X"] });
    } catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_STALE_ANCHOR/);
		expect(caught!.message).toContain("Call read()");
	});

	it("rejects an ambiguous hash with [E_AMBIGUOUS_ANCHOR] (synthetic collision)", async () => {
		const file = "alpha\nbeta\ngamma\ndelta";
		const realHashes = await lineHashes(file, home.testPath);
		const forgedHashes = [...realHashes];
		forgedHashes[2] = realHashes[0]!;

		const sharedHash = realHashes[0]!;

		let caught: Error | undefined;
		try {
			applyEdit(
				file,
				{ hash_bounds: [{ hash: sharedHash }, { hash: sharedHash }], content_lines: ["X"] },
				undefined,
				forgedHashes,
			);
    } catch (error) {
			caught = error as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_AMBIGUOUS_ANCHOR/);
		expect(caught!.message).toMatch(/matches lines 1, 3/);
		expect(caught!.message).toContain(`${realHashes[0]!}│alpha`);
		expect(caught!.message).toContain(`${realHashes[0]!}│gamma`);
	});

	it("all hashes are unique for any file shape", async () => {
		const files = [
			"",
			"\n",
			"a",
			"a\n",
			"a\nb\nc",
			"a\nb\nc\n",
			"}\n}\n}\n}\n}",
			"import x\nimport y\nimport x",
			"a\n".repeat(1000),
			Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n"),
		];
		for (const file of files) {
			const hashes = await lineHashes(file, home.testPath);
			const unique = new Set(hashes);
			expect(
				unique.size,
				`Failed for file with ${file.split("\n").length} lines`
			).toBe(hashes.length);
		}
	});

	it("hash array length matches line count for edge cases", async () => {
		const cases = ["", "\n", "a", "a\n", "a\nb\nc\n"];
		for (const file of cases) {
			const hashes = await lineHashes(file, home.testPath);
			expect(hashes).toHaveLength(splitLines(file).length);
		}
	});
});

describe("pure hasher", () => {
	it("lineHashesPure agrees with the pathless wrapper and needs no store", async () => {
		const content = "alpha\nbeta\ngamma";
		const pure = lineHashesPure(content);
		// The wrapper without a path never touches the hash store — it is
		// exactly the pure path.
		const wrapper = await lineHashes(content);
		expect(pure).toEqual(wrapper);
		expect(new Set(pure).size).toBe(pure.length);
	});

	it("lineHashesPure is deterministic", () => {
		const content = "a\nb\nc\nd\ne\n";
		expect(lineHashesPure(content)).toEqual(lineHashesPure(content));
	});
});
