import { describe, expect, it, beforeAll } from "vitest";
import { join } from "node:path";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { execPipeline } from "../../src/mutation.js";
import { shutdownHashStore } from "../../src/hash-store.js";
import {
	loadServed,
	loadEpochSnapshotId,
	recordServed,
	markDriftReported,
	driftReported,
} from "../../src/session-view.js";
import { sessionKeyFor } from "../../src/workspace-context.js";
import { withTempFile, withHome, getWritableTempRoot } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { mkdtemp } from "fs/promises";
import { rm } from "fs/promises";

beforeAll(async () => {
	await initHasher();
});

describe("epoch lifecycle belongs to full reads (#69)", () => {
	it("partial read merges window rows but preserves drift-reported", async () => {
		await withTempFile("p.txt", "one\ntwo\nthree\nfour\n", async ({ cwd, path }) => {
			const sessionKey = sessionKeyFor("t4-partial");
			await markDriftReported(sessionKey, path, ["abc"]);

			await readAndServe(localIO(), "p.txt", cwd, {
				sessionKey,
				offset: 2,
				limit: 2,
			});

			expect(await driftReported(sessionKey, path)).toEqual(new Set(["abc"]));
		});
	});

	it("full read clears drift-reported", async () => {
		await withTempFile("f.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
			const sessionKey = sessionKeyFor("t4-full");
			await markDriftReported(sessionKey, path, ["abc"]);

			await readAndServe(localIO(), "f.txt", cwd, { sessionKey });

			expect(await driftReported(sessionKey, path)).toEqual(new Set());
		});
	});

	it("recordServed advances epoch snapshotId on full reads only", async () => {
		const home = await mkdtemp(join(await getWritableTempRoot(), "t4-epoch-"));
		const restore = withHome(home);
		try {
			const sessionKey = sessionKeyFor("t4-epoch");
			const path = join(home, "e.txt");
			await recordServed(
				sessionKey,
				path,
				[
					{ position: 0, hash: "aaa" },
					{ position: 1, hash: "bbb" },
				],
				2,
				["aaa", "bbb"],
				["a", "b"],
				"snap-full",
			);
			expect(await loadEpochSnapshotId(sessionKey, path)).toBe("snap-full");

			await markDriftReported(sessionKey, path, ["bbb"]);
			await recordServed(
				sessionKey,
				path,
				[{ position: 1, hash: "BBB" }],
				2,
				["aaa", "BBB"],
				["a", "b"],
				"snap-partial",
			);
			const stored = await loadServed(sessionKey, path);
			expect(stored).toEqual(["aaa", "BBB"]);
			expect(await loadEpochSnapshotId(sessionKey, path)).toBe("snap-full");
			expect(await driftReported(sessionKey, path)).toEqual(new Set(["bbb"]));
		} finally {
			shutdownHashStore();
			await rm(home, { recursive: true, force: true });
			restore();
		}
	});

	it("malformed-anchor edit throws before any serve write", async () => {
		const home = await mkdtemp(join(await getWritableTempRoot(), "t4-preload-"));
		const restore = withHome(home);
		try {
			const sessionKey = sessionKeyFor("t4-preload");
			await expect(
				execPipeline(
					localIO(),
					{
						path: "nope.txt",
						remove_from: "MQX│const x = 1;",
						remove_to: "MQX",
						replacement_text: "y",
					} as any,
					home,
					{ sessionKey },
				),
			).rejects.toThrow(/\[E_BAD_ANCHOR\]/);
			expect(await loadServed(sessionKey, join(home, "nope.txt"))).toEqual([]);
		} finally {
			shutdownHashStore();
			await rm(home, { recursive: true, force: true });
			restore();
		}
	});
});
