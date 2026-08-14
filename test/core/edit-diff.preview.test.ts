import { beforeAll, describe, expect, it } from "vitest";
import { genDiff } from "../../src/edit-diff.js";
import { initHasher } from "../../src/hashline/index.js";

beforeAll(async () => {
  await initHasher();
});
describe("genDiff", () => {
	it("adds hash hints for context and addition lines and pads deletion lines to align the '│' column", () => {
		const result = genDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
		const diff = result.diff;
		expect(diff).toMatch(/^ [A-Za-z0-9]{3}│alpha$/m);
		expect(diff).toMatch(/^\+[A-Za-z0-9]{3}│BETA$/m);
		expect(diff).toMatch(/^- {3}│beta$/m);
		expect(diff).toMatch(/^ [A-Za-z0-9]{3}│gamma$/m);
	});

	it("carries the old hashes on deletion rows when oldContentHashes are provided", () => {
		const { diff } = genDiff(
			"alpha\nbeta\ngamma",
			"alpha\nBETA\ngamma",
			1,
			undefined,
			["AAA", "BBB", "CCC"],
		);
		expect(diff).toMatch(/^-BBB│beta$/m);
		expect(diff).toMatch(/^\+[A-Za-z0-9]{3}│BETA$/m);
	});

	it("tracks old line numbers across skipped context and multi-line deletions", () => {
		const { diff } = genDiff(
			"a\nb\nc\nd",
			"a\nd",
			0,
			undefined,
			["H1", "H2", "H3", "H4"],
		);
		expect(diff).toContain("-H2│b");
		expect(diff).toContain("-H3│c");
	});

	it("keeps the '│' column aligned across context, addition, and deletion lines", () => {

		const before = [
			"function greet(name) {",
			"  console.log('old')",
			"  return 'hi'",
			"}",
		].join("\n");
		const after = [
			"function greet(name) {",
			"  return `Hello, ${name}`",
			"}",
		].join("\n");

		const { diff } = genDiff(before, after);

		const lines = diff.split("\n");

		const colonColumns = lines.map((line) => line.indexOf("│"));
		expect(colonColumns).toEqual(lines.map(() => 4));

		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9]{3}│function greet\(name\) \{$/));
		expect(lines).toContainEqual(expect.stringMatching(/^- {3}│ {2}console\.log\('old'\)$/));
		expect(lines).toContainEqual(expect.stringMatching(/^\+[A-Za-z0-9]{3}│ {2}return `Hello, \$\{name\}`$/));
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9]{3}│\}$/));
		expect(lines).toContainEqual(expect.stringMatching(/^- {3}│ {2}console\.log\('old'\)$/));
		expect(lines).toContainEqual(expect.stringMatching(/^\+[A-Za-z0-9]{3}│ {2}return `Hello, \$\{name\}`$/));
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9]{3}│\}$/));
	});
	it("truncates context between two distant changes", () => {
		const lines = [];
		for (let i = 1; i <= 1000; i++) lines.push("line " + i);
		const before = "BEFORE\n" + lines.join("\n") + "\nAFTER";
		const after = "BEFORE_CHANGED\n" + lines.join("\n") + "\nAFTER_CHANGED";

		const { diff } = genDiff(before, after, 4);
		const diffLines = diff.split("\n");

		expect(diffLines.length).toBeLessThan(50);

		const ellipsisCount = diffLines.filter((l: string) => l.trim() === "...").length;
		expect(ellipsisCount).toBe(1);

		const ellipsisIdx = diffLines.findIndex((l: string) => l.trim() === "...");
		expect(ellipsisIdx).toBeGreaterThan(0);
		expect(ellipsisIdx).toBeLessThan(diffLines.length - 1);

		expect(diffLines[ellipsisIdx - 1]).toContain("line 4");
		expect(diffLines[ellipsisIdx + 1]).toContain("line 997");

		expect(diff).toContain("BEFORE_CHANGED");
		expect(diff).toContain("AFTER_CHANGED");
	});
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

describe("genDiff — property: column alignment", () => {
  const vocab = [
    "",
    "}",
    "  foo",
    "import x",
    "a = 1;",
    "// c",
    "a│b",
    "line with │ inside",
    "  const y = 2;",
  ];

  it("keeps the │ separator at column 4 for every diff row across random content", () => {
    for (let iter = 0; iter < 200; iter++) {
      const rnd = mulberry32(iter * 2654435761 + 17);
      const oldContent = Array.from(
        { length: randInt(rnd, 0, 30) },
        () => vocab[randInt(rnd, 0, vocab.length - 1)]!,
      ).join("\n");
      const newContent = Array.from(
        { length: randInt(rnd, 0, 30) },
        () => vocab[randInt(rnd, 0, vocab.length - 1)]!,
      ).join("\n");

      const { diff } = genDiff(oldContent, newContent, randInt(rnd, 0, 4));
      for (const line of diff.split("\n")) {
        if (line.includes("│")) {
          expect(
            line.indexOf("│"),
            `column drift for iter ${iter}: ${JSON.stringify(line)}`,
          ).toBe(4);
        }
      }
    }
  });

  it("keeps the │ separator aligned with single-line diffs too", () => {
    const { diff } = genDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
    for (const line of diff.split("\n")) {
      if (line.includes("│")) expect(line.indexOf("│")).toBe(4);
    }
  });
});
