import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat, readdir } from "fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	loadHashStore,
	shutdownHashStore,
	type HashStore,
} from "../../src/hash-store.js";
import { HASH_STORE_VERSION } from "../../src/constants.js";
import { CANON_VERSION } from "../../src/hashline/hash-assign.js";
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
		join(await getWritableTempRoot(), "pi-hashline-hashstore-test-"),
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

function legacyPath(home: string): string {
	return join(configHome(home), "hash-store.json");
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

async function writeLegacyStore(
	home: string,
	snapshots: unknown,
): Promise<void> {
	await mkdir(configHome(home), { recursive: true });
	await writeFile(
		legacyPath(home),
		JSON.stringify({ version: 1, snapshots }),
		"utf-8",
	);
}

describe("hash-store — loadHashStore", () => {
	it("opens a fresh sqlite database when none exists", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			expect(existsSync(sqlitePath(home))).toBe(true);
			expect(store.getSnapshot("/none.ts", "x\n")).toBeUndefined();
		});
	});

	it("creates the config directory", async () => {
		await withTempHome(async () => {
			await loadHashStore();
			const s = await stat(configHome(tmpHome));
			expect(s.isDirectory()).toBe(true);
		});
	});
});

describe("hash-store — migration from legacy hash-store.json", () => {
	it("imports valid legacy snapshot rows and renames the file to .bak (rows are old-canon, so they rebuild on next read)", async () => {
		await withTempHome(async (home) => {
			await writeLegacyStore(home, {
				"/valid.ts": { content: "ok\n", hashes: ["ABC"] },
				"/also.ts": { content: "good\nmore\n", hashes: ["XYZ", "QWE"] },
			});

			const store = await loadHashStore();

			expect(store.getSnapshot("/valid.ts", "ok\n")).toBeUndefined();
			expect(store.getSnapshot("/also.ts", "good\nmore\n")).toBeUndefined();
			expect(existsSync(legacyPath(home))).toBe(false);
			expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);
		});
	});

	it("drops structurally invalid legacy entries, imports valid rows (old-canon, rebuilt on next read)", async () => {
		await withTempHome(async (home) => {
			await writeLegacyStore(home, {
				"/valid.ts": { content: "ok\n", hashes: ["ABC"] },
				"/missing-hashes.ts": { content: "x\n" },
				"/null-content.ts": { content: null, hashes: ["DEF"] },
				"/hashes-not-array.ts": { content: "y\n", hashes: "not-an-array" },
				"/hash-not-string.ts": { content: "z\n", hashes: [42] },
				"/also-valid.ts": { content: "good\n", hashes: ["XYZ"] },
			});

			const store = await loadHashStore();

			expect(store.getSnapshot("/valid.ts", "ok\n")).toBeUndefined();
			expect(store.getSnapshot("/also-valid.ts", "good\n")).toBeUndefined();
			expect(store.getSnapshot("/missing-hashes.ts", "x\n")).toBeUndefined();
			expect(store.getSnapshot("/null-content.ts", "")).toBeUndefined();
			expect(store.getSnapshot("/hashes-not-array.ts", "y\n")).toBeUndefined();
			expect(store.getSnapshot("/hash-not-string.ts", "z\n")).toBeUndefined();
			const paths = store.allKnownPaths().map((r) => r.path);
			expect(paths).toEqual(
				expect.arrayContaining(["/valid.ts", "/also-valid.ts"]),
			);
		});
	});

	it("skips legacy snapshots with duplicate hashes so they re-hash on next read", async () => {
		await withTempHome(async (home) => {
			await writeLegacyStore(home, {
				"/dup.ts": { content: "a\nb\n", hashes: ["AAA", "AAA"] },
				"/valid.ts": { content: "ok\n", hashes: ["ABC"] },
			});

			const store = await loadHashStore();

			expect(store.getSnapshot("/dup.ts", "a\nb\n")).toBeUndefined();
			expect(store.getSnapshot("/valid.ts", "ok\n")).toBeUndefined();
		});
	});

	it("skips legacy snapshots with malformed hashes so they re-hash on next read", async () => {
		await withTempHome(async (home) => {
			await writeLegacyStore(home, {
				"/bad.ts": { content: "x\n", hashes: ["ZZ", "ZZZZ"] },
				"/valid.ts": { content: "ok\n", hashes: ["ABC"] },
			});

			const store = await loadHashStore();

			expect(store.getSnapshot("/bad.ts", "x\n")).toBeUndefined();
			expect(store.getSnapshot("/valid.ts", "ok\n")).toBeUndefined();
		});
	});

	it("ignores a legacy snapshots field that is an array", async () => {
		await withTempHome(async (home) => {
			await writeLegacyStore(home, ["not-an-object"]);

			const store = await loadHashStore();
			const paths = store.allKnownPaths();
			expect(paths).toEqual([]);
		});
	});

	it("does not run migration when no legacy file exists", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			expect(store.allKnownPaths()).toEqual([]);
			expect(existsSync(`${legacyPath(home)}.bak`)).toBe(false);
		});
	});

	it("migrates only once even if legacy file reappears", async () => {
		await withTempHome(async (home) => {
			await writeLegacyStore(home, {
				"/one.ts": { content: "1\n", hashes: ["AAA"] },
			});
			const first = await loadHashStore();
			expect(first.getSnapshot("/one.ts", "1\n")).toBeUndefined();
			expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);

			await writeFile(
				legacyPath(home),
				JSON.stringify({
					version: 1,
					snapshots: { "/two.ts": { content: "2\n", hashes: ["BBB"] } },
				}),
				"utf-8",
			);

			const second = await loadHashStore();
			expect(second.getSnapshot("/two.ts", "2\n")).toBeUndefined();
			expect(second.getSnapshot("/one.ts", "1\n")).toBeUndefined();
		});
	});
});

