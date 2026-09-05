import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	loadHashStore,
	loadServedStore,
	shutdownHashStore,
} from "../../src/hash-store.js";
import {
	_mergeServedRows,
	loadServed,
	recordServed,
	recordServedTruncated,
	driftReported,
	markDriftReported,
	clearDriftReported,
	wipeServedState,
	servedPositionsOf,
} from "../../src/session-view.js";
import { HASH_STORE_VERSION, SERVED_TTL_MS } from "../../src/constants.js";
import { initHasher, contentChecksum } from "../../src/hashline/hasher.js";
import { getWritableTempRoot } from "../support/fixtures.js";

let tmpHome: string;
beforeAll(async () => {
	await initHasher();
});

describe("served state — record semantics", () => {
	it("round-trips served entries per file and position", async () => {
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

	it("exposes leading gaps as never-served markers", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [{ position: 3, hash: "abc" }]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual([null, null, null, "abc"]);
		});
	});

	it("grows the record to the highest served position", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			await recordServed("sessionA", "/p.ts", [{ position: 5, hash: "def" }]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual([
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
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "def" }]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(["def"]);
			expect(
				(await loadServedStore()).getRetiredAnchors("sessionA", "/p.ts"),
			).toEqual(new Set(["abc"]));
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
			expect(
				(await loadServedStore()).getRetiredAnchors("sessionA", "/p.ts"),
			).toEqual(new Set(["def"]));
		});
	});

	it("ignores an empty entries batch", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", []);
			expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
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

	it("survives a hash-store shutdown and reopen", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 2, hash: "def" },
			]);
			shutdownHashStore();
			expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
		});
	});
});

describe("served state — merge helper (stale-tail invariant)", () => {
	it("drops the stale tail when a serve truncates to the current line count", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 1, hash: "def" },
				{ position: 2, hash: "ghi" },
			]);
			// The file shrank to 1 line; the new serve must not keep the old
			// tail — a hash held at a position beyond the line count is a
			// stale claim that later makes boundary anchors look ambiguous
			// (E_UNSERVED_RANGE, "served at N positions").
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }], 1);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc"]);
			expect(
				(await loadServedStore()).getRetiredAnchors("sessionA", "/p.ts"),
			).toEqual(new Set(["def", "ghi"]));
		});
	});

	it("never leaves a surviving hash at its old position after a truncating serve", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 1, hash: "def" },
			]);
			// Post-mutation diff serve: file shrank to 1 line, only "abc" shown.
			await recordServedTruncated("sessionA", "/p.ts", [{ position: 0, hash: "abc" }], 1, 0);
			const served = await loadServed("sessionA", "/p.ts");
			expect(served).toEqual(["abc"]);
			expect(servedPositionsOf(served, "abc")).toEqual([0]);
			expect(
				(await loadServedStore()).getRetiredAnchors("sessionA", "/p.ts"),
			).toEqual(new Set(["def"]));
		});
	});

	it("clears re-shaped positions from clearFrom before diff rows land", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [
				{ position: 0, hash: "aaa" },
				{ position: 1, hash: "bbb" },
				{ position: 2, hash: "ccc" },
				{ position: 3, hash: "ddd" },
			]);
			// The edit's first changed line is 1 (0-indexed): the model's
			// view of everything at/after it no longer holds.
			await recordServedTruncated("sessionA", "/p.ts", [{ position: 2, hash: "xxx" }], 4, 1);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(["aaa", null, "xxx"]);
			expect(
				(await loadServedStore()).getRetiredAnchors("sessionA", "/p.ts"),
			).toEqual(new Set(["bbb", "ccc", "ddd"]));
		});
	});

	it("rejects invalid rows before anything reaches the store", async () => {
		await withTempHome(async () => {
			expect(() =>
				_mergeServedRows([], [
					{ position: 0, hash: "abc" },
					{ position: 1, hash: "ZZZZ" },
				]),
			).toThrow(/Invalid served hash/);
			expect(() =>
				_mergeServedRows([], [{ position: -1, hash: "abc" }]),
			).toThrow(/Invalid served position/);
			// The async seam swallows store failures; an invalid batch must be
			// a no-op, never a partial write.
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "ZZZZ" }]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
		});
	});

	it("trims trailing never-served markers", () => {
		expect(_mergeServedRows([null, null], [])).toEqual([]);
		expect(_mergeServedRows(["abc", null, null], [{ position: 0, hash: "def" }])).toEqual(["def"]);
	});
});

