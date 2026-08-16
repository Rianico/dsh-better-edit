import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "node:path";

import {
	loadServed,
	recordServed,
	driftReported,
	markDriftReported,
	clearDriftReported,
	wipeServedState,
	servedPositionsOf,
	currentPositionOfDrifted,
} from "../../src/served-store.js";
import { shutdownHashStore } from "../../src/hash-store.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { getWritableTempRoot } from "../support/fixtures.js";

let tmpHome: string;
beforeAll(async () => {
	await initHasher();
});

describe("served-state — record semantics", () => {
	it("records served rows that load back by path and position", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/a.ts", [
				{ position: 0, hash: "abc" },
				{ position: 1, hash: "def" },
				{ position: 2, hash: "ghi" },
			]);
			expect(await loadServed("sessionA", "/a.ts")).toEqual(["abc", "def", "ghi"]);
		});
	});

	it("returns an empty record for a path with no served entries", async () => {
		await withTempHome(async () => {
			expect(await loadServed("sessionA", "/missing.ts")).toEqual([]);
		});
	});

	it("exposes interior gaps as never-served markers", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 2, hash: "def" },
			]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
		});
	});

	it("overwrites a previously served position", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "def" }]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(["def"]);
		});
	});

	it("marks a served position as never-served with a null hash", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 1, hash: "def" },
				{ position: 2, hash: "ghi" },
			]);
			await recordServed("sessionA", "/p.ts", [{ position: 1, hash: null }]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc", null, "ghi"]);
		});
	});

	it("keeps unrelated served records intact when recording another path", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
			await recordServed("sessionA", "/b.ts", [
				{ position: 0, hash: "def" },
				{ position: 1, hash: "ghi" },
			]);
			expect(await loadServed("sessionA", "/a.ts")).toEqual(["abc"]);
			expect(await loadServed("sessionA", "/b.ts")).toEqual(["def", "ghi"]);
		});
	});
});

describe("served-state — session isolation", () => {
	it("keeps one session's rows invisible to another session", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc"]);
			expect(await loadServed("sessionB", "/p.ts")).toEqual([]);
		});
	});

	it("wipes only the targeted session's served state", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			await recordServed("sessionB", "/p.ts", [{ position: 0, hash: "def" }]);
			await wipeServedState("sessionA");
			expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
			expect(await loadServed("sessionB", "/p.ts")).toEqual(["def"]);
		});
	});

	it("keeps reported drift sets per session", async () => {
		await withTempHome(async () => {
			await markDriftReported("sessionA", "/p.ts", ["abc"]);
			await markDriftReported("sessionB", "/p.ts", ["def"]);
			expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set(["abc"]));
			expect(await driftReported("sessionB", "/p.ts")).toEqual(new Set(["def"]));
		});
	});
});

describe("served-state — reported drift set policy", () => {
	it("marks hashes as reported and clears them on demand", async () => {
		await withTempHome(async () => {
			await markDriftReported("sessionA", "/p.ts", ["abc", "def"]);
			expect(await driftReported("sessionA", "/p.ts")).toEqual(
				new Set(["abc", "def"]),
			);
			await clearDriftReported("sessionA", "/p.ts");
			expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set());
		});
	});

	it("keeps reported sets per path", async () => {
		await withTempHome(async () => {
			await markDriftReported("sessionA", "/a.ts", ["abc"]);
			await markDriftReported("sessionA", "/b.ts", ["def"]);
			expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set(["abc"]));
			expect(await driftReported("sessionA", "/b.ts")).toEqual(new Set(["def"]));
			await clearDriftReported("sessionA", "/a.ts");
			expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set());
			expect(await driftReported("sessionA", "/b.ts")).toEqual(new Set(["def"]));
		});
	});

	it("returns an empty reported set for a path with no marks", async () => {
		await withTempHome(async () => {
			expect(await driftReported("sessionA", "/missing.ts")).toEqual(new Set());
		});
	});
});

describe("served-state — session wipe", () => {
	it("removes the session's served records and reported sets", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
			await recordServed("sessionA", "/b.ts", [{ position: 1, hash: "def" }]);
			await markDriftReported("sessionA", "/a.ts", ["abc"]);
			await wipeServedState("sessionA");
			expect(await loadServed("sessionA", "/a.ts")).toEqual([]);
			expect(await loadServed("sessionA", "/b.ts")).toEqual([]);
			expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set());
		});
	});
});

describe("served-state — servedPositionsOf reconstruction", () => {
	it("returns every served position of a hash", () => {
		const served = ["h00", null, "h02", "h00"];
		expect(servedPositionsOf(served, "h00")).toEqual([0, 3]);
		expect(servedPositionsOf(served, "h02")).toEqual([2]);
	});

	it("returns an empty list for a hash never served", () => {
		expect(servedPositionsOf(["h00", "h01"], "h99")).toEqual([]);
	});
});

describe("served-state — currentPositionOfDrifted reconstruction", () => {
	const served = ["h00", "h01", "h02", "h03", "h04"];

	it("maps through the nearest surviving neighbor below", () => {
		const currentPositions = new Map<string, number>([
			["h00", 0],
			["h04", 3],
		]);
		const surviving = new Set(["h00", "h04"]);
		expect(
			currentPositionOfDrifted(served, currentPositions, surviving, 2, 0),
		).toBe(1);
	});

	it("maps through the nearest surviving neighbor above when none survive below", () => {
		const currentPositions = new Map<string, number>([["h04", 1]]);
		const surviving = new Set(["h04"]);
		expect(
			currentPositionOfDrifted(served, currentPositions, surviving, 3, 0),
		).toBe(0);
	});

	it("falls back to served index plus delta when no neighbor survives", () => {
		expect(
			currentPositionOfDrifted(served, new Map(), new Set(), 2, 5),
		).toBe(7);
	});
});

async function withTempHome(run: () => Promise<void>): Promise<void> {
	tmpHome = await mkdtemp(
		join(await getWritableTempRoot(), "pi-hashline-served-state-test-"),
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
