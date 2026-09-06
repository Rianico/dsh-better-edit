import { describe, expect, it, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import {
	withTempFile,
	setupIntegrationTest,
	getText,
} from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hasher.js";

beforeAll(async () => {
	await initHasher();
});

/** Hashes served by a read/diff, keyed by line content (the model's view). */
function servedByContent(text: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of text.split("\n")) {
		const m = line.match(/^([ +]?)([A-Za-z0-9]{3})│(.*)$/);
		if (m) map.set(m[3]!, m[2]!);
	}
	return map;
}

describe("batch edit serves stay fresh for immediate retry (#53)", () => {
	it("write → batch → retry on diff anchors without re-read", async () => {
		await withTempFile("g.txt", "1\n2\n3\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const readText = getText(await harness.readTool.execute("read", { path: "g.txt" }));
			const served1 = servedByContent(readText);
			const h2 = served1.get("2")!;
			const h3 = served1.get("3")!;
			expect(h2).toMatch(/^[A-Za-z0-9]{3}$/);
			expect(h3).toMatch(/^[A-Za-z0-9]{3}$/);

			const out1 = getText(
				(await harness.editTool.execute("edit", {
					path: "g.txt",
					edits: [
						[h2, h2, "b"],
						[h3, h3, "C"],
					],
				}) as any),
			);
			expect(out1).toContain("Successfully");
			expect(await readFile(path, "utf-8")).toBe("1\nb\nC\n");

			// Fresh anchors straight from the diff — no re-read.
			const served2 = servedByContent(out1);
			const retry = await harness.editTool.execute("edit", {
				path: "g.txt",
				edits: [[served2.get("1")!, served2.get("b")!, "a\nB"]],
			} as any);
			expect(getText(retry)).toContain("Successfully");
			expect(await readFile(path, "utf-8")).toBe("a\nB\nC\n");
		});
	});
});
