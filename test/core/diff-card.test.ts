import { beforeAll, describe, expect, it } from "vitest";
import { buildBatchResult, buildChanged } from "../../src/edit-response.js";
import { lineHashes } from "../../src/hashline/index.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

beforeAll(async () => {
	await initHasher();
});

describe("diff card — buildChanged", () => {
	it("renders fenced diff block after success summary", async () => {
		const original = "aaa\nbbb\nccc\n";
		const result = "aaa\nBBB\nccc\n";
		const originalHashes = await lineHashes(original, home.testPath);
		const resultHashes = await lineHashes(result, home.testPath);

		const out = buildChanged({
			path: "test.txt",
			originalNormalized: original,
			originalHashes,
			result,
			resultHashes,
			warnings: undefined,
			snapshotId: "snap1",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 2,
				lastChangedLine: 2,
				addedLines: 1,
				removedLines: 1,
			},
		});

		const text = out.content[0]!.text;
		expect(text).toContain("Successfully edited in test.txt");
		// diff card: fenced block with language hint
		expect(text).toContain("```diff");
		expect(text).toContain("```");
		// closing fence after diff
		expect(text.indexOf("```diff")).toBeLessThan(text.lastIndexOf("```"));
		// diff content still mirrors details.diff hash-anchored rows
		expect(text).toContain("│bbb");
		expect(text).toContain("│BBB");
		expect(out.details.diff).toContain("│bbb");
	});

	it("keeps warnings before the diff fence in model content", async () => {
		const original = "aaa\nbbb\nccc\n";
		const result = "aaa\nBBB\nccc\n";
		const originalHashes = await lineHashes(original, home.testPath);
		const resultHashes = await lineHashes(result, home.testPath);

		const out = buildChanged({
			path: "test.txt",
			originalNormalized: original,
			originalHashes,
			result,
			resultHashes,
			warnings: ["Boundary duplication (leading)"],
			snapshotId: "snap1",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 2,
				lastChangedLine: 2,
				addedLines: 1,
				removedLines: 1,
			},
		});

		const text = out.content[0]!.text;
		const warnIdx = text.indexOf("Boundary duplication");
		const fenceIdx = text.indexOf("```diff");
		expect(warnIdx).toBeGreaterThan(-1);
		expect(fenceIdx).toBeGreaterThan(-1);
		expect(warnIdx).toBeLessThan(fenceIdx);
	});

	it("does not render diff fence when file becomes empty", async () => {
		const original = "aaa\nbbb\n";
		const result = "";
		const originalHashes = await lineHashes(original, home.testPath);
		const resultHashes = await lineHashes(result, home.testPath);

		const out = buildChanged({
			path: "test.txt",
			originalNormalized: original,
			originalHashes,
			result,
			resultHashes,
			warnings: undefined,
			snapshotId: "snap1",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 1,
				lastChangedLine: 2,
				addedLines: 0,
				removedLines: 2,
			},
		});

		expect(out.content[0]!.text).toBe("File is empty. Use edit to insert content.");
		expect(out.content[0]!.text).not.toContain("```diff");
	});

	it("truncates large diffs and appends hint", async () => {
		// 500-line file where every even line changes — diff > 400 lines, triggers truncateHead
		const manyOriginal = Array.from({ length: 500 }, (_, i) => `line ${i} original`).join("\n") + "\n";
		const manyResult = Array.from({ length: 500 }, (_, i) =>
			i % 2 === 0 ? `line ${i} CHANGED` : `line ${i} original`,
		).join("\n") + "\n";
		const originalHashes = await lineHashes(manyOriginal, home.testPath);
		const resultHashes = await lineHashes(manyResult, home.testPath);

		const out = buildChanged({
			path: "big.txt",
			originalNormalized: manyOriginal,
			originalHashes,
			result: manyResult,
			resultHashes,
			warnings: undefined,
			snapshotId: "snap1",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 1,
				lastChangedLine: 500,
				addedLines: 250,
				removedLines: 250,
			},
		});

		const text = out.content[0]!.text;
		expect(text).toContain("```diff");
		expect(text).toContain("[Diff truncated:");
		expect(text).toContain("showing");
		// truncated block is shorter than full details.diff
		const fenced = text.slice(text.indexOf("```diff"), text.lastIndexOf("```") + 3);
		expect(fenced.split("\n").length).toBeLessThan(out.details.diff.split("\n").length);
	});
});

describe("diff card — buildBatchResult", () => {
	it("renders per-file headers inside fenced diff for batch edits", async () => {
		const original = "aaa\nbbb\nccc\n";
		const result = "aaa\nBBB\nccc\n";
		const originalHashes = await lineHashes(original, home.testPath);
		const resultHashes = await lineHashes(result, home.testPath);

		const out = buildBatchResult([
			{
				path: "a.txt",
				originalNormalized: original,
				result,
				originalHashes,
				resultHashes,
				warnings: undefined,
				driftNotice: undefined,
				appliedCount: 1,
				noopCount: 0,
				totalAddedLines: 1,
				totalRemovedLines: 1,
			},
			{
				path: "b.txt",
				originalNormalized: original,
				result,
				originalHashes,
				resultHashes,
				warnings: undefined,
				driftNotice: undefined,
				appliedCount: 1,
				noopCount: 0,
				totalAddedLines: 1,
				totalRemovedLines: 1,
			},
		]);

		const text = out.content[0]!.text;
		expect(text).toContain("Successfully edited 2 file(s)");
		expect(text).toContain("```diff");
		expect(text).toContain("--- a.txt ---");
		expect(text).toContain("--- b.txt ---");
		expect(out.details.diff).toContain("--- a.txt ---");
	});

	it("still truncates batch diffs when combined size exceeds limits", async () => {
		const orig = Array.from({ length: 300 }, (_, i) => `orig ${i}`).join("\n") + "\n";
		const res = Array.from({ length: 300 }, (_, i) => `changed ${i}`).join("\n") + "\n";
		const oh = await lineHashes(orig, home.testPath);
		const rh = await lineHashes(res, home.testPath);

		const out = buildBatchResult([
			{
				path: "x.txt",
				originalNormalized: orig,
				result: res,
				originalHashes: oh,
				resultHashes: rh,
				warnings: undefined,
				driftNotice: undefined,
				appliedCount: 1,
				noopCount: 0,
				totalAddedLines: 300,
				totalRemovedLines: 300,
			},
			{
				path: "y.txt",
				originalNormalized: orig,
				result: res,
				originalHashes: oh,
				resultHashes: rh,
				warnings: undefined,
				driftNotice: undefined,
				appliedCount: 1,
				noopCount: 0,
				totalAddedLines: 300,
				totalRemovedLines: 300,
			},
		]);

		expect(out.content[0]!.text).toContain("```diff");
		// combined 600 changed lines → should hit 400-line cap
		expect(out.content[0]!.text).toContain("[Diff truncated:");
	});
});
