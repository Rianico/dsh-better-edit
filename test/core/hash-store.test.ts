import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, readdir } from "fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  loadHashStore,
  loadServedStore,
  shutdownHashStore,
  type HashStore,
  type InternalHashStore,
} from "../../src/hash-store.js";
import { recordServed } from "../../src/session-view.js";
import { DomainError } from "../../src/domain-errors.js";
import { HASH_STORE_VERSION } from "../../src/constants.js";
import { CANON_VERSION } from "../../src/hashline/hash-assign.js";
import { initHasher, contentChecksum } from "../../src/hashline/hasher.js";
import { splitLines } from "../../src/utils.js";
import { getWritableTempRoot } from "../support/fixtures.js";

let tmpHome: string;
beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-hashstore-test-"));
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

function legacyPath(home: string): string {
  return join(configHome(home), "hash-store.json");
}

async function put(
  store: HashStore,
  path: string,
  content: string,
  hashes: string[],
): Promise<void> {
  store.upsertSnapshot(path, contentChecksum(content), splitLines(content).length, hashes);
}

async function writeLegacyStore(home: string, snapshots: unknown): Promise<void> {
  await mkdir(configHome(home), { recursive: true });
  await writeFile(legacyPath(home), JSON.stringify({ version: 1, snapshots }), "utf-8");
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
      expect(paths).toEqual(expect.arrayContaining(["/valid.ts", "/also-valid.ts"]));
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

  it("imports legacy rows through the snapshot module with identical messages and the .bak rename", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/valid.ts": { content: "ok\n", hashes: ["ABC"] },
        "/dup.ts": { content: "a\nb\n", hashes: ["AAA", "AAA"] },
        "/bad.ts": { content: "x\n", hashes: ["ZZ"] },
      });
      const warnings: unknown[][] = [];
      const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args);
      });
      const store = await loadHashStore();
      spy.mockRestore();

      const paths = store.allKnownPaths().map((row) => row.path);
      expect(paths).toEqual(expect.arrayContaining(["/valid.ts"]));
      expect(paths).not.toContain("/dup.ts");
      expect(paths).not.toContain("/bad.ts");
      expect(store.getSnapshot("/valid.ts", "ok\n")).toBeUndefined();
      expect(existsSync(legacyPath(home))).toBe(false);
      expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);
      const messages = warnings.map((args) => String(args[0]));
      expect(messages).toContain(
        "Skipped legacy snapshot with duplicate hashes for /dup.ts; it will be re-hashed on next read.",
      );
      expect(messages.filter((message) => message.includes("/bad.ts"))).toEqual([]);
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
      const bigHashes = bigContent.split("\n").map((_, i) => i.toString(16).padStart(3, "0"));
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
      await writeFile(sqlitePath(home), "this is not a sqlite database", "utf-8");

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
      const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      db.close();

      expect(row?.value).toBe(String(HASH_STORE_VERSION));
    });
  });

  it("creates the v7 tables, indices and lineage foreign key on a fresh store", async () => {
    await withTempHome(async (home) => {
      await loadHashStore();
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[];
      const tableNames = tables.map((table) => table.name);
      for (const expected of [
        "file_snapshots",
        "line_id_counters",
        "line_lineage",
        "file_undo",
        "served_leases",
        "served_session_meta",
      ]) {
        expect(tableNames).toContain(expected);
      }

      const fks = db.prepare("PRAGMA foreign_key_list(line_lineage)").all() as {
        table?: string;
        on_delete?: string;
      }[];
      expect(fks).toHaveLength(1);
      expect(fks[0]?.table).toBe("file_snapshots");
      expect(fks[0]?.on_delete).toBe("CASCADE");

      const insertSnapshot = (): unknown =>
        db
          .prepare(
            "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at) " +
              "VALUES (?, ?, ?, ?)",
          )
          .run("/p.ts", "h1", 1, 1);
      insertSnapshot();
      expect(insertSnapshot).toThrow();
      db.prepare(
        "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at) " +
          "VALUES (?, ?, ?, ?)",
      ).run("/p.ts", "h2", 1, 3);

      const parent = db
        .prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at) " +
            "VALUES (?, ?, ?, ?)",
        )
        .run("/q.ts", "hp", 2, 4) as { lastInsertRowid: number | bigint };
      const parentId = Number(parent.lastInsertRowid);
      const insertLineage = (snapshotId: number): unknown =>
        db
          .prepare(
            "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) " +
              "VALUES (?, ?, ?, ?, ?)",
          )
          .run(snapshotId, 1, 7, "c", "a");
      expect(() => insertLineage(parentId + 9999)).toThrow();
      insertLineage(parentId);
      db.prepare("DELETE FROM file_snapshots WHERE snapshot_id = ?").run(parentId);
      const orphans = db
        .prepare("SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id = ?")
        .get(parentId) as { n: number };
      expect(orphans.n).toBe(0);

      const indices = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[];
      const indexNames = indices.map((index) => index.name);
      for (const expected of [
        "idx_snapshots_created",
        "idx_lineage_snapshot_line_id",
        "idx_leases_line",
        "idx_leases_line_num",
        "idx_leases_file_retired",
        "idx_leases_session_anchor",
      ]) {
        expect(indexNames).toContain(expected);
      }
      db.close();
    });
  });

  it("keeps the v6 shells complete with cards on a fresh store", async () => {
    await withTempHome(async (home) => {
      await loadHashStore();
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const columns = (table: string): string[] =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (column) => column.name,
        );
      expect(columns("snapshots")).toEqual([
        "path",
        "checksum",
        "line_count",
        "hashes",
        "updated_at",
      ]);
      expect(columns("undo")).toEqual([
        "path",
        "content",
        "bom",
        "ending",
        "hashes",
        "result_content",
        "updated_at",
      ]);
      expect(columns("served")).toEqual([
        "session_id",
        "path",
        "hashes",
        "reported",
        "retired",
        "canons",
        "snapshotId",
        "cards",
        "updated_at",
      ]);
      db.close();
    });
  });

  it("replays the v6 statement set against a v7-created store", async () => {
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
      (await loadServedStore()).upsertServed("sessionA", "/p.ts", JSON.stringify(["XYZ"]));
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const stored = db
        .prepare("SELECT checksum, line_count FROM snapshots WHERE path = ?")
        .get("/p.ts") as {
        checksum: string;
        line_count: number;
      };
      const snapRow = db
        .prepare("SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?")
        .get("/p.ts", stored.checksum, stored.line_count) as { hashes: string };
      expect(JSON.parse(snapRow.hashes)).toEqual(["XYZ"]);
      const undoRow = db
        .prepare("SELECT content, bom, ending, hashes, result_content FROM undo WHERE path = ?")
        .get("/u.ts") as {
        content: string;
        bom: string;
        ending: string;
        hashes: string;
        result_content: string;
      };
      expect(undoRow).toMatchObject({
        content: "old",
        bom: "",
        ending: "\n",
        result_content: "new",
      });
      expect(JSON.parse(undoRow.hashes)).toEqual(["UVW"]);
      const servedRow = db
        .prepare(
          "SELECT hashes, reported, retired, canons, snapshotId, cards FROM served WHERE session_id = ? AND path = ?",
        )
        .get("sessionA", "/p.ts") as { hashes: string };
      expect(JSON.parse(servedRow.hashes)).toEqual(["XYZ"]);

      const now = Date.now();
      db.prepare(
        "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, " +
          "hashes = excluded.hashes, updated_at = excluded.updated_at",
      ).run("/v.ts", "ck", 2, JSON.stringify(["AAA", "BBB"]), now);
      const vSnap = db
        .prepare("SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?")
        .get("/v.ts", "ck", 2) as { hashes: string };
      expect(JSON.parse(vSnap.hashes)).toEqual(["AAA", "BBB"]);
      db.prepare(
        "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, " +
          "hashes = excluded.hashes, result_content = excluded.result_content, updated_at = excluded.updated_at",
      ).run("/v2.ts", "c", "", "\n", JSON.stringify(["DDD"]), "r", now);
      const vUndo = db
        .prepare("SELECT content, bom, ending, hashes, result_content FROM undo WHERE path = ?")
        .get("/v2.ts") as { hashes: string };
      expect(JSON.parse(vUndo.hashes)).toEqual(["DDD"]);
      db.prepare(
        "INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(session_id, path) DO UPDATE SET hashes = excluded.hashes, updated_at = excluded.updated_at",
      ).run("sessionB", "/v.ts", JSON.stringify(["CCC"]), now);
      const vServed = db
        .prepare(
          "SELECT hashes, reported, retired, canons, snapshotId, cards FROM served WHERE session_id = ? AND path = ?",
        )
        .get("sessionB", "/v.ts") as {
        hashes: string;
        reported: null;
        retired: null;
        canons: null;
        snapshotId: null;
        cards: null;
      };
      expect(JSON.parse(vServed.hashes)).toEqual(["CCC"]);
      expect(vServed).toMatchObject({
        reported: null,
        retired: null,
        canons: null,
        snapshotId: null,
        cards: null,
      });

      db.prepare("DELETE FROM snapshots WHERE path = ?").run("/v.ts");
      db.prepare("DELETE FROM undo WHERE path = ?").run("/v2.ts");
      db.prepare("DELETE FROM served WHERE session_id = ?").run("sessionB");
      db.prepare("DELETE FROM served WHERE path = ?").run("/v.ts");
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE path = ?").get("/v.ts") as {
            n: number;
          }
        ).n,
      ).toBe(0);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?").get("/v2.ts") as { n: number })
          .n,
      ).toBe(0);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM served WHERE session_id = ?").get("sessionB") as {
            n: number;
          }
        ).n,
      ).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n).toBe(1);
      db.close();

      const reopened = await loadHashStore();
      expect(reopened.getSnapshot("/p.ts", "x\n")).toEqual(["XYZ"]);
      shutdownHashStore();
    });
  });

  it("keeps every v6 row byte-identical through a v7 open and a v6 write cycle", async () => {
    await withTempHome(async (home) => {
      const rawConn = (): DatabaseSync =>
        new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const readAll = (): { snapshots: unknown[]; undo: unknown[]; served: unknown[] } => {
        const db = rawConn();
        const rows = {
          snapshots: db.prepare("SELECT * FROM snapshots ORDER BY path").all(),
          undo: db.prepare("SELECT * FROM undo ORDER BY path").all(),
          served: db.prepare("SELECT * FROM served ORDER BY session_id, path").all(),
        };
        db.close();
        return rows;
      };
      await mkdir(configHome(home), { recursive: true });
      const now = Date.now();
      const fixture = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      fixture.exec(
        "CREATE TABLE snapshots (" +
          "path TEXT PRIMARY KEY, " +
          "checksum TEXT NOT NULL, " +
          "line_count INTEGER NOT NULL, " +
          "hashes TEXT NOT NULL, " +
          "updated_at INTEGER NOT NULL" +
          ")",
      );
      fixture.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      fixture.exec(
        "CREATE TABLE undo (" +
          "path TEXT PRIMARY KEY, " +
          "content TEXT NOT NULL, " +
          "bom TEXT NOT NULL, " +
          "ending TEXT NOT NULL, " +
          "hashes TEXT NOT NULL, " +
          "result_content TEXT NOT NULL, " +
          "updated_at INTEGER NOT NULL" +
          ")",
      );
      fixture.exec(
        "CREATE TABLE served (" +
          "session_id TEXT NOT NULL, " +
          "path TEXT NOT NULL, " +
          "hashes TEXT NOT NULL, " +
          "reported TEXT, " +
          "retired TEXT, " +
          "canons TEXT, " +
          "snapshotId TEXT, " +
          "cards TEXT, " +
          "updated_at INTEGER NOT NULL, " +
          "PRIMARY KEY (session_id, path)" +
          ")",
      );
      fixture.prepare("INSERT INTO meta (key, value) VALUES ('version', '6')").run();
      fixture
        .prepare(
          "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("/p.ts", "ck", 1, JSON.stringify(["XYZ"]), now);
      fixture
        .prepare(
          "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("/u.ts", "old", "", "\n", JSON.stringify(["UVW"]), "new", now);
      fixture
        .prepare(
          "INSERT INTO served (session_id, path, hashes, reported, retired, canons, snapshotId, cards, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "sessionA",
          "/p.ts",
          JSON.stringify(["XYZ"]),
          null,
          null,
          null,
          null,
          JSON.stringify(["C1"]),
          now,
        );
      const before = {
        snapshots: fixture.prepare("SELECT * FROM snapshots ORDER BY path").all(),
        undo: fixture.prepare("SELECT * FROM undo ORDER BY path").all(),
        served: fixture.prepare("SELECT * FROM served ORDER BY session_id, path").all(),
      };
      fixture.close();

      await loadHashStore();
      shutdownHashStore();

      // Byte-identical straight after the v7 open, before any v6 write.
      expect(readAll()).toEqual(before);
      shutdownHashStore();

      const db = rawConn();
      db.prepare(
        "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, " +
          "hashes = excluded.hashes, updated_at = excluded.updated_at",
      ).run("/v.ts", "ck", 2, JSON.stringify(["AAA"]), Date.now());
      db.prepare(
        "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, " +
          "hashes = excluded.hashes, result_content = excluded.result_content, updated_at = excluded.updated_at",
      ).run("/v2.ts", "c", "", "\n", JSON.stringify(["DDD"]), "r", Date.now());
      db.prepare(
        "INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(session_id, path) DO UPDATE SET hashes = excluded.hashes, updated_at = excluded.updated_at",
      ).run("sessionB", "/v.ts", JSON.stringify(["CCC"]), Date.now());
      const cycleServed = db
        .prepare("SELECT hashes FROM served WHERE session_id = ? AND path = ?")
        .get("sessionB", "/v.ts") as { hashes: string };
      expect(JSON.parse(cycleServed.hashes)).toEqual(["CCC"]);
      db.prepare("DELETE FROM snapshots WHERE path = ?").run("/v.ts");
      db.prepare("DELETE FROM undo WHERE path = ?").run("/v2.ts");
      db.prepare("DELETE FROM served WHERE session_id = ?").run("sessionB");
      db.prepare("DELETE FROM served WHERE path = ?").run("/v.ts");
      db.close();

      const after = readAll();
      expect(after).toEqual(before);
    });
  });

  it("migrates a real v6 store forward with every row and shell column intact", async () => {
    await withTempHome(async (home) => {
      // v6 release schema, ce657e4: shells verbatim, meta stamped 6.
      await mkdir(configHome(home), { recursive: true });
      const now = Date.now();
      const fixture = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      fixture.exec(
        "CREATE TABLE snapshots (" +
          "path TEXT PRIMARY KEY, " +
          "checksum TEXT NOT NULL, " +
          "line_count INTEGER NOT NULL, " +
          "hashes TEXT NOT NULL, " +
          "updated_at INTEGER NOT NULL" +
          ")",
      );
      fixture.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      fixture.exec(
        "CREATE TABLE undo (" +
          "path TEXT PRIMARY KEY, " +
          "content TEXT NOT NULL, " +
          "bom TEXT NOT NULL, " +
          "ending TEXT NOT NULL, " +
          "hashes TEXT NOT NULL, " +
          "result_content TEXT NOT NULL, " +
          "updated_at INTEGER NOT NULL" +
          ")",
      );
      fixture.exec(
        "CREATE TABLE served (" +
          "session_id TEXT NOT NULL, " +
          "path TEXT NOT NULL, " +
          "hashes TEXT NOT NULL, " +
          "reported TEXT, " +
          "retired TEXT, " +
          "canons TEXT, " +
          "snapshotId TEXT, " +
          "cards TEXT, " +
          "updated_at INTEGER NOT NULL, " +
          "PRIMARY KEY (session_id, path)" +
          ")",
      );
      fixture.prepare("INSERT INTO meta (key, value) VALUES ('version', '6')").run();
      fixture
        .prepare(
          "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("/p.ts", contentChecksum("x\n"), 1, JSON.stringify(["XYZ"]), now);
      fixture
        .prepare(
          "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("/u.ts", "old", "", "\n", JSON.stringify(["UVW"]), "new", now);
      fixture
        .prepare(
          "INSERT INTO served (session_id, path, hashes, reported, retired, canons, snapshotId, cards, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "sessionA",
          "/p.ts",
          JSON.stringify(["XYZ"]),
          null,
          null,
          null,
          null,
          JSON.stringify(["C1"]),
          now,
        );
      const before = {
        snapshots: fixture.prepare("SELECT * FROM snapshots ORDER BY path").all(),
        undo: fixture.prepare("SELECT * FROM undo ORDER BY path").all(),
        served: fixture.prepare("SELECT * FROM served ORDER BY session_id, path").all(),
      };
      fixture.close();

      await loadHashStore();
      shutdownHashStore();

      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      expect(check.prepare("SELECT * FROM snapshots ORDER BY path").all()).toEqual(
        before.snapshots,
      );
      expect(check.prepare("SELECT * FROM undo ORDER BY path").all()).toEqual(before.undo);
      expect(check.prepare("SELECT * FROM served ORDER BY session_id, path").all()).toEqual(
        before.served,
      );
      for (const table of [
        "file_snapshots",
        "line_id_counters",
        "line_lineage",
        "file_undo",
        "served_leases",
        "served_session_meta",
      ]) {
        const row = check.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        expect(row.n).toBe(0);
      }
      const servedCols = (
        check.prepare("PRAGMA table_info(served)").all() as { name: string }[]
      ).map((column) => column.name);
      expect(servedCols).toEqual([
        "session_id",
        "path",
        "hashes",
        "reported",
        "retired",
        "canons",
        "snapshotId",
        "cards",
        "updated_at",
      ]);
      const version = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      check.close();
      expect(version?.value).toBe("7");
    });
  });

  it("accepts stamp 7 without a migration write and refuses stamp 8", async () => {
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
      (await loadServedStore()).upsertServed("sessionA", "/p.ts", JSON.stringify(["XYZ"]));
      shutdownHashStore();

      const rawConn = (): DatabaseSync =>
        new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const armTrigger = (): void => {
        const db = rawConn();
        db.exec(
          "CREATE TRIGGER block_version_write BEFORE UPDATE OF value ON meta " +
            "WHEN OLD.key = 'version' BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
        );
        db.close();
      };
      const dropTrigger = (): void => {
        const db = rawConn();
        db.exec("DROP TRIGGER block_version_write");
        db.close();
      };

      armTrigger();
      const current = await loadHashStore();
      expect(current.getSnapshot("/p.ts", "x\n")).toEqual(["XYZ"]);
      shutdownHashStore();
      dropTrigger();

      const stampDb = rawConn();
      stampDb.prepare("UPDATE meta SET value = '8' WHERE key = 'version'").run();
      stampDb.close();

      const before = await readFile(sqlitePath(home));
      const failure = await loadHashStore().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DomainError);
      expect((failure as DomainError).code).toBe("E_STORE_NEWER_VERSION");
      const after = await readFile(sqlitePath(home));
      expect(after.equals(before)).toBe(true);

      const check = rawConn();
      const version = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      expect(version?.value).toBe("8");
      expect((check.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n).toBe(
        1,
      );
      expect((check.prepare("SELECT COUNT(*) AS n FROM undo").get() as { n: number }).n).toBe(1);
      expect((check.prepare("SELECT COUNT(*) AS n FROM served").get() as { n: number }).n).toBe(1);
      check.close();

      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
    });
  });

  it("survives a v6 downgrade with v6 rows intact and v7 tables empty", async () => {
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
      (await loadServedStore()).upsertServed("sessionA", "/p.ts", JSON.stringify(["XYZ"]));
      shutdownHashStore();

      const rawConn = (): DatabaseSync =>
        new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const snapshotRows = (): unknown[] => {
        const db = rawConn();
        const rows = db.prepare("SELECT * FROM snapshots ORDER BY path").all();
        db.close();
        return rows;
      };
      const beforeSnapshots = snapshotRows();
      const beforeUndo = ((): unknown[] => {
        const db = rawConn();
        const rows = db.prepare("SELECT * FROM undo ORDER BY path").all();
        db.close();
        return rows;
      })();
      const beforeServed = ((): unknown[] => {
        const db = rawConn();
        const rows = db.prepare("SELECT * FROM served ORDER BY session_id, path").all();
        db.close();
        return rows;
      })();

      // Simulate a v6 process that opened the store and re-stamped it.
      const stampDb = rawConn();
      stampDb.prepare("UPDATE meta SET value = '6' WHERE key = 'version'").run();
      stampDb.close();

      await loadHashStore();
      shutdownHashStore();

      const check = rawConn();
      expect(check.prepare("SELECT * FROM snapshots ORDER BY path").all()).toEqual(beforeSnapshots);
      expect(check.prepare("SELECT * FROM undo ORDER BY path").all()).toEqual(beforeUndo);
      expect(check.prepare("SELECT * FROM served ORDER BY session_id, path").all()).toEqual(
        beforeServed,
      );
      for (const table of [
        "file_snapshots",
        "line_id_counters",
        "line_lineage",
        "file_undo",
        "served_leases",
        "served_session_meta",
      ]) {
        const row = check.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        expect(row.n).toBe(0);
      }
      const version = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      check.close();
      expect(version?.value).toBe("7");
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

  it("refuses to open a store written by a newer version and writes nothing", async () => {
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
      const served = await loadServedStore();
      served.upsertServed("sessionA", "/p.ts", JSON.stringify(["XYZ"]));
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
      db.close();

      const before = await readFile(sqlitePath(home));
      const failure = await loadHashStore().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DomainError);
      expect((failure as DomainError).code).toBe("E_STORE_NEWER_VERSION");
      expect(String((failure as Error).message)).toContain("[MODEL] [E_STORE_NEWER_VERSION]");
      await expect(loadHashStore()).rejects.toThrow("[MODEL] [E_STORE_NEWER_VERSION]");

      const after = await readFile(sqlitePath(home));
      expect(after.equals(before)).toBe(true);

      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const version = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      expect(version?.value).toBe("999");
      const snapshots = check.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as {
        n: number;
      };
      expect(snapshots.n).toBe(1);
      const undos = check.prepare("SELECT COUNT(*) AS n FROM undo").get() as { n: number };
      expect(undos.n).toBe(1);
      const servedRow = check
        .prepare("SELECT hashes FROM served WHERE session_id = ? AND path = ?")
        .get("sessionA", "/p.ts") as { hashes: string };
      expect(JSON.parse(servedRow.hashes)).toEqual(["XYZ"]);
      check.close();

      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
    });
  });

  it("migrates an older store forward and preserves every row family", async () => {
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
      const served = await loadServedStore();
      served.upsertServed("sessionA", "/p.ts", JSON.stringify(["XYZ"]));
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.prepare("UPDATE meta SET value = '5' WHERE key = 'version'").run();
      db.close();

      const reloaded = await loadHashStore();
      expect(reloaded.getSnapshot("/p.ts", "x\n")).toEqual(["XYZ"]);
      expect(reloaded.getUndo("/u.ts")?.hashes).toEqual(["UVW"]);
      expect((await loadServedStore()).getServed("sessionA", "/p.ts")).toEqual(["XYZ"]);
      shutdownHashStore();

      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const row = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      check.close();
      expect(row?.value).toBe(String(HASH_STORE_VERSION));
    });
  });

  it("treats a repeated forward migration as a no-op and leaves a current store untouched", async () => {
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
      (await loadServedStore()).upsertServed("sessionA", "/p.ts", JSON.stringify(["XYZ"]));
      shutdownHashStore();

      const raw = (): DatabaseSync =>
        new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const stamp = (): string | undefined => {
        const db = raw();
        const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
          | { value?: string }
          | undefined;
        db.close();
        return row?.value;
      };
      const count = (table: string): number => {
        const db = raw();
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        db.close();
        return row.n;
      };
      const armTrigger = (): void => {
        const db = raw();
        db.exec(
          "CREATE TRIGGER block_version_write BEFORE UPDATE OF value ON meta " +
            "WHEN OLD.key = 'version' BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
        );
        db.close();
      };
      const dropTrigger = (): void => {
        const db = raw();
        db.exec("DROP TRIGGER block_version_write");
        db.close();
      };
      const readAll = async (): Promise<{ snapshots: number; undo: boolean; served: unknown }> => {
        const current = await loadHashStore();
        return {
          snapshots: current.allSnapshotHashes().length,
          undo: current.getUndo("/u.ts") !== undefined,
          served: (await loadServedStore()).getServed("sessionA", "/p.ts"),
        };
      };

      const stampDb = raw();
      stampDb.prepare("UPDATE meta SET value = '5' WHERE key = 'version'").run();
      stampDb.close();

      // Positive control + ROLLBACK-arm coverage: the migration's stamp write
      // is blocked, the open fails, and the store is left untouched.
      armTrigger();
      await expect(loadHashStore()).rejects.toThrow(/blocked/);
      expect(stamp()).toBe("5");
      expect(count("snapshots")).toBe(1);
      expect(count("undo")).toBe(1);
      const blockedServed = raw();
      const blockedRow = blockedServed
        .prepare("SELECT hashes FROM served WHERE session_id = ? AND path = ?")
        .get("sessionA", "/p.ts") as { hashes: string };
      blockedServed.close();
      expect(JSON.parse(blockedRow.hashes)).toEqual(["XYZ"]);
      const blockedEntries = await readdir(configHome(home));
      expect(blockedEntries.some((name) => name.includes(".corrupt-"))).toBe(false);

      // The failed migration left the store re-runnable: drop the trigger and
      // the same open migrates forward with every row family intact.
      dropTrigger();
      await loadHashStore();
      expect(await readAll()).toEqual({ snapshots: 1, undo: true, served: ["XYZ"] });
      shutdownHashStore();
      expect(stamp()).toBe(String(HASH_STORE_VERSION));

      // Refutable half: a write detector armed on a current store. Any version
      // write on a current store now throws instead of passing silently.
      armTrigger();
      const current = await loadHashStore();
      expect(current.getSnapshot("/p.ts", "x\n")).toEqual(["XYZ"]);
      shutdownHashStore();
      dropTrigger();

      const beforeBytes = await readFile(sqlitePath(home));
      await loadHashStore();
      shutdownHashStore();
      const afterBytes = await readFile(sqlitePath(home));
      expect(afterBytes.equals(beforeBytes)).toBe(true);
    });
  });

  it("treats a non-integer version stamp as unknown and migrates forward", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.prepare("UPDATE meta SET value = 'abc' WHERE key = 'version'").run();
      db.close();

      const reloaded = await loadHashStore();
      expect(reloaded.getSnapshot("/p.ts", "x\n")).toEqual(["XYZ"]);
      shutdownHashStore();

      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const row = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
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
      const row = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      check.close();
      expect(row?.value).toBe(String(HASH_STORE_VERSION));
    });
  });
});