describe("hash-store — concurrency (issue #10)", () => {
	it("preserves snapshots written by a separately-opened connection", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			await put(store, "/a.ts", "alpha\n", ["AAB"]);

			const second = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const ins = second.prepare(
				"INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
			);
			second.exec("BEGIN IMMEDIATE");
			ins.run(
				"/b.ts",
				`${CANON_VERSION}:${contentChecksum("beta\n")}`,
				splitLines("beta\n").length,
				JSON.stringify(["BBC"]),
				Date.now(),
			);
			second.exec("COMMIT");
			second.close();
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(reloaded.getSnapshot("/a.ts", "alpha\n")).toEqual(["AAB"]);
			expect(reloaded.getSnapshot("/b.ts", "beta\n")).toEqual(["BBC"]);
		});
	});

	it("a fresh reopen sees snapshots written by a prior session", async () => {
		await withTempHome(async () => {
			const a = await loadHashStore();
			await put(a, "/first.ts", "one\n", ["111"]);
			shutdownHashStore();

			const b = await loadHashStore();
			await put(b, "/second.ts", "two\n", ["222"]);
			shutdownHashStore();

			const c = await loadHashStore();
			expect(c.getSnapshot("/first.ts", "one\n")).toEqual(["111"]);
			expect(c.getSnapshot("/second.ts", "two\n")).toEqual(["222"]);
		});
	});
});

describe("hash-store — incremental writes (issue #8)", () => {
	it("upserting a new path does not alter an existing path's stored hashes", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			const bigContent = "x\n".repeat(2000);
			const bigHashes = bigContent
				.split("\n")
				.map((_, i) => i.toString(16).padStart(3, "0"));
			await put(store, "/big.ts", bigContent, bigHashes);
			const before = store.getSnapshot("/big.ts", bigContent);

			await put(store, "/other.ts", "y\n", ["YYZ"]);

			expect(store.getSnapshot("/big.ts", bigContent)).toEqual(before);
		});
	});
});

