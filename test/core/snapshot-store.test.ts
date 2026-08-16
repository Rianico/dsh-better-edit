import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	loadHashStore,
	shutdownHashStore,
	type HashStore,
} from "../../src/hash-store.js";
import { initHasher, contentChecksum } from "../../src/hashline/hasher.js";
import { splitLines } from "../../src/utils.js";
import { getWritableTempRoot } from "../support/fixtures.js";

let tmpHome: string;
beforeAll(async () => {
	await initHasher();
});

async function withTempHome(
	run: (home: string) => Promise<void>,
): Promise<void> {
	tmpHome = await mkdtemp(
		join(await getWritableTempRoot(), "pi-hashline-snapshot-test-"),
	);
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("XDG_CONFIG_HOME", "");
	try {
		await run(tmpHome);
	} finally {
		shutdownHashStore();
		vi.unstubAllEnvs();
		await rm(tmpHome, { recursive: true, force: true });
	}
}

function configHome(home: string): string {
	return join(home, ".dsh", "plugins", "dsh-better-edit");
}

function sqlitePath(home: string): string {
	return join(configHome(home), "hash-store.sqlite");
}

async function put(
	store: HashStore,
	path: string,
	content: string,
	hashes: string[],
): Promise<void> {
	store.upsertSnapshot(
		path,
		contentChecksum(content),
		splitLines(content).length,
		hashes,
	);
}

describe("snapshot-store — snapshot get / upsert / delete", () => {
	it("round-trips a snapshot by path and content matching checksum", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			const content = "hello\nworld\n";
			const hashes = ["aB3", "xY7"];
			await put(store, "/path/to/file.ts", content, hashes);

			expect(store.getSnapshot("/path/to/file.ts", content)).toEqual(hashes);
		});
	});

	it("returns undefined when content changed (checksum mismatch)", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			await put(store, "/p.ts", "aaa\nbbb\n", ["aB3", "xY7"]);

			expect(store.getSnapshot("/p.ts", "aaa\nbbb\n")).toEqual(["aB3", "xY7"]);
			expect(store.getSnapshot("/p.ts", "aaa\nBBB\n")).toBeUndefined();
		});
	});

	it("overwrites an existing path with new content+hashes", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			await put(store, "/p.ts", "old\n", ["OPQ"]);
			await put(store, "/p.ts", "new\n", ["NOP"]);

			expect(store.getSnapshot("/p.ts", "old\n")).toBeUndefined();
			expect(store.getSnapshot("/p.ts", "new\n")).toEqual(["NOP"]);
		});
	});

	it("keeps unrelated snapshots intact when upserting another path", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			const aContent = "a\nb\nc\nd\ne\n".repeat(50);
			const aHashes = aContent
				.split("\n")
				.map((_, i) => i.toString(16).padStart(3, "0"));
			await put(store, "/big.ts", aContent, aHashes);
			await put(store, "/small.ts", "x\n", ["XYZ"]);

			expect(store.getSnapshot("/big.ts", aContent)).toEqual(aHashes);
			expect(store.getSnapshot("/small.ts", "x\n")).toEqual(["XYZ"]);
		});
	});
});

describe("snapshot-store — corrupt row handling", () => {
	async function corruptHashes(
		home: string,
		path: string,
		value: string,
	): Promise<void> {
		const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
		db.prepare("UPDATE snapshots SET hashes = ? WHERE path = ?").run(
			value,
			path,
		);
		db.close();
	}

	it("treats a row with unparseable hashes as a cache miss", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			await put(store, "/p.ts", "x\n", ["AAA"]);
			await corruptHashes(home, "/p.ts", "not json");
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(reloaded.getSnapshot("/p.ts", "x\n")).toBeUndefined();
			reloaded.upsertSnapshot("/p.ts", contentChecksum("x\n"), 1, ["BBB"]);
			expect(reloaded.getSnapshot("/p.ts", "x\n")).toEqual(["BBB"]);
		});
	});

	it("treats a row with non-string hashes as a cache miss", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			await put(store, "/p.ts", "x\n", ["AAA"]);
			await corruptHashes(home, "/p.ts", "[1,2]");
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(reloaded.getSnapshot("/p.ts", "x\n")).toBeUndefined();
		});
	});

	it("treats a row with malformed hash strings as a cache miss and deletes it", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			await put(store, "/p.ts", "x\n", ["AAA"]);
			await corruptHashes(home, "/p.ts", '["ZZ", "ZZZZ", "a!b"]');
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(reloaded.getSnapshot("/p.ts", "x\n")).toBeUndefined();
			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const remaining = db
				.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE path = ?")
				.get("/p.ts") as { n: number };
			db.close();
			expect(remaining.n).toBe(0);
		});
	});
});