describe("hash-store — pre-retired upgrade preserves rows", () => {
  it("adds the retired column without wiping snapshots or undo", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      const now = Date.now();
      const fixture = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      fixture.exec(
        "CREATE TABLE snapshots (" +
          "path TEXT PRIMARY KEY, " +
          "checksum TEXT NOT NULL, " +
          "line_count INTEGER NOT NULL, " +
          "hashes TEXT NOT NULL, " +
          "updated_at INTEGER NOT NULL" +
          ")",
      );
      fixture.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      fixture.exec(
        "CREATE TABLE undo (" +
          "path TEXT PRIMARY KEY, " +
          "content TEXT NOT NULL, " +
          "bom TEXT NOT NULL, " +
          "ending TEXT NOT NULL, " +
          "hashes TEXT NOT NULL, " +
          "result_content TEXT NOT NULL, " +
          "updated_at INTEGER NOT NULL" +
          ")",
      );
      // served predates the retired column: every shell except retired.
      fixture.exec(
        "CREATE TABLE served (" +
          "session_id TEXT NOT NULL, " +
          "path TEXT NOT NULL, " +
          "hashes TEXT NOT NULL, " +
          "reported TEXT, " +
          "canons TEXT, " +
          "snapshotId TEXT, " +
          "cards TEXT, " +
          "updated_at INTEGER NOT NULL, " +
          "PRIMARY KEY (session_id, path)" +
          ")",
      );
      fixture.prepare("INSERT INTO meta (key, value) VALUES ('version', '6')").run();
      fixture
        .prepare(
          "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("/p.ts", "ck", 1, JSON.stringify(["XYZ"]), now);
      fixture
        .prepare(
          "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("/u.ts", "old", "", "\n", JSON.stringify(["UVW"]), "new", now);
      fixture
        .prepare(
          "INSERT INTO served (session_id, path, hashes, reported, canons, snapshotId, cards, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("sessionA", "/p.ts", JSON.stringify(["XYZ"]), null, null, null, null, now);
      const beforeSnapshots = fixture.prepare("SELECT * FROM snapshots ORDER BY path").all();
      const beforeUndo = fixture.prepare("SELECT * FROM undo ORDER BY path").all();
      fixture.close();

      await loadHashStore();
      const served = await loadServedStore();
      served.upsertServed("sessionB", "/q.ts", JSON.stringify(["AAA"]));
      expect(served.getServed("sessionB", "/q.ts")).toEqual(["AAA"]);
      expect(served.getServed("sessionA", "/p.ts")).toEqual(["XYZ"]);
      shutdownHashStore();

      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const cols = (check.prepare("PRAGMA table_info(served)").all() as { name: string }[]).map(
        (column) => column.name,
      );
      expect(cols).toContain("retired");
      expect(check.prepare("SELECT * FROM snapshots ORDER BY path").all()).toEqual(beforeSnapshots);
      expect(check.prepare("SELECT * FROM undo ORDER BY path").all()).toEqual(beforeUndo);
      check.close();
    });
  });
});