describe("served state — session isolation", () => {
	it("keeps two sessions' served records for the same path independent", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			await recordServed("sessionB", "/p.ts", [{ position: 0, hash: "def" }]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc"]);
			expect(await loadServed("sessionB", "/p.ts")).toEqual(["def"]);
		});
	});

	it("wipes only the targeted session's served records", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
			await recordServed("sessionB", "/a.ts", [{ position: 0, hash: "def" }]);
			await wipeServedState("sessionA");
			expect(await loadServed("sessionA", "/a.ts")).toEqual([]);
			expect(await loadServed("sessionB", "/a.ts")).toEqual(["def"]);
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

	it("sees no served rows for a session that recorded nothing", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			expect(await loadServed("sessionB", "/p.ts")).toEqual([]);
		});
	});
});

describe("served state — session wipe keeps snapshots and undo", () => {
	it("removes all served records while keeping snapshots and undo", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			await recordServed("sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
			await recordServed("sessionA", "/b.ts", [{ position: 1, hash: "def" }]);
			store.upsertSnapshot("/a.ts", contentChecksum("a\n"), 1, ["abc"]);
			store.upsertUndo("/u.ts", {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["UVW"],
				resultContent: "new",
			});

			await wipeServedState("sessionA");

			expect(await loadServed("sessionA", "/a.ts")).toEqual([]);
			expect(await loadServed("sessionA", "/b.ts")).toEqual([]);
			expect(store.getSnapshot("/a.ts", "a\n")).toEqual(["abc"]);
			expect(store.getUndo("/u.ts")).toBeDefined();
		});
	});
});

describe("served state — corrupt row handling", () => {
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
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
			await corruptServed(home, "sessionA", "/p.ts", "not json");
			shutdownHashStore();
			expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
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
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
			await corruptServed(home, "sessionA", "/p.ts", '["ZZ", "ZZZZ", "a!b"]');
			shutdownHashStore();
			expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
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
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
			await corruptServed(home, "sessionA", "/p.ts", "[42]");
			shutdownHashStore();
			expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
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

describe("served state — schema versioning", () => {
	it("clears served state alongside snapshots and undo when the stored version differs", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "XYZ" }]);
			store.upsertSnapshot("/p.ts", contentChecksum("x\n"), 1, ["XYZ"]);
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

			expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
			expect((await loadHashStore()).getSnapshot("/p.ts", "x\n")).toBeUndefined();
			expect((await loadHashStore()).getUndo("/u.ts")).toBeUndefined();

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
			await markDriftReported("sessionA", "/p.ts", ["abc"]);
			expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set(["abc"]));
		});
	});

	it("preserves served rows but invalidates rebound sources when adding retired anchors", async () => {
		await withTempHome(async (home) => {
			const path = join(home, "rebound.txt");
			const content = "new\nold\n";
			await writeFile(path, content, "utf-8");
			const initialStore = await loadHashStore();
			await recordServed("sessionA", path, [
				{ position: 0, hash: "AAA" },
			]);
			initialStore.upsertSnapshot(path, contentChecksum(content), 2, [
				"BBB",
				"AAA",
			]);
			initialStore.upsertUndo(path, {
				content: "old\nnew\n",
				bom: "",
				ending: "\n",
				hashes: ["BBB", "AAA"],
				resultContent: content,
			});
			shutdownHashStore();

			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.exec("ALTER TABLE served DROP COLUMN retired");
			db.close();

			const store = await loadServedStore();
			expect(store.getAnchorReservations(path).reservedHashes).toEqual(
				new Set(["AAA"]),
			);
			expect((await loadHashStore()).getSnapshot(path, content)).toBeUndefined();
			expect((await loadHashStore()).getUndo(path)).toBeUndefined();
			store.upsertRetiredAnchors(
				"sessionA",
				path,
				JSON.stringify(["BBB"]),
			);
			expect(store.getRetiredAnchors("sessionA", path)).toEqual(
				new Set(["BBB"]),
			);
		});
	});
});

