import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import {
	getServed,
	upsertServed,
	getReported,
	addReported,
	clearReported,
	deleteServed,
	wipeServed,
} from "../../src/served-store.js";
import {
	pruneMissing,
	upsertSnapshot,
	getSnapshot,
} from "../../src/snapshot-store.js";
import { upsertUndo, getUndoEntry } from "../../src/undo-store.js";
import { HASH_STORE_VERSION, SERVED_TTL_MS } from "../../src/constants.js";
import { initHasher, contentChecksum } from "../../src/hashline/hasher.js";
import { getWritableTempRoot } from "../support/fixtures.js";

let tmpHome: string;
beforeAll(async () => {
	await initHasher();
});

describe("hash-store — served state (issue #2)", () => {
	it("round-trips served entries per file and position", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/a.ts", [
				{ position: 0, hash: "abc" },
				{ position: 1, hash: "def" },
				{ position: 2, hash: "ghi" },
			]);
			expect(getServed(store, "sessionA", "/a.ts")).toEqual(["abc", "def", "ghi"]);
		});
	});

	it("returns an empty record for a path with no served entries", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			expect(getServed(store, "sessionA", "/missing.ts")).toEqual([]);
		});
	});

	it("exposes interior gaps as never-served markers", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 2, hash: "def" },
			]);
			expect(getServed(store, "sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
		});
	});

	it("exposes leading gaps as never-served markers", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [{ position: 3, hash: "abc" }]);
			expect(getServed(store, "sessionA", "/p.ts")).toEqual([null, null, null, "abc"]);
		});
	});

	it("grows the record to the highest served position", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			upsertServed(store, "sessionA", "/p.ts", [{ position: 5, hash: "def" }]);
			expect(getServed(store, "sessionA", "/p.ts")).toEqual([
				"abc",
				null,
				null,
				null,
				null,
				"def",
			]);
		});
	});

	it("overwrites a previously served position", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "def" }]);
			expect(getServed(store, "sessionA", "/p.ts")).toEqual(["def"]);
		});
	});

	it("marks a served position as never-served with a null hash", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 1, hash: "def" },
				{ position: 2, hash: "ghi" },
			]);
			upsertServed(store, "sessionA", "/p.ts", [{ position: 1, hash: null }]);
			expect(getServed(store, "sessionA", "/p.ts")).toEqual(["abc", null, "ghi"]);
		});
	});

	it("ignores an empty entries batch", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", []);
			expect(getServed(store, "sessionA", "/p.ts")).toEqual([]);
		});
	});

	it("rejects an invalid hash without a partial write", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			expect(() =>
				upsertServed(store, "sessionA", "/p.ts", [
					{ position: 0, hash: "abc" },
					{ position: 1, hash: "ZZZZ" },
				]),
			).toThrow(/Invalid served hash/);
			expect(getServed(store, "sessionA", "/p.ts")).toEqual([]);
		});
	});

	it("rejects a negative position without a partial write", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			expect(() =>
				upsertServed(store, "sessionA", "/p.ts", [{ position: -1, hash: "abc" }]),
			).toThrow(/Invalid served position/);
			expect(getServed(store, "sessionA", "/p.ts")).toEqual([]);
		});
	});

	it("deletes the served record for a path", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			deleteServed(store, "sessionA", "/p.ts");
			expect(getServed(store, "sessionA", "/p.ts")).toEqual([]);
		});
	});

	it("keeps unrelated served records intact when upserting another path", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
			upsertServed(store, "sessionA", "/b.ts", [
				{ position: 0, hash: "def" },
				{ position: 1, hash: "ghi" },
			]);
			expect(getServed(store, "sessionA", "/a.ts")).toEqual(["abc"]);
			expect(getServed(store, "sessionA", "/b.ts")).toEqual(["def", "ghi"]);
			deleteServed(store, "sessionA", "/a.ts");
			expect(getServed(store, "sessionA", "/b.ts")).toEqual(["def", "ghi"]);
		});
	});

	it("survives a hash-store shutdown and reopen", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 2, hash: "def" },
			]);
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
		});
	});
});

describe("hash-store — session isolation", () => {
	it("keeps two sessions' served records for the same path independent", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			upsertServed(store, "sessionB", "/p.ts", [{ position: 0, hash: "def" }]);
			expect(getServed(store, "sessionA", "/p.ts")).toEqual(["abc"]);
			expect(getServed(store, "sessionB", "/p.ts")).toEqual(["def"]);
		});
	});

	it("wipes only the targeted session's served records", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
			upsertServed(store, "sessionB", "/a.ts", [{ position: 0, hash: "def" }]);
			wipeServed(store, "sessionA");
			expect(getServed(store, "sessionA", "/a.ts")).toEqual([]);
			expect(getServed(store, "sessionB", "/a.ts")).toEqual(["def"]);
		});
	});

	it("keeps reported drift sets per session", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			addReported(store, "sessionA", "/p.ts", ["abc"]);
			addReported(store, "sessionB", "/p.ts", ["def"]);
			expect(getReported(store, "sessionA", "/p.ts")).toEqual(new Set(["abc"]));
			expect(getReported(store, "sessionB", "/p.ts")).toEqual(new Set(["def"]));
		});
	});

	it("sees no served rows for a session that recorded nothing", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			expect(getServed(store, "sessionB", "/p.ts")).toEqual([]);
		});
	});
});

