import { describe, expect, it, beforeAll } from "vitest";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import {
	loadServed,
	markDriftReported,
	driftReported,
	sessionKeyFor,
} from "../../src/served-store.js";
import { withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hasher.js";

beforeAll(async () => {
	await initHasher();
});

describe("readAndServe", () => {
	it("renders hashline rows, records them as served, and clears drift marks", async () => {
		await withTempFile("a.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
			const sessionKey = sessionKeyFor("session-1");
			await markDriftReported(sessionKey, path, ["abc", "def"]);

			const { text, absolutePath, hadUtf8DecodeErrors, served } =
				await readAndServe(localIO(), "a.txt", cwd, { sessionKey });

			expect(hadUtf8DecodeErrors).toBe(false);
			expect(absolutePath).toBe(path);
			expect(served).toHaveLength(3);

			const lines = text.split("\n");
			expect(lines[0]).toMatch(/^[A-Za-z0-9]{3}│one$/);
			expect(lines[1]).toMatch(/^[A-Za-z0-9]{3}│two$/);
			expect(lines[2]).toMatch(/^[A-Za-z0-9]{3}│three$/);

			const stored = await loadServed(sessionKey, path);
			expect(stored).toHaveLength(3);
			expect(stored.every((hash) => hash !== null)).toBe(true);
			expect(await driftReported(sessionKey, path)).toEqual(new Set());
		});
	});

	it("respects offset and limit when serving rows", async () => {
		await withTempFile("b.txt", "one\ntwo\nthree\nfour\n", async ({ cwd, path }) => {
			const sessionKey = sessionKeyFor("session-2");

			const { text } = await readAndServe(localIO(), "b.txt", cwd, {
				sessionKey,
				offset: 2,
				limit: 2,
			});

			const lines = text.split("\n");
			expect(lines[0]).toMatch(/^[A-Za-z0-9]{3}│two$/);
			expect(lines[1]).toMatch(/^[A-Za-z0-9]{3}│three$/);
			expect(text).toContain("[Showing lines 2-3 of 4");

			const stored = await loadServed(sessionKey, path);
			expect(stored.filter((hash) => hash !== null)).toHaveLength(2);
		});
	});
});
