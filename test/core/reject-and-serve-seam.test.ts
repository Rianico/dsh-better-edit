import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "node:path";
import {
	recordEchoServes,
	ServedRejectionError,
} from "../../src/hashline/served.js";
import { finalizeToolResult } from "../../src/edit-response.js";
import { applyEdit, lineHashesPure, type HEdit } from "../../src/hashline/index.js";
import { loadServed } from "../../src/session-view.js";
import { shutdownHashStore } from "../../src/hash-store.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { getWritableTempRoot } from "../support/fixtures.js";

beforeAll(async () => {
	await initHasher();
});

describe("recordEchoServes — serve-record policy", () => {
	it("records echo serves when the policy is live", async () => {
		await withTempHome(async () => {
			const path = "/a.ts";
			await recordEchoServes(
				"sessionA",
				path,
				[
					{ position: 0, hash: "h00" },
					{ position: 1, hash: "X01" },
				],
				"live",
			);
			expect(await loadServed("sessionA", path)).toEqual(["h00", "X01"]);
		});
	});

	it("records nothing when the policy is preview", async () => {
		await withTempHome(async () => {
			const path = "/a.ts";
			await recordEchoServes("sessionA", path, [{ position: 0, hash: "h00" }], "preview");
			expect(await loadServed("sessionA", path)).toEqual([]);
		});
	});
});

describe("applyEdit — stale range beats would-empty", () => {
	it("rejects E_STALE_RANGE before E_EMPTY_RANGE when both apply", () => {
		const content = "aaa\nbbb\nccc";
		const hashes = lineHashesPure(content);
		const served = [hashes[0]!, "S1", hashes[2]!];
		let error: unknown;
		try {
			applyEdit(
				content,
				{
					hash_bounds: [{ hash: hashes[0]! }, { hash: hashes[2]! }],
					content_lines: [],
				},
				undefined,
				hashes,
				"a.ts",
				served,
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ServedRejectionError);
		expect((error as ServedRejectionError).code).toBe("E_STALE_RANGE");
	});
});
describe("finalizeToolResult", () => {
	it("assembles diff, warnings, and drift notice and returns served rows", () => {
		const result = finalizeToolResult({
			diff: "+a\n-b",
			warnings: ["W1"],
			driftNotice: "drift: 1 line(s) changed outside the range:",
			servedRows: [{ position: 0, hash: "abc" }],
		});
		expect(result.content).toEqual([
			{
				type: "text",
				text: "+a\n-b\n\nW1",
			},
		]);
		expect(result.servedRows).toEqual([{ position: 0, hash: "abc" }]);
	});

	it("omits served rows and blocks when absent", () => {
		const result = finalizeToolResult({ diff: "+a\n-b" });
		expect(result.content).toEqual([{ type: "text", text: "+a\n-b" }]);
		expect(result.servedRows).toBeUndefined();
	});
});

describe("applyEdit — resolved range geometry", () => {
	it("returns startLine, endLine, boundary hashes, and delta as one value", () => {
		const content = "aaa\nbbb\nccc";
		const hashes = lineHashesPure(content);
		const edit: HEdit = {
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }],
			content_lines: ["BBB", "B2"],
		};
		const result = applyEdit(content, edit);
		expect(result.range).toEqual({
			startLine: 2,
			endLine: 2,
			startHash: hashes[1]!,
			endHash: hashes[1]!,
			delta: 1,
		});
	});

	it("reports zero delta for a noop and negative delta for a deletion", () => {
		const content = "aaa\nbbb\nccc";
		const hashes = lineHashesPure(content);
		const noop = applyEdit(content, {
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }],
			content_lines: ["bbb"],
		});
		expect(noop.range.delta).toBe(0);
		const deleted = applyEdit(content, {
			hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }],
			content_lines: [],
		});
		expect(deleted.range.delta).toBe(-1);
	});
});

let tmpHome: string;
async function withTempHome(run: () => Promise<void>): Promise<void> {
	tmpHome = await mkdtemp(
		join(await getWritableTempRoot(), "pi-hashline-reject-and-serve-test-"),
	);
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("XDG_CONFIG_HOME", "");
	try {
		await run();
	} finally {
		shutdownHashStore();
		vi.unstubAllEnvs();
		await rm(tmpHome, { recursive: true, force: true });
	}
}