describe("hash-store — served wipe", () => {
	it("removes all served records while keeping snapshots and undo", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
			upsertServed(store, "sessionA", "/b.ts", [{ position: 1, hash: "def" }]);
			upsertSnapshot(store, "/a.ts", contentChecksum("a\n"), 1, ["abc"]);
			upsertUndo(store, "/u.ts", {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["UVW"],
				resultContent: "new",
			});

			wipeServed(store, "sessionA");

			expect(getServed(store, "sessionA", "/a.ts")).toEqual([]);
			expect(getServed(store, "sessionA", "/b.ts")).toEqual([]);
			expect(getSnapshot(store, "/a.ts", "a\n")).toEqual(["abc"]);
			expect(getUndoEntry(store, "/u.ts")).toBeDefined();
		});
	});
});

describe("hash-store — served corrupt row handling", () => {
	async function corruptServed(
		home: string,
		sessionKey: string,
		path: string,
		value: string,
	): Promise<void> {
		const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
		db.prepare(
			"UPDATE served SET hashes = ? WHERE session_id = ? AND path = ?",
		).run(value, sessionKey, path);
		db.close();
	}

	it("treats a row with unparseable hashes as an empty record and deletes it", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
			await corruptServed(home, "sessionA", "/p.ts", "not json");
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const remaining = check
				.prepare(
					"SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?",
				)
				.get("sessionA", "/p.ts") as { n: number };
			check.close();
			expect(remaining.n).toBe(0);
		});
	});

	it("treats a row with malformed hash strings as an empty record and deletes it", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
			await corruptServed(home, "sessionA", "/p.ts", '["ZZ", "ZZZZ", "a!b"]');
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const remaining = check
				.prepare(
					"SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?",
				)
				.get("sessionA", "/p.ts") as { n: number };
			check.close();
			expect(remaining.n).toBe(0);
		});
	});

	it("treats a row with non-string entries as an empty record and deletes it", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
			await corruptServed(home, "sessionA", "/p.ts", "[42]");
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const remaining = check
				.prepare(
					"SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?",
				)
				.get("sessionA", "/p.ts") as { n: number };
			check.close();
			expect(remaining.n).toBe(0);
		});
	});
});

describe("hash-store — served schema versioning", () => {
	it("clears served state alongside snapshots and undo when the stored version differs", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [{ position: 0, hash: "XYZ" }]);
			upsertSnapshot(store, "/p.ts", contentChecksum("x\n"), 1, ["XYZ"]);
			upsertUndo(store, "/u.ts", {
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
			expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
			expect(getSnapshot(reloaded, "/p.ts", "x\n")).toBeUndefined();
			expect(getUndoEntry(reloaded, "/u.ts")).toBeUndefined();

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

	it("rebuilds a pre-session-keyed served table into the session-partitioned schema", async () => {
		await withTempHome(async (home) => {
			await mkdir(configHome(home), { recursive: true });
			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			db.exec("INSERT INTO meta (key, value) VALUES ('version', '5')");
			db.exec(
				"CREATE TABLE served (path TEXT PRIMARY KEY, hashes TEXT NOT NULL, updated_at INTEGER NOT NULL)",
			);
			db.close();
			const store = await loadHashStore();
			addReported(store, "sessionA", "/p.ts", ["abc"]);
			expect(getReported(store, "sessionA", "/p.ts")).toEqual(new Set(["abc"]));
		});
	});
});

describe("hash-store — served pruneMissing", () => {
	it("removes served records for files that no longer exist", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/gone.ts", [{ position: 0, hash: "ZZZ" }]);
			await pruneMissing(store);
			expect(getServed(store, "sessionA", "/gone.ts")).toEqual([]);
		});
	});

	it("keeps served records for files that still exist", async () => {
		await withTempHome(async (home) => {
			const existing = join(home, "keep.ts");
			await writeFile(existing, "keep\n", "utf-8");
			const store = await loadHashStore();
			upsertServed(store, "sessionA", existing, [{ position: 0, hash: "KEP" }]);
			await pruneMissing(store);
			expect(getServed(store, "sessionA", existing)).toEqual(["KEP"]);
		});
	});

	it("prunes served-only records for files with no snapshot or undo row", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/orphan.ts", [{ position: 0, hash: "ORG" }]);
			await pruneMissing(store);
			expect(getServed(store, "sessionA", "/orphan.ts")).toEqual([]);
		});
	});

	it("prunes served records alongside snapshots and undo in one pass", async () => {
		await withTempHome(async (home) => {
			const existing = join(home, "keep.ts");
			await writeFile(existing, "keep\n", "utf-8");
			const store = await loadHashStore();
			upsertServed(store, "sessionA", existing, [{ position: 0, hash: "KEP" }]);
			upsertServed(store, "sessionA", "/gone.ts", [{ position: 0, hash: "GON" }]);
			upsertSnapshot(store, existing, contentChecksum("keep\n"), 1, ["KEP"]);
			upsertSnapshot(store, "/gone.ts", contentChecksum("gone\n"), 1, ["GON"]);
			upsertUndo(store, existing, {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["KEP"],
				resultContent: "new",
			});
			upsertUndo(store, "/gone.ts", {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["GON"],
				resultContent: "new",
			});
			await pruneMissing(store);

			expect(getServed(store, "sessionA", existing)).toEqual(["KEP"]);
			expect(getServed(store, "sessionA", "/gone.ts")).toEqual([]);
			expect(getSnapshot(store, existing, "keep\n")).toEqual(["KEP"]);
			expect(getSnapshot(store, "/gone.ts", "gone\n")).toBeUndefined();
			expect(getUndoEntry(store, existing)).toBeDefined();
			expect(getUndoEntry(store, "/gone.ts")).toBeUndefined();
		});
	});
});