describe("served state — pruneMissing", () => {
	it("removes served records for files that no longer exist", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			await recordServed("sessionA", "/gone.ts", [{ position: 0, hash: "ZZZ" }]);
			await store.pruneMissing();
			expect(await loadServed("sessionA", "/gone.ts")).toEqual([]);
		});
	});

	it("keeps served records for files that still exist", async () => {
		await withTempHome(async (home) => {
			const existing = join(home, "keep.ts");
			await writeFile(existing, "keep\n", "utf-8");
			const store = await loadHashStore();
			await recordServed("sessionA", existing, [{ position: 0, hash: "KEP" }]);
			await store.pruneMissing();
			expect(await loadServed("sessionA", existing)).toEqual(["KEP"]);
		});
	});

	it("prunes served-only records for files with no snapshot or undo row", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			await recordServed("sessionA", "/orphan.ts", [{ position: 0, hash: "ORG" }]);
			await store.pruneMissing();
			expect(await loadServed("sessionA", "/orphan.ts")).toEqual([]);
		});
	});

	it("prunes served records alongside snapshots and undo in one pass", async () => {
		await withTempHome(async (home) => {
			const existing = join(home, "keep.ts");
			await writeFile(existing, "keep\n", "utf-8");
			const store = await loadHashStore();
			await recordServed("sessionA", existing, [{ position: 0, hash: "KEP" }]);
			await recordServed("sessionA", "/gone.ts", [{ position: 0, hash: "GON" }]);
			store.upsertSnapshot(existing, contentChecksum("keep\n"), 1, ["KEP"]);
			store.upsertSnapshot("/gone.ts", contentChecksum("gone\n"), 1, ["GON"]);
			store.upsertUndo(existing, {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["KEP"],
				resultContent: "new",
			});
			store.upsertUndo("/gone.ts", {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["GON"],
				resultContent: "new",
			});
			await store.pruneMissing();

			expect(await loadServed("sessionA", existing)).toEqual(["KEP"]);
			expect(await loadServed("sessionA", "/gone.ts")).toEqual([]);
			expect(store.getSnapshot(existing, "keep\n")).toEqual(["KEP"]);
			expect(store.getSnapshot("/gone.ts", "gone\n")).toBeUndefined();
			expect(store.getUndo(existing)).toBeDefined();
			expect(store.getUndo("/gone.ts")).toBeUndefined();
		});
	});
});

describe("served state — reported drift set", () => {
	it("merges reported hashes per file", async () => {
		await withTempHome(async () => {
			await markDriftReported("sessionA", "/a.ts", ["abc", "def"]);
			await markDriftReported("sessionA", "/a.ts", ["def", "ghi"]);
			expect(await driftReported("sessionA", "/a.ts")).toEqual(
				new Set(["abc", "def", "ghi"]),
			);
		});
	});

	it("returns an empty set for a path with no reported data", async () => {
		await withTempHome(async () => {
			expect(await driftReported("sessionA", "/missing.ts")).toEqual(new Set());
		});
	});

	it("ignores malformed reported data", async () => {
		await withTempHome(async (home) => {
			await markDriftReported("sessionA", "/p.ts", ["abc"]);
			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.prepare(
				"UPDATE served SET reported = 'not json' WHERE session_id = ? AND path = ?",
			).run("sessionA", "/p.ts");
			db.close();
			expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set());
		});
	});

	it("clears the reported set for a path", async () => {
		await withTempHome(async () => {
			await markDriftReported("sessionA", "/p.ts", ["abc"]);
			await clearDriftReported("sessionA", "/p.ts");
			expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set());
		});
	});

	it("survives a hash-store shutdown and reopen", async () => {
		await withTempHome(async () => {
			await markDriftReported("sessionA", "/p.ts", ["abc"]);
			shutdownHashStore();
			expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set(["abc"]));
		});
	});

	it("is wiped alongside the served table for the same session", async () => {
		await withTempHome(async () => {
			await markDriftReported("sessionA", "/a.ts", ["abc"]);
			await markDriftReported("sessionB", "/a.ts", ["def"]);
			await wipeServedState("sessionA");
			expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set());
			expect(await driftReported("sessionB", "/a.ts")).toEqual(new Set(["def"]));
		});
	});

	it("is pruned when the file no longer exists", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			await markDriftReported("sessionA", "/gone.ts", ["abc"]);
			await store.pruneMissing();
			expect(await driftReported("sessionA", "/gone.ts")).toEqual(new Set());
		});
	});
});

describe("served state — TTL sweep", () => {
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
			await recordServed("sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 2, hash: "def" },
			]);
			shutdownHashStore();
			await ageServedRow(home, "sessionA", "/p.ts", Date.now() - SERVED_TTL_MS - 1000);
			expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
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
			await recordServed("sessionA", "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 2, hash: "def" },
			]);
			shutdownHashStore();
			expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
		});
	});

	it("prunes an old row of one session while keeping another session's fresh row", async () => {
		await withTempHome(async (home) => {
			await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
			await recordServed("sessionB", "/p.ts", [{ position: 0, hash: "def" }]);
			shutdownHashStore();
			await ageServedRow(home, "sessionA", "/p.ts", Date.now() - SERVED_TTL_MS - 1000);
			expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
			expect(await loadServed("sessionB", "/p.ts")).toEqual(["def"]);
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
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
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
