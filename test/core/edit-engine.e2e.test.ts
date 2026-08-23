import { describe, expect, it } from "vitest";
import { readFile, stat as nodeStat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
	withTempFile,
	withTempBytes,
	setupIntegrationTest,
	getText,
} from "../support/fixtures.js";
import { ctxFsIO, type FileIO } from "../../src/fs-bridge.js";

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

/**
 * Disk-backed ctx.fs double with the host decoder's BOM-stripping semantics.
 * Raw reads enforce the real API's whole-file maxBytes contract.
 */
function bomStrippingCtxIO(): FileIO {
	const fs = {
		sandboxMode: undefined,
		resolve: async (path: string, opts?: { cwd?: string }) => {
			const absolutePath = isAbsolute(path)
				? path
				: resolvePath(opts?.cwd ?? process.cwd(), path);
			return { targetKey: absolutePath, displayPath: absolutePath };
		},
		processPath: (target: { displayPath: string }) => target.displayPath,
		readText: async (target: { displayPath: string }) =>
			new TextDecoder("utf-8", { fatal: true }).decode(
				await readFile(target.displayPath),
			),
		readBytes: async (
			target: { displayPath: string },
			signal: AbortSignal | undefined,
			maxBytes: number,
		) => {
			signal?.throwIfAborted();
			const bytes = await readFile(target.displayPath);
			if (bytes.length > maxBytes) {
				throw Object.assign(new Error("file exceeds byte limit"), {
					code: "FS_TOO_LARGE",
				});
			}
			return bytes;
		},
		stat: async (target: { displayPath: string }) => {
			const info = await nodeStat(target.displayPath);
			return {
				version: `${info.mtimeMs}:${info.size}`,
				type: "file",
				size: info.size,
			};
		},
		writeText: async (
			target: { displayPath: string },
			content: string,
		) => {
			await writeFile(target.displayPath, content, "utf-8");
			const info = await nodeStat(target.displayPath);
			return {
				version: `${info.mtimeMs}:${info.size}`,
				operation: "update",
				before: null,
				after: content,
			};
		},
	};
	const ctx = {
		waterfall: async () => undefined,
		emit: () => undefined,
	};
	return ctxFsIO(fs as never, ctx as never);
}

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

	it("ctxFsIO preserves exact UTF-8 BOM and CRLF bytes through edit and undo", async () => {
		const original = Buffer.from("\uFEFFline one\r\nline two\r\n", "utf-8");
		await withTempBytes("t.txt", original, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd, bomStrippingCtxIO());
			const served = await servedRows(harness, "t.txt");
			const one = served.find((r) => r.content === "line one")!;

			await harness.editTool.execute("edit", {
				path: "t.txt",
				remove_from: one.hash,
				remove_to: one.hash,
				replacement_text: "line ONE",
			});
			expect(await readFile(path)).toEqual(
				Buffer.from("\uFEFFline ONE\r\nline two\r\n", "utf-8"),
			);

			const res = await undoTool(harness).execute("undo_last_edit", {
				path: "t.txt",
			});
			expect(getText(res)).toContain("Undone last edit on t.txt.");
			expect(await readFile(path)).toEqual(original);
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
