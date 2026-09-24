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
import { loadServed, recordServed, recordServedTruncated } from "../../src/session-view.js";
import { LineageCorruptError } from "../../src/snapshot-store/lineage-store.js";
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

  /** Frozen v6 undo INSERT (legacy-only row, no v7 mirror) for migration tests. */
  function insertV6Undo(
    home: string,
    path: string,
    entry: {
      content: string;
      bom: string;
      ending: string;
      hashes: string[];
      resultContent: string;
    },
  ): void {
    const db = new DatabaseSync(sqlitePath(home));
    db.prepare(
      "INSERT OR REPLACE INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      path,
      entry.content,
      entry.bom,
      entry.ending,
      JSON.stringify(entry.hashes),
      entry.resultContent,
      Date.now(),
    );
    db.close();
  }

  it("replays the v6 statement set against a v7-created store", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      insertV6Undo(home, "/u.ts", {
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
      insertV6Undo(home, "/u.ts", {
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
      insertV6Undo(home, "/u.ts", {
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
      insertV6Undo(home, "/u.ts", {
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
      insertV6Undo(home, "/u.ts", {
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
      insertV6Undo(home, "/u.ts", {
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

  it("#5 snapshots ↔ file_snapshots: a lineage fault rolls back the legacy row and the v7 family", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const setup = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      setup.exec(
        "CREATE TRIGGER t2b_dual BEFORE INSERT ON line_lineage " +
          "BEGIN SELECT RAISE(ABORT, 'injected'); END;",
      );
      setup.close();
      const content = "alpha\nbeta\n";
      const hashes = ["AAa", "AAb"];
      expect(() =>
        store.upsertSnapshot("/g.ts", contentChecksum(content), 2, hashes, content),
      ).toThrow("injected");
      // Pair #5 row contract: neither side of the pair may survive the fault.
      const pairCheck = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const legacyRows = (
        pairCheck.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE path = ?").get("/g.ts") as {
          n: number;
        }
      ).n;
      const v7Rows = (
        pairCheck
          .prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?")
          .get("/g.ts") as {
          n: number;
        }
      ).n;
      const lineageRows = (
        pairCheck
          .prepare(
            "SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id IN " +
              "(SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
          )
          .get("/g.ts") as { n: number }
      ).n;
      pairCheck.close();
      expect(legacyRows).toBe(0);
      expect(v7Rows).toBe(0);
      expect(lineageRows).toBe(0);
      // Same-connection proof: drop the trigger, then the same live handle must
      // succeed (a wedged transaction would fail locked).
      const drop = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      drop.exec("DROP TRIGGER t2b_dual");
      expect(() =>
        store.upsertSnapshot("/g.ts", contentChecksum(content), 2, hashes, content),
      ).not.toThrow();
      expect(store.getSnapshot("/g.ts", content)).toEqual(hashes);
      // Per-path counts: exactly one snapshot with its full lineage — no orphan,
      // no partial row set (global 0/0 would break as soon as any other row exists).
      const snapCount = (
        drop.prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?").get("/g.ts") as {
          n: number;
        }
      ).n;
      const linCount = (
        drop
          .prepare(
            "SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id IN " +
              "(SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
          )
          .get("/g.ts") as { n: number }
      ).n;
      expect(snapCount).toBe(1);
      expect(linCount).toBe(2);
      drop.close();
    });
  });
});

it("#6 served ↔ served_leases: a lease fault leaves the served row at its pre-write value", async () => {
  await withTempHome(async (home) => {
    const store = await loadServedStore();
    const sessionKey = "t3a-p6";
    const filePath = "/p6.ts";
    // Pre-write row contract: the served array as it stands before the failed pair.
    await recordServed(sessionKey, filePath, [{ position: 0, hash: "ZzZ" }], 1);
    expect(store.getServed(sessionKey, filePath)).toEqual(["ZzZ"]);

    const content = "alpha\nbeta\n";
    const hashes = ["AAa", "AAb"];
    const setup = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
    setup.exec(
      "CREATE TRIGGER t3a_lease_fault BEFORE INSERT ON served_leases " +
        "BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );
    setup.close();

    // Full read: the served upsert and the lease grant it derives from are ONE unit.
    await recordServed(
      sessionKey,
      filePath,
      [
        { position: 0, hash: hashes[0]! },
        { position: 1, hash: hashes[1]! },
      ],
      2,
      { hashes, content },
    );

    // Row contract, never a COUNT: the stored JSON is byte-identical to the pre-write value.
    expect(store.getServed(sessionKey, filePath)).toEqual(["ZzZ"]);
    const check = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
    const leases = (
      check
        .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE session_id = ? AND file_path = ?")
        .get(sessionKey, filePath) as { n: number }
    ).n;
    check.close();
    expect(leases).toBe(0);
  });
});

it("#6 truncated served ↔ served_leases: a lease fault leaves the served row at its pre-write value", async () => {
  await withTempHome(async (home) => {
    const store = await loadServedStore();
    const sessionKey = "t3a-p6t";
    const filePath = "/p6t.ts";
    // Pre-write row contract: the served array as it stands before the failed pair.
    await recordServed(sessionKey, filePath, [{ position: 0, hash: "ZzZ" }], 1);
    expect(store.getServed(sessionKey, filePath)).toEqual(["ZzZ"]);

    const content = "alpha\nbeta\n";
    const hashes = ["AAa", "AAb"];
    const setup = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
    setup.exec(
      "CREATE TRIGGER t3a_lease_fault_trunc BEFORE INSERT ON served_leases " +
        "BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );
    setup.close();

    // Truncated path, same pair contract — and the direct re-entrancy proof: the
    // nested `commitSnapshot` must JOIN the outer `withStore` unit, or this would
    // raise `cannot start a transaction within a transaction` before any assertion.
    await recordServedTruncated(
      sessionKey,
      filePath,
      [
        { position: 0, hash: hashes[0]! },
        { position: 1, hash: hashes[1]! },
      ],
      2,
      0,
      undefined,
      { hashes, content },
    );

    // Row contract, never a COUNT: the stored JSON is byte-identical to the pre-write value.
    expect(store.getServed(sessionKey, filePath)).toEqual(["ZzZ"]);
    const check = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
    const leases = (
      check
        .prepare("SELECT COUNT(*) AS n FROM served_leases WHERE session_id = ? AND file_path = ?")
        .get(sessionKey, filePath) as { n: number }
    ).n;
    check.close();
    expect(leases).toBe(0);
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
      LineageCorruptError,
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
    // Throw-arm contract (#6): a `commitSnapshot` that throws rolls the `served` row
    // back with it. A served row claiming a verification whose lease grant failed IS
    // the split the pair contract removes; `recordServed` only logs the error, so the
    // rollback — not the log — is what must be pinned here.
    expect(reopened.getServed("cp3-orphan", "/o.ts")).toEqual([]);
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

it("lineage with a corrupt anchor falls back instead of serving it", async () => {
  await withTempHome(async (home) => {
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const content = "alpha\nbeta\n";
    const hashes = ["AAa", "AAb"];
    internal.commitSnapshot({ path: "/k.ts", content, hashes });
    shutdownHashStore();
    // Corrupt out-of-band: intact numbering, invalid anchor shape.
    const cut = new DatabaseSync(sqlitePath(home), {
      defensive: false,
    } as any);
    cut.prepare("UPDATE line_lineage SET anchor = ? WHERE line_number = ?").run("!!!", 1);
    cut.close();
    const reopened = await loadHashStore();
    // No legacy row was ever written: the hit is rejected, fallback misses.
    expect(reopened.getSnapshot("/k.ts", content)).toBeUndefined();
  });
});

it("file_undo row mirrors the legacy undo row with the snapshot pin", async () => {
  await withTempHome(async () => {
    const { saveUndo, clearUndo } = await import("../../src/undo-edit.js");
    const { snapshotHashFor } = await import("../../src/snapshot-store/lineage-store.js");
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const entry = {
      content: "old\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "new\n",
    };
    const saved = await saveUndo("/u4.ts", entry);
    expect(saved.persisted).toBe(true);
    expect((await loadHashStore()).getUndo("/u4.ts")).toBeDefined();
    const v7 = internal.getFileUndo("/u4.ts");
    expect(v7).toBeDefined();
    expect(v7?.snapshotHash).toBe(snapshotHashFor("old\n"));
    expect(v7?.hashes).toEqual(["H01"]);
    expect(v7?.resultContent).toBe("new\n");
    await clearUndo("/u4.ts");
    expect(internal.getFileUndo("/u4.ts")).toBeUndefined();
    expect((await loadHashStore()).getUndo("/u4.ts")).toBeUndefined();
  });
});

it("getFileUndo maps updatedAt from the stored file_undo.updated_at", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    await saveUndo("/w.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const row = internal.getFileUndo("/w.ts");
    expect(row).toBeDefined();
    // Pin the MAPPER, not the type. `typeof updatedAt === "number"` would pass for any
    // numeric column; read the stored column directly and require the record to carry
    // exactly that value. No clock dependency, no flake.
    const check = new DatabaseSync(sqlitePath(home));
    const storedRow = check
      .prepare("SELECT updated_at AS v FROM file_undo WHERE path = ?")
      .get("/w.ts");
    check.close();
    // Runtime narrow, not a cast: a cast here would silence the compiler without
    // proving the column is numeric at all.
    const stored = storedRow?.["v"];
    if (typeof stored !== "number") throw new Error("expected numeric file_undo.updated_at");
    expect(Number.isInteger(stored)).toBe(true);
    expect(stored).toBeGreaterThan(0);
    expect(row?.updatedAt).toBe(stored);
  });
});

it("getFileUndo heals a shape-corrupt row and deletes the pair", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    await saveUndo("/shape-corrupt.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    // Happy path first, so the heal assertion below cannot be satisfied by the row never
    // having existed.
    expect(internal.getFileUndo("/shape-corrupt.ts")).toBeDefined();

    // TEXT survives INTEGER affinity, so an UPDATE to a non-numeric string really does
    // leave a non-number in the column and `mapFileUndoRow` really does reject it.
    const corrupt = new DatabaseSync(sqlitePath(home));
    corrupt
      .prepare("UPDATE file_undo SET updated_at = 'nope' WHERE path = ?")
      .run("/shape-corrupt.ts");
    corrupt.close();

    // A shape-corrupt row must take the SAME healing path as a JSON parse failure: the
    // pair is deleted and the caller sees `undefined`. The face doc at the `getFileUndo`
    // declaration promises "same healing contract as the legacy row". If the validating
    // SELECT sits outside the try, this throws instead: the throw escapes `getFileUndo`
    // -> `undo-edit.ts` `readFileUndo` -> `saveUndo`'s catch -> `persisted: false` ->
    // `mutation.ts` aborts the edit, and because the pair is never deleted every future
    // edit to this path aborts too. Fail-loud must not become fail-permanently.
    expect(internal.getFileUndo("/shape-corrupt.ts")).toBeUndefined();

    const check = new DatabaseSync(sqlitePath(home));
    const count = (table: string) =>
      check.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE path = ?`).get("/shape-corrupt.ts")?.[
        "n"
      ];
    expect(count("file_undo")).toBe(0);
    expect(count("undo")).toBe(0);
    check.close();
  });
});

it("edits to a shape-corrupt path keep succeeding after the row heals", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    const path = "/heal-repeat.ts";
    const edit = (content: string, resultContent: string, hashes: string[]) =>
      saveUndo(path, { content, bom: "", originalEnding: "\n", hashes, resultContent });

    expect((await edit("a\n", "b\n", ["H01"])).persisted).toBe(true);

    const corrupt = new DatabaseSync(sqlitePath(home));
    corrupt.prepare("UPDATE file_undo SET updated_at = 'nope' WHERE path = ?").run(path);
    corrupt.close();

    // The read inside the first edit heals the pair, so the write still persists.
    expect((await edit("b\n", "c\n", ["H02"])).persisted).toBe(true);
    // The second edit is what pins "permanent denial" closed: before the fix BOTH of
    // these returned `persisted: false` and no write ever cleared the corrupt row.
    expect((await edit("c\n", "d\n", ["H03"])).persisted).toBe(true);

    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const final = internal.getFileUndo(path);
    expect(final?.content).toBe("c\n");
    expect(final?.resultContent).toBe("d\n");
  });
});

it("restore puts the prior v7 row back content-identical with a fresh pair stamp", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const first = await saveUndo("/r.ts", {
      content: "one\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "two\n",
    });
    expect(first.persisted).toBe(true);
    const before = internal.getFileUndo("/r.ts");
    const second = await saveUndo("/r.ts", {
      content: "two\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H02"],
      resultContent: "three\n",
    });
    expect(second.persisted).toBe(true);
    await second.restore();
    // One-stamp rule: restore rewrites the pair now — content byte-identical,
    // stamp refreshed once for both sides (P1: no per-side clocks).
    const after = internal.getFileUndo("/r.ts");
    expect({ ...after, updatedAt: 0 }).toEqual({ ...before, updatedAt: 0 });
    expect(after?.updatedAt ?? 0).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);
    expect((await loadHashStore()).getUndo("/r.ts")).toBeDefined();
    const check = new DatabaseSync(sqlitePath(home));
    const legacyTs = (
      check.prepare("SELECT updated_at AS v FROM undo WHERE path = ?").get("/r.ts") as { v: number }
    ).v;
    const v7Ts = (
      check.prepare("SELECT updated_at AS v FROM file_undo WHERE path = ?").get("/r.ts") as {
        v: number;
      }
    ).v;
    check.close();
    expect(legacyTs).toBe(v7Ts);
  });
});

it("v7 write fault leaves the previous undo readable and reports failure", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const v1 = {
      content: "one\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "two\n",
    };
    const t0 = Date.now();
    expect((await saveUndo("/f.ts", v1)).persisted).toBe(true);
    const legacyBefore = (await loadHashStore()).getUndo("/f.ts");
    const v7Before = internal.getFileUndo("/f.ts");
    const setup = new DatabaseSync(sqlitePath(home), {
      defensive: false,
    } as any);
    setup.exec(
      "CREATE TRIGGER t2b_undo BEFORE UPDATE ON file_undo " +
        "BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );
    setup.close();
    const failed = await saveUndo("/f.ts", {
      content: "two\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H02"],
      resultContent: "three\n",
    });
    expect(failed.persisted).toBe(false);
    // Both rows atomic: the previous undo reads back byte-identical.
    expect((await loadHashStore()).getUndo("/f.ts")).toEqual(legacyBefore);
    expect(internal.getFileUndo("/f.ts")).toEqual(v7Before);
    // One stamp, reconciled: the impl stamps both rows once per write, so after a
    // failed write both must still carry the same sane stamp from the good save.
    const check = new DatabaseSync(sqlitePath(home), {
      defensive: false,
    } as any);
    const legacyTs = (
      check.prepare("SELECT updated_at AS v FROM undo WHERE path = ?").get("/f.ts") as {
        v: number;
      }
    ).v;
    const v7Ts = (
      check.prepare("SELECT updated_at AS v FROM file_undo WHERE path = ?").get("/f.ts") as {
        v: number;
      }
    ).v;
    expect(legacyTs).toBe(v7Ts);
    check.close();
    const now = Date.now();
    for (const ts of [legacyTs, v7Ts]) {
      expect(typeof ts).toBe("number");
      expect(ts).toBeGreaterThanOrEqual(t0);
      expect(ts).toBeLessThanOrEqual(now);
    }
  });
});

it("pre-v7 NULL pin reads as null and is overwritten cleanly", async () => {
  await withTempHome(async (home) => {
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const raw = new DatabaseSync(sqlitePath(home), {
      defensive: false,
    } as any);
    raw
      .prepare(
        "INSERT INTO file_undo (path, content, bom, ending, hashes, result_content, snapshot_hash, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("/n.ts", "old\n", "", "\n", JSON.stringify(["H01"]), "new\n", null, Date.now());
    raw.close();
    const row = internal.getFileUndo("/n.ts");
    expect(row?.snapshotHash).toBeNull();
    expect(row?.hashes).toEqual(["H01"]);
    const { saveUndo } = await import("../../src/undo-edit.js");
    const { snapshotHashFor } = await import("../../src/snapshot-store/lineage-store.js");
    await saveUndo("/n.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H02"],
      resultContent: "b\n",
    });
    expect(internal.getFileUndo("/n.ts")?.snapshotHash).toBe(snapshotHashFor("a\n"));
  });
});

it("corrupt legacy undo row heals both rows", async () => {
  await withTempHome(async (home) => {
    const { saveUndo, getUndo } = await import("../../src/undo-edit.js");
    await saveUndo("/h.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    expect(internal.getFileUndo("/h.ts")).toBeDefined();
    shutdownHashStore();
    const raw = new DatabaseSync(sqlitePath(home), {
      defensive: false,
    } as any);
    raw.prepare("UPDATE undo SET ending = ? WHERE path = ?").run("??", "/h.ts");
    raw.close();
    await loadHashStore();
    expect(await getUndo("/h.ts")).toBeUndefined();
    const reopened = (await loadHashStore()) as unknown as InternalHashStore;
    expect(reopened.getFileUndo("/h.ts")).toBeUndefined();
  });
});

it("pruneMissing deletes file_undo rows for missing paths", async () => {
  await withTempHome(async () => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    await saveUndo("/gone.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    await recordServed("cp3-prune", "/gone.ts", [{ position: 0, hash: "H01" }], 1);
    expect(internal.getFileUndo("/gone.ts")).toBeDefined();
    await (await loadHashStore()).pruneMissing();
    expect(internal.getFileUndo("/gone.ts")).toBeUndefined();
    expect((await loadHashStore()).getUndo("/gone.ts")).toBeUndefined();
  });
});

it("store getUndo heals both rows on bad JSON", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    await saveUndo("/s1.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const store = await loadHashStore();
    const raw = new DatabaseSync(sqlitePath(home));
    raw.prepare("UPDATE undo SET hashes = ? WHERE path = ?").run("{not json", "/s1.ts");
    raw.close();
    expect(store.getUndo("/s1.ts")).toBeUndefined();
    const internal = store as unknown as InternalHashStore;
    expect(internal.getFileUndo("/s1.ts")).toBeUndefined();
    const check = new DatabaseSync(sqlitePath(home));
    const legacy = check.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?").get("/s1.ts") as {
      n: number;
    };
    const v7 = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/s1.ts") as { n: number };
    check.close();
    expect(legacy.n).toBe(0);
    expect(v7.n).toBe(0);
  });
});

it("store getUndo heals both rows on non-hashlist", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    await saveUndo("/s2.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const store = await loadHashStore();
    const raw = new DatabaseSync(sqlitePath(home));
    raw.prepare("UPDATE undo SET hashes = ? WHERE path = ?").run('["ZZ"]', "/s2.ts");
    raw.close();
    expect(store.getUndo("/s2.ts")).toBeUndefined();
    const internal = store as unknown as InternalHashStore;
    expect(internal.getFileUndo("/s2.ts")).toBeUndefined();
    const check = new DatabaseSync(sqlitePath(home));
    const legacy = check.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?").get("/s2.ts") as {
      n: number;
    };
    const v7 = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/s2.ts") as { n: number };
    check.close();
    expect(legacy.n).toBe(0);
    expect(v7.n).toBe(0);
  });
});

it("store getFileUndo heals both rows on bad JSON", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    await saveUndo("/s3.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const store = await loadHashStore();
    const raw = new DatabaseSync(sqlitePath(home));
    raw.prepare("UPDATE file_undo SET hashes = ? WHERE path = ?").run("{not json", "/s3.ts");
    raw.close();
    const internal = store as unknown as InternalHashStore;
    expect(internal.getFileUndo("/s3.ts")).toBeUndefined();
    expect(store.getUndo("/s3.ts")).toBeUndefined();
    expect(store.getUndo("/s3.ts")).toBeUndefined();
    const check = new DatabaseSync(sqlitePath(home));
    const legacy = check.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?").get("/s3.ts") as {
      n: number;
    };
    const v7 = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/s3.ts") as { n: number };
    check.close();
    expect(legacy.n).toBe(0);
    expect(v7.n).toBe(0);
  });
});

it("store getFileUndo heals both rows on non-hashlist", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    await saveUndo("/s4.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const store = await loadHashStore();
    const raw = new DatabaseSync(sqlitePath(home));
    raw.prepare("UPDATE file_undo SET hashes = ? WHERE path = ?").run('["ZZ", "ZZZZ"]', "/s4.ts");
    raw.close();
    const internal = store as unknown as InternalHashStore;
    expect(internal.getFileUndo("/s4.ts")).toBeUndefined();
    expect(store.getUndo("/s4.ts")).toBeUndefined();
    const check = new DatabaseSync(sqlitePath(home));
    const legacy = check.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?").get("/s4.ts") as {
      n: number;
    };
    const v7 = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/s4.ts") as { n: number };
    check.close();
    expect(legacy.n).toBe(0);
    expect(v7.n).toBe(0);
  });
});

it("prune keeps the pair when any side is newer than the cutoff", async () => {
  await withTempHome(async (home) => {
    // Load first: the open-time TTL janitor must never see the forced stamps below.
    const store = await loadHashStore();
    const { saveUndo } = await import("../../src/undo-edit.js");
    await saveUndo("/split.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const raw = new DatabaseSync(sqlitePath(home));
    // Divergent stamps, no wall clock: legacy older than the cutoff, v7 newer.
    raw.prepare("UPDATE undo SET updated_at = ? WHERE path = ?").run(1, "/split.ts");
    raw.prepare("UPDATE file_undo SET updated_at = ? WHERE path = ?").run(200, "/split.ts");
    raw.close();
    store.pruneUndoOlderThan(150);
    // Newest-side rule: the young v7 row keeps the pair alive — never one side alone.
    expect(store.getUndo("/split.ts")).toBeDefined();
    const internal = store as unknown as InternalHashStore;
    expect(internal.getFileUndo("/split.ts")).toBeDefined();
  });
});

it("prune deletes the pair when both sides are older than the cutoff", async () => {
  await withTempHome(async (home) => {
    const store = await loadHashStore();
    const { saveUndo } = await import("../../src/undo-edit.js");
    await saveUndo("/old.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const raw = new DatabaseSync(sqlitePath(home));
    raw.prepare("UPDATE undo SET updated_at = ? WHERE path = ?").run(1, "/old.ts");
    raw.prepare("UPDATE file_undo SET updated_at = ? WHERE path = ?").run(1, "/old.ts");
    raw.close();
    store.pruneUndoOlderThan(150);
    expect(store.getUndo("/old.ts")).toBeUndefined();
    const internal = store as unknown as InternalHashStore;
    expect(internal.getFileUndo("/old.ts")).toBeUndefined();
    const check = new DatabaseSync(sqlitePath(home));
    const legacy = check
      .prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?")
      .get("/old.ts") as { n: number };
    const v7 = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/old.ts") as { n: number };
    check.close();
    expect(legacy.n).toBe(0);
    expect(v7.n).toBe(0);
  });
});

it("pruneMissing deletes the whole v7 lineage family for missing paths", async () => {
  await withTempHome(async (home) => {
    const store = await loadHashStore();
    const { saveUndo } = await import("../../src/undo-edit.js");
    store.commitSnapshot({
      path: "/gone-fam.ts",
      content: "a\nb\n",
      hashes: ["H01", "H02"],
      leases: {
        sessionKey: "s1",
        rows: [
          { position: 0, hash: "H01" },
          { position: 1, hash: "H02" },
        ],
      },
    });
    await saveUndo("/gone-fam.ts", {
      content: "a\nb\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01", "H02"],
      resultContent: "c\n",
    });
    await recordServed(
      "s1",
      "/gone-fam.ts",
      [
        { position: 0, hash: "H01" },
        { position: 1, hash: "H02" },
      ],
      2,
    );
    // v7-only path: lineage family and nothing else — the discovery union must find it.
    store.commitSnapshot({
      path: "/gone-pure.ts",
      content: "p\n",
      hashes: ["P01"],
      leases: { sessionKey: "s1", rows: [{ position: 0, hash: "P01" }] },
    });
    // Existing path keeps every row (no over-delete).
    const keep = join(home, "keep-fam.ts");
    await writeFile(keep, "x\ny\n", "utf-8");
    store.commitSnapshot({
      path: keep,
      content: "x\ny\n",
      hashes: ["K01", "K02"],
      leases: { sessionKey: "s1", rows: [{ position: 0, hash: "K01" }] },
    });
    await saveUndo(keep, {
      content: "x\ny\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["K01", "K02"],
      resultContent: "z\n",
    });
    await store.pruneMissing();
    const check = new DatabaseSync(sqlitePath(home));
    const count = (sql: string, p: string) => (check.prepare(sql).get(p) as { n: number }).n;
    const lineageRows = (p: string) =>
      count(
        "SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id IN (SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
        p,
      );
    for (const gone of ["/gone-fam.ts", "/gone-pure.ts"]) {
      expect(count("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?", gone)).toBe(0);
      expect(lineageRows(gone)).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM line_id_counters WHERE path = ?", gone)).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ?", gone)).toBe(0);
    }
    expect(count("SELECT COUNT(*) AS n FROM undo WHERE path = ?", "/gone-fam.ts")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?", "/gone-fam.ts")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?", keep)).toBe(1);
    expect(lineageRows(keep)).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM line_id_counters WHERE path = ?", keep)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ?", keep)).toBe(1);
    expect(store.getUndo(keep)).toBeDefined();
    // A wipe-all-file_undo regression would still pass the line above — pin the v7 side too.
    expect((store as unknown as InternalHashStore).getFileUndo(keep)).toBeDefined();
    check.close();
  });
});

it("legacy write fault leaves the previous undo readable and reports failure", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const v1 = {
      content: "one\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "two\n",
    };
    expect((await saveUndo("/g.ts", v1)).persisted).toBe(true);
    const legacyBefore = (await loadHashStore()).getUndo("/g.ts");
    const v7Before = internal.getFileUndo("/g.ts");
    const setup = new DatabaseSync(sqlitePath(home), {
      defensive: false,
    } as any);
    setup.exec(
      "CREATE TRIGGER t2b_undo_legacy BEFORE UPDATE ON undo " +
        "BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );
    setup.close();
    const failed = await saveUndo("/g.ts", {
      content: "two\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H02"],
      resultContent: "three\n",
    });
    expect(failed.persisted).toBe(false);
    // Rollback proven in the legacy direction: both rows read back byte-identical.
    expect((await loadHashStore()).getUndo("/g.ts")).toEqual(legacyBefore);
    expect(internal.getFileUndo("/g.ts")).toEqual(v7Before);
  });
});

it("pruneMissing rolls back every table when a later delete faults", async () => {
  await withTempHome(async (home) => {
    const store = await loadHashStore();
    const { saveUndo } = await import("../../src/undo-edit.js");
    // Missing path with a full family; `served` is last in the prune order, and
    // legacy `snapshots` is the FIRST family — both sides of the sweep are covered.
    store.upsertSnapshot("/gone-rb.ts", contentChecksum("a\n"), 1, ["H01"]);
    store.commitSnapshot({
      path: "/gone-rb.ts",
      content: "a\n",
      hashes: ["H01"],
      leases: { sessionKey: "s1", rows: [{ position: 0, hash: "H01" }] },
    });
    await saveUndo("/gone-rb.ts", {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    await recordServed("s1", "/gone-rb.ts", [{ position: 0, hash: "H01" }], 1);
    // Fault the LAST delete: the abort must roll back every earlier delete in the unit.
    const setup = new DatabaseSync(sqlitePath(home), {
      defensive: false,
    } as any);
    setup.exec(
      "CREATE TRIGGER t3a_served_fault BEFORE DELETE ON served " +
        "BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );
    setup.close();
    await expect(store.pruneMissing()).rejects.toThrow("injected");
    const check = new DatabaseSync(sqlitePath(home));
    const count = (sql: string, p: string) => (check.prepare(sql).get(p) as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM snapshots WHERE path = ?", "/gone-rb.ts")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?", "/gone-rb.ts")).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id IN (SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
        "/gone-rb.ts",
      ),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM line_id_counters WHERE path = ?", "/gone-rb.ts")).toBe(
      1,
    );
    expect(
      count("SELECT COUNT(*) AS n FROM served_leases WHERE file_path = ?", "/gone-rb.ts"),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM served WHERE path = ?", "/gone-rb.ts")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM undo WHERE path = ?", "/gone-rb.ts")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?", "/gone-rb.ts")).toBe(1);
    check.close();
  });
});

it("reopen janitor prunes both undo sides when the TTL elapsed", async () => {
  await withTempHome(async (home) => {
    await mkdir(configHome(home), { recursive: true });
    await writeFile(
      join(configHome(home), "config.yaml"),
      "storeDir: central\nundo_ttl_s: 3600\n",
      "utf-8",
    );
    // Real file: the reopen also runs pruneMissing — a missing path would vanish regardless of TTL.
    const oldPath = join(home, "j-old.ts");
    await writeFile(oldPath, "a\n", "utf-8");
    const { saveUndo } = await import("../../src/undo-edit.js");
    await saveUndo(oldPath, {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const raw = new DatabaseSync(sqlitePath(home));
    raw.prepare("UPDATE undo SET updated_at = ? WHERE path = ?").run(1000, oldPath);
    raw.prepare("UPDATE file_undo SET updated_at = ? WHERE path = ?").run(1000, oldPath);
    raw.close();
    shutdownHashStore();
    // cutoff = now - 3600s: stamp 1000 is older by an hour margin, no wall-clock dependence.
    const store = await loadHashStore();
    expect(store.getUndo(oldPath)).toBeUndefined();
    const check = new DatabaseSync(sqlitePath(home));
    const legacy = check.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?").get(oldPath) as {
      n: number;
    };
    const v7 = check.prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?").get(oldPath) as {
      n: number;
    };
    check.close();
    expect(legacy.n).toBe(0);
    expect(v7.n).toBe(0);
  });
});

it("reopen janitor keeps the pair when the v7 side is newer than the TTL", async () => {
  await withTempHome(async (home) => {
    await mkdir(configHome(home), { recursive: true });
    await writeFile(
      join(configHome(home), "config.yaml"),
      "storeDir: central\nundo_ttl_s: 3600\n",
      "utf-8",
    );
    const splitPath = join(home, "j-split.ts");
    await writeFile(splitPath, "a\n", "utf-8");
    const { saveUndo } = await import("../../src/undo-edit.js");
    await saveUndo(splitPath, {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const raw = new DatabaseSync(sqlitePath(home));
    raw.prepare("UPDATE undo SET updated_at = ? WHERE path = ?").run(1000, splitPath);
    // Young side stamped explicitly: newer than the cutoff by an hour margin, and the
    // exact value the row contract below is asserted against.
    const youngStamp = Date.now();
    raw.prepare("UPDATE file_undo SET updated_at = ? WHERE path = ?").run(youngStamp, splitPath);
    raw.close();
    // Force the reopen: the janitor (and its newest-side TTL rule) runs on open.
    shutdownHashStore();
    const store = await loadHashStore();
    // Newest-side rule at open: the young v7 row keeps the legacy row alive.
    expect(store.getUndo(splitPath)).toBeDefined();
    // Row contract, field by field, with concrete expected values — no COUNT and no regex
    // on a hash prefix. `getFileUndo` is on the public HashStore face, so proving the
    // mapper needs no cast: every declared field is compared to its column's value.
    const { snapshotHashFor } = await import("../../src/snapshot-store/lineage-store.js");
    expect(store.getFileUndo(splitPath)).toEqual({
      content: "a\n",
      bom: "",
      ending: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
      snapshotHash: snapshotHashFor("a\n"),
      updatedAt: youngStamp,
    });
  });
});

it("writeUndoPair rejects both-absent with a TypeError and writes no rows", async () => {
  await withTempHome(async () => {
    const store = await loadHashStore();
    const { saveUndo } = await import("../../src/undo-edit.js");
    const path = "/both-absent.ts";
    // Seed a real pair so "writes nothing" is observable as a row contract.
    await saveUndo(path, {
      content: "a\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "b\n",
    });
    const beforeUndo = store.getUndo(path);
    const beforeV7 = store.getFileUndo(path);
    expect(beforeUndo).toBeDefined();
    expect(beforeV7).toBeDefined();

    // Typed error, not a bare Error: this face already uses TypeError for contract
    // violations (the anchor-reservation and canons guards).
    expect(() => store.writeUndoPair(path, undefined, undefined)).toThrow(TypeError);
    expect(() => store.writeUndoPair(path, undefined, undefined)).toThrow(
      "writeUndoPair requires at least one side; use deleteUndoPair to clear the pair",
    );

    // Row contract, not a COUNT: both sides are byte-identical to the seeded pair...
    expect(store.getUndo(path)).toEqual(beforeUndo);
    expect(store.getFileUndo(path)).toEqual(beforeV7);
    // ...and a never-written path stays absent, so the guard ran before any write.
    expect(store.getUndo("/never-written.ts")).toBeUndefined();
    expect(store.getFileUndo("/never-written.ts")).toBeUndefined();
  });
});

it("deleteByPath removes only the lineage family and leaves the other families intact", async () => {
  await withTempHome(async (home) => {
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const { saveUndo } = await import("../../src/undo-edit.js");
    const { snapshotHashFor } = await import("../../src/snapshot-store/lineage-store.js");
    const path = "/narrow.ts";
    const content = "alpha\nbeta\n";
    const hashes = ["AAA", "AAB"];

    internal.upsertSnapshot(path, contentChecksum(content), 2, hashes);
    internal.commitSnapshot({ path, content, hashes });
    await saveUndo(path, {
      content: "old\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "new\n",
    });
    await recordServed("narrow-session", path, [{ position: 0, hash: "AAA" }], 2);

    const beforeUndo = internal.getUndo(path);
    const beforeV7 = internal.getFileUndo(path);
    expect(internal.lineageFor(path, snapshotHashFor(content))).toHaveLength(2);
    expect(beforeUndo).toBeDefined();
    expect(beforeV7).toBeDefined();

    // The face member is the LineageStore seam, LINEAGE FAMILY ONLY — it is not
    // "delete everything for this path"; pruneMissing owns whole-path deletion.
    internal.deleteByPath(path);

    // Lineage family: gone.
    expect(internal.lineageFor(path, snapshotHashFor(content))).toEqual([]);
    // Every other family: byte-identical records.
    expect(internal.getUndo(path)).toEqual(beforeUndo);
    expect(internal.getFileUndo(path)).toEqual(beforeV7);
    expect(await loadServed("narrow-session", path)).toEqual(["AAA"]);
    // The legacy snapshot row survives, so getSnapshot falls back to it.
    expect(internal.getSnapshot(path, content)).toEqual(hashes);
  });
});

it("getSnapshot falls back to valid legacy anchors when the lineage family is corrupt", async () => {
  await withTempHome(async (home) => {
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const path = "/fallback.ts";
    const content = "alpha\nbeta\n";
    const hashes = ["AAA", "AAB"];
    internal.upsertSnapshot(path, contentChecksum(content), 2, hashes);
    internal.commitSnapshot({ path, content, hashes });

    // Corrupt the lineage family: right row count, non-sequential line_number.
    const db = new DatabaseSync(sqlitePath(home));
    db.prepare(
      "UPDATE line_lineage SET line_number = 99 WHERE line_number = 1 AND snapshot_id IN " +
        "(SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
    ).run(path);
    db.close();
    shutdownHashStore();

    const reopened = await loadHashStore();
    // The shape guard rejects the corrupt lineage and falls through to snapshotStore.get,
    // which returns the valid legacy anchors. No throw.
    expect(reopened.getSnapshot(path, content)).toEqual(hashes);
  });
});
