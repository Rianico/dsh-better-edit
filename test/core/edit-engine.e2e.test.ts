import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
	withTempFile,
	setupIntegrationTest,
	getText,
} from "../support/fixtures.js";

type Tool = {
	execute: (
		_callId: string,
		params: unknown,
	) => Promise<{ content: Array<{ text?: string }> }>;
};

function batchTool(
	harness: ReturnType<typeof setupIntegrationTest>,
): Tool {
	return harness.getTool("batch_edit") as unknown as Tool;
}

function undoTool(
	harness: ReturnType<typeof setupIntegrationTest>,
): Tool {
	return harness.getTool("undo_last_edit") as unknown as Tool;
}

const CONTENT = "line one\nline two\nline three\n";

/** Read through the hashline `read` tool so anchors are served, then parse rows. */
async function servedRows(
	harness: ReturnType<typeof setupIntegrationTest>,
	path: string,
): Promise<Array<{ hash: string; content: string }>> {
	const res = await harness.readTool.execute("read", { path });
	const rows: Array<{ hash: string; content: string }> = [];
	for (const line of getText(res).split("\n")) {
		const sep = line.indexOf("│");
		if (sep === -1) continue;
		rows.push({ hash: line.slice(0, sep), content: line.slice(sep + 1) });
	}
	return rows;
}

describe("edit-sequence engine — end-to-end through the tool builders", () => {
	it("batch_edit applies multiple edits to one file in order", async () => {
		await withTempFile("t.txt", CONTENT, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const one = served.find((r) => r.content === "line one")!;
			const three = served.find((r) => r.content === "line three")!;

			const res = await batchTool(harness).execute("batch_edit", {
				edits: [
					{ path: "t.txt", remove_from: one.hash, remove_to: one.hash, replacement_text: "ONE" },
					{ path: "t.txt", remove_from: three.hash, remove_to: three.hash, replacement_text: "THREE" },
				],
			});

			const text = getText(res);
			expect(text).toContain("Successfully edited 1 file(s)");
			expect(text).toContain("2 of 2 edit(s) applied");
			expect(await readFile(path, "utf-8")).toBe("ONE\nline two\nTHREE\n");
		});
	});

	it("batch_edit with a failing edit aborts atomically — nothing written, earlier items unapplied", async () => {
		await withTempFile("t.txt", CONTENT, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const one = served.find((r) => r.content === "line one")!;

			await expect(
				batchTool(harness).execute("batch_edit", {
					edits: [
						{ path: "t.txt", remove_from: one.hash, remove_to: one.hash, replacement_text: "ONE" },
						{ path: "t.txt", remove_from: "zzz", remove_to: "zzz", replacement_text: "NOPE" },
					],
				}),
			).rejects.toThrow(/E_BATCH_ABORT/);

			expect(await readFile(path, "utf-8")).toBe(CONTENT);
		});
	});

	it("undo_last_edit reverts a single edit to the exact prior content", async () => {
		await withTempFile("t.txt", CONTENT, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const one = served.find((r) => r.content === "line one")!;

			await harness.editTool.execute("edit", {
				path: "t.txt",
				remove_from: one.hash,
				remove_to: one.hash,
				replacement_text: "ONE",
			});
			expect(await readFile(path, "utf-8")).toBe("ONE\nline two\nline three\n");

			const res = await undoTool(harness).execute("undo_last_edit", { path: "t.txt" });
			expect(getText(res)).toContain("Undone last edit on t.txt.");
			expect(await readFile(path, "utf-8")).toBe(CONTENT);
		});
	});

	it("undo_last_edit reverts a batch to the exact prior content", async () => {
		await withTempFile("t.txt", CONTENT, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const one = served.find((r) => r.content === "line one")!;
			const three = served.find((r) => r.content === "line three")!;

			await batchTool(harness).execute("batch_edit", {
				edits: [
					{ path: "t.txt", remove_from: one.hash, remove_to: one.hash, replacement_text: "ONE" },
					{ path: "t.txt", remove_from: three.hash, remove_to: three.hash, replacement_text: "THREE" },
				],
			});
			expect(await readFile(path, "utf-8")).toBe("ONE\nline two\nTHREE\n");

			const res = await undoTool(harness).execute("undo_last_edit", { path: "t.txt" });
			expect(getText(res)).toContain("Undone last edit on t.txt.");
			expect(await readFile(path, "utf-8")).toBe(CONTENT);
		});
	});

	it("batch_edit rejects repeated noop edits at the loop threshold", async () => {
		await withTempFile("t.txt", "line one\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const one = served.find((r) => r.content === "line one")!;
			const edit = {
				path: "t.txt",
				remove_from: one.hash,
				remove_to: one.hash,
				replacement_text: "line one",
			};

			const first = await batchTool(harness).execute("batch_edit", { edits: [edit] });
			expect(getText(first)).toContain("Classification: noop");

			const second = await batchTool(harness).execute("batch_edit", { edits: [edit] });
			expect(getText(second)).toContain("no-op'd twice");

			await expect(
				batchTool(harness).execute("batch_edit", { edits: [edit] }),
			).rejects.toThrow(/E_NOOP_LOOP/);

			expect(await readFile(path, "utf-8")).toBe("line one\n");
		});
	});
});