describe("hash-store — reported drift set (issue #6)", () => {
	it("merges reported hashes per file", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			addReported(store, "sessionA", "/a.ts", ["abc", "def"]);
			addReported(store, "sessionA", "/a.ts", ["def", "ghi"]);
			expect(getReported(store, "sessionA", "/a.ts")).toEqual(
				new Set(["abc", "def", "ghi"]),
			);
		});
	});

	it("returns an empty set for a path with no reported data", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			expect(getReported(store, "sessionA", "/missing.ts")).toEqual(new Set());
		});
	});

	it("ignores malformed reported data", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			addReported(store, "sessionA", "/p.ts", ["abc"]);
			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.prepare(
				"UPDATE served SET reported = 'not json' WHERE session_id = ? AND path = ?",
			).run("sessionA", "/p.ts");
			db.close();
			expect(getReported(store, "sessionA", "/p.ts")).toEqual(new Set());
		});
	});

	it("clears the reported set for a path", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			addReported(store, "sessionA", "/p.ts", ["abc"]);
			clearReported(store, "sessionA", "/p.ts");
			expect(getReported(store, "sessionA", "/p.ts")).toEqual(new Set());
		});
	});

	it("survives a hash-store shutdown and reopen", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			addReported(store, "sessionA", "/p.ts", ["abc"]);
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(getReported(reloaded, "sessionA", "/p.ts")).toEqual(new Set(["abc"]));
		});
	});

	it("is wiped alongside the served table for the same session", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			addReported(store, "sessionA", "/a.ts", ["abc"]);
			addReported(store, "sessionB", "/a.ts", ["def"]);
			wipeServed(store, "sessionA");
			expect(getReported(store, "sessionA", "/a.ts")).toEqual(new Set());
			expect(getReported(store, "sessionB", "/a.ts")).toEqual(new Set(["def"]));
		});
	});

	it("is pruned when the file no longer exists", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			addReported(store, "sessionA", "/gone.ts", ["abc"]);
			await pruneMissing(store);
			expect(getReported(store, "sessionA", "/gone.ts")).toEqual(new Set());
		});
	});
});

describe("hash-store — served TTL sweep (issue #17)", () => {
	async function ageServedRow(
		home: string,
		sessionKey: string,
		path: string,
		updatedAt: number,
	): Promise<void> {
		const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
		db.prepare(
			"UPDATE served SET updated_at = ? WHERE session_id = ? AND path = ?",
		).run(updatedAt, sessionKey, path);
		db.close();
	}

	it("prunes served rows older than the TTL on store open", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 2, hash: "def" },
			]);
			shutdownHashStore();
			await ageServedRow(home, "sessionA", "/p.ts", Date.now() - SERVED_TTL_MS - 1000);
			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const remaining = check
				.prepare(
					"SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?",
				)
				.get("sessionA", "/p.ts") as { n: number };
			check.close();
			expect(remaining.n).toBe(0);
		});
	});

	it("keeps a fresh served row across a close/reopen cycle so a pi -c continuation can verify against it", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 2, hash: "def" },
			]);
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
		});
	});

	it("prunes an old row of one session while keeping another session's fresh row", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			upsertServed(store, "sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
			]);
			upsertServed(store, "sessionB", "/p.ts", [
				{ position: 0, hash: "def" },
			]);
			shutdownHashStore();
			await ageServedRow(home, "sessionA", "/p.ts", Date.now() - SERVED_TTL_MS - 1000);
			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "sessionA", "/p.ts")).toEqual([]);
			expect(getServed(reloaded, "sessionB", "/p.ts")).toEqual(["def"]);
		});
	});
});

async function withTempHome(
	run: (home: string) => Promise<void>,
): Promise<void> {
	tmpHome = await mkdtemp(
		join(await getWritableTempRoot(), "pi-hashline-served-test-"),
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