describe("hash-store — WAL checkpoint on shutdown", () => {
	it("truncates the WAL file after shutdownHashStore", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			await put(store, "/p.ts", "x\n", ["XYZ"]);

			const walPath = sqlitePath(home) + "-wal";
			expect(existsSync(walPath)).toBe(true);

			shutdownHashStore();

			expect(existsSync(walPath)).toBe(false);
		});
	});
});

describe("hash-store — corrupt database recovery", () => {
	it("rebuilds the store when the database file is corrupt", async () => {
		await withTempHome(async (home) => {
			await mkdir(configHome(home), { recursive: true });
			await writeFile(
				sqlitePath(home),
				"this is not a sqlite database",
				"utf-8",
			);

			const store = await loadHashStore();
			expect(store.getSnapshot("/x.ts", "a\n")).toBeUndefined();

			store.upsertSnapshot("/x.ts", contentChecksum("a\n"), 1, ["AAA"]);
			expect(store.getSnapshot("/x.ts", "a\n")).toEqual(["AAA"]);
		});
	});

	it("quarantines the corrupt file instead of deleting it", async () => {
		await withTempHome(async (home) => {
			await mkdir(configHome(home), { recursive: true });
			await writeFile(sqlitePath(home), "garbage bytes", "utf-8");

			await loadHashStore();

			const entries = await readdir(configHome(home));
			expect(entries.some((name) => name.includes(".corrupt-"))).toBe(true);
			expect(existsSync(sqlitePath(home))).toBe(true);
		});
	});

	it("keeps working when the store is healthy", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			store.upsertSnapshot("/p.ts", contentChecksum("b\n"), 1, ["BBB"]);
			expect(store.getSnapshot("/p.ts", "b\n")).toEqual(["BBB"]);
			const entries = await readdir(configHome(home));
			expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
		});
	});
});

describe("hash-store — schema versioning", () => {
	it("writes the current version on first open", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			await put(store, "/p.ts", "x\n", ["XYZ"]);
			shutdownHashStore();

			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const row = db
				.prepare("SELECT value FROM meta WHERE key = 'version'")
				.get() as { value?: string } | undefined;
			db.close();

			expect(row?.value).toBe(String(HASH_STORE_VERSION));
		});
	});

	it("keeps snapshots when the stored version matches", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			await put(store, "/p.ts", "x\n", ["XYZ"]);
			shutdownHashStore();

			const reloaded = await loadHashStore();
			expect(reloaded.getSnapshot("/p.ts", "x\n")).toEqual(["XYZ"]);
		});
	});

	it("invalidates all snapshots when the stored version differs", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			await put(store, "/p.ts", "x\n", ["XYZ"]);
			store.upsertUndo("/u.ts", {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["UVW"],
				resultContent: "new",
			});
			shutdownHashStore();

			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
			db.close();

			const reloaded = await loadHashStore();
			expect(reloaded.getSnapshot("/p.ts", "x\n")).toBeUndefined();
			expect(reloaded.getUndo("/u.ts")).toBeUndefined();

			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const row = check
				.prepare("SELECT value FROM meta WHERE key = 'version'")
				.get() as { value?: string } | undefined;
			check.close();
			expect(row?.value).toBe(String(HASH_STORE_VERSION));
		});
	});

	it("keeps snapshots from a pre-versioning database and writes the version", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			await put(store, "/p.ts", "x\n", ["XYZ"]);
			shutdownHashStore();

			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.exec("DROP TABLE meta");
			db.close();

			const reloaded = await loadHashStore();
			expect(reloaded.getSnapshot("/p.ts", "x\n")).toEqual(["XYZ"]);

			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const row = check
				.prepare("SELECT value FROM meta WHERE key = 'version'")
				.get() as { value?: string } | undefined;
			check.close();
			expect(row?.value).toBe(String(HASH_STORE_VERSION));
		});
	});
});