describe("snapshot-store — pruneMissing", () => {
	it("removes snapshots for files that no longer exist", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			await put(store, "/gone.ts", "old\n", ["ZZZ"]);
			await store.pruneMissing();
			expect(store.getSnapshot("/gone.ts", "old\n")).toBeUndefined();
		});
	});

	it("removes undo entries for files that no longer exist", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			store.upsertUndo("/gone.ts", {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["ZZZ"],
				resultContent: "new",
			});
			await store.pruneMissing();
			expect(store.getUndo("/gone.ts")).toBeUndefined();
		});
	});

	it("keeps undo entries for files that still exist", async () => {
		await withTempHome(async (home) => {
			const existing = join(home, "keep.ts");
			await writeFile(existing, "keep\n", "utf-8");

			const store = await loadHashStore();
			store.upsertUndo(existing, {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["KEP"],
				resultContent: "new",
			});
			await store.pruneMissing();
			expect(store.getUndo(existing)).toBeDefined();
		});
	});

	it("keeps snapshots for files that still exist", async () => {
		await withTempHome(async (home) => {
			const existing = join(home, "keep.ts");
			await writeFile(existing, "keep\n", "utf-8");

			const store = await loadHashStore();
			await put(store, existing, "keep\n", ["KEP"]);
			await put(store, "/gone.ts", "gone\n", ["GON"]);
			await store.pruneMissing();

			expect(store.getSnapshot(existing, "keep\n")).toEqual(["KEP"]);
			expect(store.getSnapshot("/gone.ts", "gone\n")).toBeUndefined();
		});
	});

	it("prunes against live rows, not a stale snapshot", async () => {
		await withTempHome(async (home) => {
			const keep = join(home, "keep.ts");
			const grown = join(home, "grow.ts");
			await writeFile(keep, "keep\n", "utf-8");
			await writeFile(grown, "grow\n", "utf-8");

			const store = await loadHashStore();
			await put(store, keep, "keep\n", ["KEP"]);
			await put(store, "/gone.ts", "gone\n", ["GON"]);
			await put(store, grown, "grow\n", ["GRW"]);
			await store.pruneMissing();

			expect(store.getSnapshot(keep, "keep\n")).toEqual(["KEP"]);
			expect(store.getSnapshot(grown, "grow\n")).toEqual(["GRW"]);
			expect(store.getSnapshot("/gone.ts", "gone\n")).toBeUndefined();
		});
	});

	it("prunes across multiple stat batches", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const existing: { path: string; hash: string }[] = [];
			for (let i = 0; i < 70; i++) {
				const path = join(home, `keep-${i}.ts`);
				await writeFile(path, "keep\n", "utf-8");
				const hash = `K${String(i).padStart(2, "0")}`;
				await put(store, path, "keep\n", [hash]);
				existing.push({ path, hash });
			}
			for (let i = 0; i < 70; i++) {
				await put(store, `/gone-${i}.ts`, "gone\n", [
					`G${String(i).padStart(2, "0")}`,
				]);
			}
			await store.pruneMissing();
			for (const entry of existing) {
				expect(store.getSnapshot(entry.path, "keep\n")).toEqual([entry.hash]);
			}
			for (let i = 0; i < 70; i++) {
				expect(store.getSnapshot(`/gone-${i}.ts`, "gone\n")).toBeUndefined();
			}
		});
	});
});