describe("hash-store — v7 snapshot materialization", () => {
  it("(a) lineage present, legacy absent returns lineage anchors", async () => {
    await withTempHome(async () => {
      const internal = (await loadHashStore()) as unknown as InternalHashStore;
      internal.commitSnapshot({
        path: "/a.ts",
        content: "alpha\nbeta\n",
        hashes: ["AAa", "AAb"],
      });
      expect(internal.getSnapshot("/a.ts", "alpha\nbeta\n")).toEqual(["AAa", "AAb"]);
    });
  });

  it("(b) legacy row present, no lineage returns legacy anchors", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await put(store, "/b.ts", "x\n", ["XYZ"]);
      expect(store.getSnapshot("/b.ts", "x\n")).toEqual(["XYZ"]);
    });
  });

  it("(c) neither returns undefined", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      expect(store.getSnapshot("/nope.ts", "x\n")).toBeUndefined();
    });
  });

  it("(d-i) no-context serve of a legacy-only row grants no lease", async () => {
    await withTempHome(async () => {
      const internal = (await loadHashStore()) as unknown as InternalHashStore;
      await put(internal, "/d.ts", "x\n", ["XYZ"]);
      expect(internal.getSnapshot("/d.ts", "x\n")).toEqual(["XYZ"]);
      await recordServed("cp3-sess", "/d.ts", [{ position: 0, hash: "XYZ" }], 1);
      expect(internal.leaseFor("cp3-sess", "/d.ts", "XYZ")).toBeUndefined();
    });
  });

  it("(d-ii) content-present serve of a legacy-only row materializes lineage and grants", async () => {
    await withTempHome(async () => {
      const internal = (await loadHashStore()) as unknown as InternalHashStore;
      await put(internal, "/d2.ts", "x\n", ["XYZ"]);
      await recordServed("cp3-sess2", "/d2.ts", [{ position: 0, hash: "XYZ" }], 1, {
        hashes: ["XYZ"],
        content: "x\n",
      });
      expect(internal.getSnapshot("/d2.ts", "x\n")).toEqual(["XYZ"]);
      const lease = internal.leaseFor("cp3-sess2", "/d2.ts", "XYZ");
      expect(lease).toBeDefined();
      expect(lease?.lineId).toBe(1);
      expect(lease?.lineNumber).toBe(1);
    });
  });

  it("(e) lineage and legacy agree byte-for-byte on the same content", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      store.upsertSnapshot("/e.ts", contentChecksum("x\n"), 1, ["XYZ"], "x\n");
      expect(store.getSnapshot("/e.ts", "x\n")).toEqual(["XYZ"]);
      // Key oracle, both sides: the v7 snapshot hash names the legacy checksum.
      const keyed = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const snapHash = (
        keyed
          .prepare("SELECT snapshot_hash AS v FROM file_snapshots WHERE path = ?")
          .get("/e.ts") as {
          v: string;
        }
      ).v;
      const checksum = (
        keyed.prepare("SELECT checksum AS v FROM snapshots WHERE path = ?").get("/e.ts") as {
          v: string;
        }
      ).v;
      expect(snapHash).toBe(checksum);
      keyed.close();
      shutdownHashStore();
      const raw = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      raw
        .prepare(
          "DELETE FROM line_lineage WHERE snapshot_id IN " +
            "(SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
        )
        .run("/e.ts");
      raw.prepare("DELETE FROM file_snapshots WHERE path = ?").run("/e.ts");
      raw.close();
      const reopened = await loadHashStore();
      expect(reopened.getSnapshot("/e.ts", "x\n")).toEqual(["XYZ"]);
    });
  });

  it("(f) both stores present and disagreeing returns the refreshed lineage", async () => {
    await withTempHome(async () => {
      const internal = (await loadHashStore()) as unknown as InternalHashStore;
      const content = "alpha\nbeta\n";
      const h1 = ["AAa", "AAb"];
      const h2 = ["BBa", "BBb"];
      // Dual-write H1 through the full upsert (legacy row + lineage insert).
      internal.upsertSnapshot("/f.ts", contentChecksum(content), 2, h1, content);
      // Same content, new assignment: adopt refreshes the lineage to H2 while the
      // legacy row still carries H1 — the order under test decides here.
      internal.commitSnapshot({ path: "/f.ts", content, hashes: h2 });
      expect(internal.getSnapshot("/f.ts", content)).toEqual(h2);
    });
  });

  it("partially-corrupt lineage throws instead of serving a stale mix", async () => {
    await withTempHome(async (home) => {
      const internal = (await loadHashStore()) as unknown as InternalHashStore;
      const content = "alpha\nbeta\n";
      internal.commitSnapshot({ path: "/c.ts", content, hashes: ["AAa", "AAb"] });
      shutdownHashStore();
      const raw = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      raw.prepare("DELETE FROM line_lineage WHERE line_number = ?").run(2);
      raw.close();
      const reopened = (await loadHashStore()) as unknown as InternalHashStore;
      expect(() =>
        reopened.commitSnapshot({ path: "/c.ts", content, hashes: ["AAa", "AAb"] }),
      ).toThrow("stored lineage has 1 rows for 2 lines");
      // Read half: the partial lineage is not served as a truncated array.
      expect(reopened.getSnapshot("/c.ts", content)).toBeUndefined();
    });
  });

  it("lineage insert fault leaves the legacy row and falls back without crashing", async () => {
    await withTempHome(async (home) => {
      await loadHashStore();
      shutdownHashStore();
      const setup = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      setup.exec(
        "CREATE TRIGGER t2b_dual BEFORE INSERT ON line_lineage " +
          "BEGIN SELECT RAISE(ABORT, 'injected'); END;",
      );
      setup.close();
      const store = await loadHashStore();
      const content = "alpha\nbeta\n";
      expect(() =>
        store.upsertSnapshot("/g.ts", contentChecksum(content), 2, ["AAa", "AAb"], content),
      ).toThrow("injected");
      // The legacy row committed in its own transaction; lineage is absent; the
      // read falls back to legacy with no crash.
      expect(store.getSnapshot("/g.ts", content)).toEqual(["AAa", "AAb"]);
      shutdownHashStore();
      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const snapCount = (
        check.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }
      ).n;
      const linCount = (
        check.prepare("SELECT COUNT(*) AS n FROM line_lineage").get() as { n: number }
      ).n;
      expect(snapCount).toBe(0);
      expect(linCount).toBe(0);
      check.close();
    });
  });

  it("adopt on an orphan snapshot row throws; serve paths fail closed without repair", async () => {
    await withTempHome(async (home) => {
      const internal = (await loadHashStore()) as unknown as InternalHashStore;
      const content = "alpha\nbeta\n";
      const hashes = ["AAa", "AAb"];
      internal.commitSnapshot({ path: "/o.ts", content, hashes });
      shutdownHashStore();
      // Corrupt out-of-band: keep the snapshot row, empty the lineage.
      const cut = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      cut.exec("DELETE FROM line_lineage");
      cut.close();
      const reopened = (await loadHashStore()) as unknown as InternalHashStore;
      // Direct call fails loud: the orphan can never be adopted silently.
      expect(() => reopened.commitSnapshot({ path: "/o.ts", content, hashes })).toThrow(
        "snapshot row has no lineage",
      );
      // Serve path: no lease, no crash, and no silent repair of the lineage.
      await recordServed(
        "cp3-orphan",
        "/o.ts",
        [
          { position: 0, hash: "AAa" },
          { position: 1, hash: "AAb" },
        ],
        2,
        { hashes, content },
      );
      expect(reopened.leaseFor("cp3-orphan", "/o.ts", "AAa")).toBeUndefined();
      shutdownHashStore();
      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const linCount = (
        check.prepare("SELECT COUNT(*) AS n FROM line_lineage").get() as { n: number }
      ).n;
      expect(linCount).toBe(0);
      check.close();
    });
  });
});
