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
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";
import { DomainError } from "../../src/domain-errors.js";
import { HASH_STORE_VERSION } from "../../src/constants.js";
import { initHasher, contentChecksum } from "../../src/hashline/hash-assign.js";
import { splitLines } from "../../src/utils.js";
import type { UndoEntry } from "../../src/undo-edit.js";
import { getWritableTempRoot } from "../support/fixtures.js";

/**
 * Per-table COUNT statements for the schema sweeps in this file. A table name is a SQL IDENTIFIER
 * (SQLite has no bind parameter for one), so every statement is a complete literal in this
 * allowlist and the callers select by key — no variable is ever interpolated into SQL.
 */
const COUNT_SQL = {
  snapshots: "SELECT COUNT(*) AS n FROM snapshots",
  undo: "SELECT COUNT(*) AS n FROM undo",
  served: "SELECT COUNT(*) AS n FROM served",
  file_undo: "SELECT COUNT(*) AS n FROM file_undo",
  file_snapshots: "SELECT COUNT(*) AS n FROM file_snapshots",
  line_lineage: "SELECT COUNT(*) AS n FROM line_lineage",
  line_id_counters: "SELECT COUNT(*) AS n FROM line_id_counters",
  served_leases: "SELECT COUNT(*) AS n FROM served_leases",
  served_session_meta: "SELECT COUNT(*) AS n FROM served_session_meta",
} as const;

type CountTable = keyof typeof COUNT_SQL;

/**
 * The released v6 `undo` column list. An open backfills the additive #171/#191 pair onto the
 * shell, so a "byte-identical v6 row" claim is made on exactly these columns.
 */
const V6_UNDO_SELECT = "SELECT path, content, bom, ending, hashes, result_content, updated_at";

/** The two undo-side tables that carry a `path` column. */
const COUNT_BY_PATH_SQL = {
  undo: COUNT_SQL.undo + " WHERE path = ?",
  file_undo: COUNT_SQL.file_undo + " WHERE path = ?",
} as const;

type CountByPathTable = keyof typeof COUNT_BY_PATH_SQL;

function countRows(db: DatabaseSync, table: CountTable): number {
  return (db.prepare(COUNT_SQL[table]).get() as { n: number }).n;
}

function countRowsByPath(db: DatabaseSync, table: CountByPathTable, path: string): number {
  return ((db.prepare(COUNT_BY_PATH_SQL[table]).get(path) as { n: number } | undefined)?.n ??
    0) as number;
}
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

async function put(
  store: HashStore,
  path: string,
  content: string,
  hashes: string[],
): Promise<void> {
  store.upsertSnapshot(path, contentChecksum(content), splitLines(content).length, hashes, content);
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

describe("hash-store — concurrency (issue #10)", () => {
  it("preserves snapshots written by a separately-opened connection", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/a.ts", "alpha\n", ["AAB"]);

      const second = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const ins = second.prepare(
        "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) VALUES (?, ?, ?, ?, 1)",
      );
      const insLine = second.prepare(
        "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?, 1, 1, 'ck', ?)",
      );
      second.exec("BEGIN IMMEDIATE");
      const inserted = ins.run(
        "/b.ts",
        snapshotHashFor("beta\n"),
        splitLines("beta\n").length,
        Date.now(),
      ) as { lastInsertRowid: number | bigint };
      insLine.run(Number(inserted.lastInsertRowid), "BBC");
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
      const bigHashes = splitLines(bigContent).map((_, i) => i.toString(16).padStart(3, "0"));
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

      store.upsertSnapshot("/x.ts", contentChecksum("a\n"), 1, ["AAA"], "a\n");
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
      store.upsertSnapshot("/p.ts", contentChecksum("b\n"), 1, ["BBB"], "b\n");
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
      // Parameterized: `pragma_table_info` is a table-valued function, so the table is a VALUE.
      const columns = (table: string): string[] =>
        (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map(
          (column) => column.name,
        );
      expect(columns("snapshots")).toEqual([
        "path",
        "checksum",
        "line_count",
        "hashes",
        "updated_at",
      ]);
      // #171: `undo` gained the effective-ending pair; the shell is still complete (every column
      // the released v6 build prepares against is here, plus the additive pair).
      // #191: `undo` gained the verdict pair beside it; same completeness contract.
      expect(columns("undo")).toEqual([
        "path",
        "content",
        "bom",
        "ending",
        "hashes",
        "result_content",
        "effective_ending",
        "pre_image_mixed",
        "migrated_from",
        "migrated_from_bom",
        "updated_at",
      ]);
      expect(columns("served")).toEqual([
        "session_id",
        "path",
        "hashes",
        "reported",
        "retired",
        "canons",
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
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const now = Date.now();
      // v6 write shapes — all three shells still prepare and run on a v9 store.
      db.prepare(
        "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, " +
          "hashes = excluded.hashes, updated_at = excluded.updated_at",
      ).run("/v.ts", "ck", 2, JSON.stringify(["AAA", "BBB"]), now);
      db.prepare(
        "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, " +
          "hashes = excluded.hashes, result_content = excluded.result_content, updated_at = excluded.updated_at",
      ).run("/v2.ts", "c", "", "\n", JSON.stringify(["DDD"]), "r", now);
      db.prepare(
        "INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(session_id, path) DO UPDATE SET hashes = excluded.hashes, updated_at = excluded.updated_at",
      ).run("sessionB", "/v.ts", JSON.stringify(["CCC"]), now);

      // v6 read shapes.
      const vSnap = db
        .prepare("SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?")
        .get("/v.ts", "ck", 2) as { hashes: string };
      expect(JSON.parse(vSnap.hashes)).toEqual(["AAA", "BBB"]);
      const vUndo = db.prepare("SELECT hashes FROM undo WHERE path = ?").get("/v2.ts") as {
        hashes: string;
      };
      expect(JSON.parse(vUndo.hashes)).toEqual(["DDD"]);
      const vServed = db
        .prepare(
          "SELECT hashes, reported, retired, canons, cards FROM served WHERE session_id = ? AND path = ?",
        )
        .get("sessionB", "/v.ts") as {
        hashes: string;
        reported: null;
        retired: null;
        canons: null;
        cards: null;
      };
      expect(JSON.parse(vServed.hashes)).toEqual(["CCC"]);
      expect(vServed).toMatchObject({
        reported: null,
        retired: null,
        canons: null,
        cards: null,
      });

      // v6 delete shapes.
      db.prepare("DELETE FROM snapshots WHERE path = ?").run("/v.ts");
      db.prepare("DELETE FROM undo WHERE path = ?").run("/v2.ts");
      db.prepare("DELETE FROM served WHERE session_id = ?").run("sessionB");
      db.prepare("DELETE FROM served WHERE path = ?").run("/v.ts");
      expect((db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM undo").get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM served").get() as { n: number }).n).toBe(0);
      db.close();

      // The replay wrote only shells: v7 readers stay on their own families.
      const reopened = await loadHashStore();
      expect(reopened.getSnapshot("/p.ts", "x\n")).toEqual(["XYZ"]);
      expect(reopened.getUndo("/v2.ts")).toBeUndefined();
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
          undo: db.prepare(`${V6_UNDO_SELECT} FROM undo ORDER BY path`).all(),
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
        undo: fixture.prepare(`${V6_UNDO_SELECT} FROM undo ORDER BY path`).all(),
        served: fixture.prepare("SELECT * FROM served ORDER BY session_id, path").all(),
      };
      fixture.close();

      await loadHashStore();
      shutdownHashStore();

      // ADR-0016's shell-retention contract: the open-time sweep reclaims only v7-owned state, so
      // the v6 shells come through a v9 migration byte-identical. That is what makes a version flap
      // survivable for an un-restarted v6 session.
      expect(before.snapshots.length).toBeGreaterThan(0);
      expect(readAll()).toEqual(before);

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

      // ...and after a full v6 write/read/delete cycle the shells are back to the same baseline:
      // the v6 writer's own key shapes still round-trip through their own statements.
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
        undo: fixture.prepare(`${V6_UNDO_SELECT} FROM undo ORDER BY path`).all(),
        served: fixture.prepare("SELECT * FROM served ORDER BY session_id, path").all(),
      };
      fixture.close();

      await loadHashStore();
      shutdownHashStore();

      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      // ADR-0016: the upgrade preserves the v6 shells byte-identically (the sweep reclaims only
      // v7-owned state). This test guards the SHELL (the columns and the v7 tables below).
      expect(before.snapshots.length).toBeGreaterThan(0);
      expect(check.prepare("SELECT * FROM snapshots ORDER BY path").all()).toEqual(
        before.snapshots,
      );
      expect(check.prepare(`${V6_UNDO_SELECT} FROM undo ORDER BY path`).all()).toEqual(before.undo);
      expect(check.prepare("SELECT * FROM served ORDER BY session_id, path").all()).toEqual(
        before.served,
      );
      // No anchor stamp was ever written, so the open-time sweep reclaims the copied served family
      // too: every v7 table starts empty on this store.
      for (const table of [
        "file_snapshots",
        "line_id_counters",
        "line_lineage",
        "file_undo",
        "served_leases",
        "served_session_meta",
      ]) {
        expect(countRows(check, table as CountTable)).toBe(0);
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
      expect(version?.value).toBe(String(HASH_STORE_VERSION));
    });
  });

  it("accepts the current stamp without a migration write and refuses the next one", async () => {
    await withTempHome(async (home) => {
      const CURRENT = HASH_STORE_VERSION;
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
      stampDb.prepare("UPDATE meta SET value = ? WHERE key = 'version'").run(String(CURRENT + 1));
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
      expect(version?.value).toBe(String(CURRENT + 1));
      // The refusal wrote nothing: each family still holds exactly the state the test seeded
      // (a lineage snapshot, a legacy-only shell undo row the v6 client wrote, and a live meta row).
      expect(countRows(check, "file_snapshots")).toBe(1);
      expect(countRows(check, "undo")).toBe(1);
      expect(countRows(check, "served_session_meta")).toBe(1);
      expect(countRows(check, "snapshots")).toBe(0);
      expect(countRows(check, "served")).toBe(0);
      check.close();

      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
    });
  });

  it("survives a v6 downgrade: v6 rows intact, live v7 rows kept, shell served copied", async () => {
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
      const rowsOf = (table: "snapshots" | "undo" | "served"): unknown[] => {
        const db = rawConn();
        // Literal allowlist above: no caller data reaches this SQL.
        const rows = db.prepare(`SELECT * FROM ${table}`).all();
        db.close();
        return rows;
      };

      const stampDb = rawConn();
      // A v6 process re-stamps the store and writes its own shell rows (it never names v7 tables).
      stampDb.prepare("UPDATE meta SET value = '6' WHERE key = 'version'").run();
      stampDb
        .prepare("INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?, ?, ?, ?)")
        .run("v6-session", "/v6.ts", JSON.stringify(["V6A"]), Date.now());
      stampDb.close();

      const beforeSnapshots = rowsOf("snapshots");
      const beforeUndo = rowsOf("undo");
      const beforeServed = rowsOf("served");

      await loadHashStore();
      shutdownHashStore();

      const check = rawConn();
      // The v6 shells are untouched — the v6 client's own rows come through byte-identical.
      expect(check.prepare("SELECT * FROM snapshots ORDER BY path").all()).toEqual(beforeSnapshots);
      expect(check.prepare("SELECT * FROM undo ORDER BY path").all()).toEqual(beforeUndo);
      expect(check.prepare("SELECT * FROM served ORDER BY session_id, path").all()).toEqual(
        beforeServed,
      );
      // Live v7 rows survive the downgrade bump; the re-migration copies the shell's new key.
      expect(countRows(check, "file_snapshots")).toBe(1);
      expect(countRows(check, "served_session_meta")).toBe(2);
      expect(countRows(check, "file_undo")).toBe(0);
      const version = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      check.close();
      expect(version?.value).toBe(String(HASH_STORE_VERSION));
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
      expect(String((failure as Error).message)).toContain("[TO MODEL] [E_STORE_NEWER_VERSION]");
      await expect(loadHashStore()).rejects.toThrow("[TO MODEL] [E_STORE_NEWER_VERSION]");

      const after = await readFile(sqlitePath(home));
      expect(after.equals(before)).toBe(true);

      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const version = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      expect(version?.value).toBe("999");
      // Every seeded row is still where its OWNER put it: lineage for the snapshot, the legacy
      // shell undo row from the v6 client, and the live served mirror on the meta table.
      expect(countRows(check, "file_snapshots")).toBe(1);
      expect(countRows(check, "undo")).toBe(1);
      expect(countRows(check, "served_session_meta")).toBe(1);
      const metaRow = check
        .prepare("SELECT hashes FROM served_session_meta WHERE session_id = ? AND file_path = ?")
        .get("sessionA", "/p.ts") as { hashes: string };
      expect(JSON.parse(metaRow.hashes)).toEqual(["XYZ"]);
      check.close();

      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
    });
  });

  it("migrates an older store forward and preserves every row family", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      const { saveUndo } = await import("../../src/undo-edit.js");
      await saveUndo("/u.ts", {
        content: "old",
        bom: "",
        originalEnding: "\n",
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
      const { saveUndo } = await import("../../src/undo-edit.js");
      await saveUndo("/u.ts", {
        content: "old",
        bom: "",
        originalEnding: "\n",
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
      const count = (table: CountTable): number => {
        const db = raw();
        const n = countRows(db, table);
        db.close();
        return n;
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
          snapshots: current.latestLineageFor("/p.ts")?.length ?? 0,
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
      // The blocked migration wrote nothing: the lineage/meta rows are where the v7 writer left
      // them, and the legacy shells are untouched (they never held this store's live state).
      expect(count("file_snapshots")).toBe(1);
      expect(count("file_undo")).toBe(1);
      expect(count("snapshots")).toBe(0);
      expect(count("undo")).toBe(0);
      const blockedServed = raw();
      const blockedRow = blockedServed
        .prepare("SELECT hashes FROM served_session_meta WHERE session_id = ? AND file_path = ?")
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
      const beforeUndo = fixture.prepare(`${V6_UNDO_SELECT} FROM undo ORDER BY path`).all();
      fixture.close();

      await loadHashStore();
      const served = await loadServedStore();
      served.upsertServed("sessionB", "/q.ts", JSON.stringify(["AAA"]));
      expect(served.getServed("sessionB", "/q.ts")).toEqual(["AAA"]);
      // #138: the pre-generation `served` row is reclaimed by the open — it carries anchors and
      // canons but no key, so the stamp decides for the whole family.
      expect(served.getServed("sessionA", "/p.ts")).toEqual([]);
      shutdownHashStore();

      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const cols = (check.prepare("PRAGMA table_info(served)").all() as { name: string }[]).map(
        (column) => column.name,
      );
      expect(cols).toContain("retired");
      // ADR-0016: the column backfill is non-destructive AND the shells are untouched — the v6
      // rows come through the upgrade byte-identically.
      expect(beforeSnapshots.length).toBeGreaterThan(0);
      expect(beforeUndo.length).toBeGreaterThan(0);
      expect(check.prepare("SELECT * FROM snapshots ORDER BY path").all()).toEqual(beforeSnapshots);
      expect(check.prepare(`${V6_UNDO_SELECT} FROM undo ORDER BY path`).all()).toEqual(beforeUndo);
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
        // One row for a one-line file: the whole file served.
        fullRead: true,
      });
      expect(internal.getSnapshot("/d2.ts", "x\n")).toEqual(["XYZ"]);
      const lease = internal.leaseFor("cp3-sess2", "/d2.ts", "XYZ");
      expect(lease).toBeDefined();
      expect(lease?.lineId).toBe(1);
      expect(lease?.lineNumber).toBe(1);
    });
  });

  it("(e) the v7 snapshot key names the current epoch and has no legacy mirror", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      store.upsertSnapshot("/e.ts", contentChecksum("x\n"), 1, ["XYZ"], "x\n");
      expect(store.getSnapshot("/e.ts", "x\n")).toEqual(["XYZ"]);
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
      expect(snapHash).toBe(snapshotHashFor("x\n"));
      // The v6 shell is not a mirror: v7 never writes it, so there is no fallback to disagree with.
      expect(countRows(keyed, "snapshots")).toBe(0);
      keyed.close();
      shutdownHashStore();
      // Remove the whole v7 family out of band: the read is a miss. No legacy row resurrects it.
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
      expect(reopened.getSnapshot("/e.ts", "x\n")).toBeUndefined();
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

  it("partially-corrupt lineage repairs instead of serving a stale mix", async () => {
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

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      reopened.commitSnapshot({ path: "/c.ts", content, hashes: ["AAa", "AAb"] });
      const warned = warn.mock.calls.map((call) => String(call[0])).join(" ");
      warn.mockRestore();

      // Read half: the partial family is replaced, never served as a truncated mix — the
      // snapshot now resolves to exactly one row per line, with the anchors just adopted.
      expect({
        snapshot: reopened.getSnapshot("/c.ts", content),
        warned: /stored lineage has 1 rows for 2 lines/.test(warned),
      }).toEqual({ snapshot: ["AAa", "AAb"], warned: true });
    });
  });

  it("#5 a lineage fault rolls back the whole v7 family (there is no legacy row to pair with)", async () => {
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
      // Pair contract: the whole v7 family is one unit — neither row may survive the fault, and
      // the v6 shell was never a side of it.
      const pairCheck = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
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
      { hashes, content, fullRead: true },
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

it("adopt on an orphan snapshot row repairs it; the serve path grants leases again", async () => {
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

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Serve path: the repair is what stops the read → edit → reject loop — the read
    // persists its leases instead of rolling the served row back forever.
    await recordServed(
      "cp3-orphan",
      "/o.ts",
      [
        { position: 0, hash: "AAa" },
        { position: 1, hash: "AAb" },
      ],
      2,
      { hashes, content, fullRead: true },
    );
    const warned = warn.mock.calls.map((call) => String(call[0])).join(" ");
    warn.mockRestore();

    const reopened = (await loadHashStore()) as unknown as InternalHashStore;
    expect({
      // Pair #6 still holds: the lease grant and the `served` row it derives from commit
      // together. The repair removes the failure that used to roll both back.
      served: reopened.getServed("cp3-orphan", "/o.ts"),
      lease: reopened.leaseFor("cp3-orphan", "/o.ts", "AAa") !== undefined,
      lineage: reopened.lineageFor("/o.ts", snapshotHashFor(content)).length,
      warned: /repairing corrupt lineage/.test(warned) && /no lineage/.test(warned),
    }).toEqual({ served: ["AAa", "AAb"], lease: true, lineage: 2, warned: true });
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
    const entry: UndoEntry = {
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
    const count = (table: CountByPathTable) => countRowsByPath(check, table, "/shape-corrupt.ts");
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

it("getFileUndo propagates infrastructure failures instead of healing the pair away", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    const path = "/busy-undone.ts";

    // Fault injection with no production seam: wrap `prepare` and give ONLY the
    // `file_undo` SELECT a throwing `get`. A blanket `StatementSync.prototype.get` spy
    // would not discriminate — `saveUndo` reads the legacy pair first (`readUndo` before
    // `readFileUndo`), so it would fail before ever reaching `getFileUndo`.
    const realPrepare = DatabaseSync.prototype.prepare;
    // Anchored to the exact `fileUndoGetStmt` SELECT (`src/hash-store.ts:577`), not the
    // `FROM file_undo WHERE path = ?` substring — that also matches the DELETE at `:579` and the
    // test-local COUNT/updated_at queries, so a future `.run` fault-injection would silently
    // break the delete. A column-list change stops this matching and fails the test on `threw`:
    // loud, not silently inert. (#171 added the effective-ending pair to the list and #191 the
    // verdict pair; the canary did its job twice and is re-anchored here.)
    const fileUndoGetSql =
      /^SELECT content, bom, ending, hashes, result_content, snapshot_hash, updated_at, effective_ending, pre_image_mixed, migrated_from, migrated_from_bom FROM file_undo WHERE path = \?$/;
    let failFileUndoGet = false;
    const busy = () => Object.assign(new Error("database is locked"), { errcode: 5 });
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const stmt = realPrepare.call(this, sql);
      if (fileUndoGetSql.test(sql)) {
        const realGet = stmt.get.bind(stmt);
        stmt.get = ((...args: Parameters<typeof realGet>) => {
          if (failFileUndoGet) throw busy();
          return realGet(...args);
        }) as typeof stmt.get;
      }
      return stmt;
    });

    try {
      expect(
        (
          await saveUndo(path, {
            content: "a\n",
            bom: "",
            originalEnding: "\n",
            hashes: ["H01"],
            resultContent: "b\n",
          })
        ).persisted,
      ).toBe(true);
      const internal = (await loadHashStore()) as unknown as InternalHashStore;
      expect(internal.getFileUndo(path)).toBeDefined();

      // Collect all three consequences into ONE assertion so a regression reports every
      // symptom at once instead of aborting on the first.
      failFileUndoGet = true;
      let threw = false;
      let value: unknown;
      try {
        value = internal.getFileUndo(path);
      } catch {
        threw = true;
      }

      // The heal must NOT have run — a live row is still on disk. A blanket catch would
      // have deleted it here.
      failFileUndoGet = false;
      const check = new DatabaseSync(sqlitePath(home));
      const pair = { fileUndo: countRowsByPath(check, "file_undo", path) };
      check.close();

      // Through the real route the edit aborts rather than reporting a write whose prior
      // state it could not durably determine.
      failFileUndoGet = true;
      const after = (
        await saveUndo(path, {
          content: "b\n",
          bom: "",
          originalEnding: "\n",
          hashes: ["H02"],
          resultContent: "c\n",
        })
      ).persisted;

      expect({ threw, value, pair, after }).toEqual({
        threw: true,
        value: undefined,
        pair: { fileUndo: 1 },
        after: false,
      });
    } finally {
      failFileUndoGet = false;
      prepareSpy.mockRestore();
    }
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
    // One-stamp rule: restore rewrites the row now — content byte-identical,
    // stamp refreshed once (the store owns the clock).
    const after = internal.getFileUndo("/r.ts");
    expect({ ...after, updatedAt: 0 }).toEqual({ ...before, updatedAt: 0 });
    expect(after?.updatedAt ?? 0).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);
    expect((await loadHashStore()).getUndo("/r.ts")).toBeDefined();
    const check = new DatabaseSync(sqlitePath(home));
    const v7Ts = (
      check.prepare("SELECT updated_at AS v FROM file_undo WHERE path = ?").get("/r.ts") as {
        v: number;
      }
    ).v;
    check.close();
    expect(after?.updatedAt).toBe(v7Ts);
  });
});

it("v7 write fault leaves the previous undo readable and reports failure", async () => {
  await withTempHome(async (home) => {
    const { saveUndo } = await import("../../src/undo-edit.js");
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const v1: UndoEntry = {
      content: "one\n",
      bom: "",
      originalEnding: "\n",
      hashes: ["H01"],
      resultContent: "two\n",
    };
    const t0 = Date.now();
    expect((await saveUndo("/f.ts", v1)).persisted).toBe(true);
    const before = internal.getFileUndo("/f.ts");
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
    // One row, atomic: the previous undo reads back byte-identical.
    expect((await loadHashStore()).getUndo("/f.ts")).toBeDefined();
    expect(internal.getFileUndo("/f.ts")).toEqual(before);
    const check = new DatabaseSync(sqlitePath(home), {
      defensive: false,
    } as any);
    const v7Ts = (
      check.prepare("SELECT updated_at AS v FROM file_undo WHERE path = ?").get("/f.ts") as {
        v: number;
      }
    ).v;
    check.close();
    const now = Date.now();
    expect(typeof v7Ts).toBe("number");
    expect(v7Ts).toBeGreaterThanOrEqual(t0);
    expect(v7Ts).toBeLessThanOrEqual(now);
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

it("a corrupt undo row heals (one row, one contract)", async () => {
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
    raw.prepare("UPDATE file_undo SET ending = ? WHERE path = ?").run("??", "/h.ts");
    raw.close();
    await loadHashStore();
    expect(await getUndo("/h.ts")).toBeUndefined();
    const reopened = (await loadHashStore()) as unknown as InternalHashStore;
    expect(reopened.getFileUndo("/h.ts")).toBeUndefined();
    expect(reopened.getUndo("/h.ts")).toBeUndefined();
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
    raw.prepare("UPDATE file_undo SET hashes = ? WHERE path = ?").run("{not json", "/s1.ts");
    raw.close();
    expect(store.getUndo("/s1.ts")).toBeUndefined();
    const internal = store as unknown as InternalHashStore;
    expect(internal.getFileUndo("/s1.ts")).toBeUndefined();
    const check = new DatabaseSync(sqlitePath(home));
    const v7 = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/s1.ts") as { n: number };
    check.close();
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
    raw.prepare("UPDATE file_undo SET hashes = ? WHERE path = ?").run('["ZZ"]', "/s2.ts");
    raw.close();
    expect(store.getUndo("/s2.ts")).toBeUndefined();
    const internal = store as unknown as InternalHashStore;
    expect(internal.getFileUndo("/s2.ts")).toBeUndefined();
    const check = new DatabaseSync(sqlitePath(home));
    const v7 = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/s2.ts") as { n: number };
    check.close();
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
    const check = new DatabaseSync(sqlitePath(home));
    const v7 = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/s3.ts") as { n: number };
    check.close();
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
    const v7 = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/s4.ts") as { n: number };
    check.close();
    expect(v7.n).toBe(0);
  });
});

it("prune keeps the undo row when its stamp is newer than the cutoff", async () => {
  await withTempHome(async (home) => {
    // Load first: the open-time TTL janitor must never see the forced stamp below.
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
    // Forced stamp, no wall clock: newer than the cutoff.
    raw.prepare("UPDATE file_undo SET updated_at = ? WHERE path = ?").run(200, "/split.ts");
    raw.close();
    store.pruneUndoOlderThan(150);
    expect(store.getUndo("/split.ts")).toBeDefined();
    const internal = store as unknown as InternalHashStore;
    expect(internal.getFileUndo("/split.ts")).toBeDefined();
  });
});

it("prune deletes the undo row when its stamp is older than the cutoff", async () => {
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
    raw.prepare("UPDATE file_undo SET updated_at = ? WHERE path = ?").run(1, "/old.ts");
    raw.close();
    store.pruneUndoOlderThan(150);
    expect(store.getUndo("/old.ts")).toBeUndefined();
    const internal = store as unknown as InternalHashStore;
    expect(internal.getFileUndo("/old.ts")).toBeUndefined();
    const check = new DatabaseSync(sqlitePath(home));
    const v7 = check
      .prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?")
      .get("/old.ts") as { n: number };
    check.close();
    expect(v7.n).toBe(0);
  });
});

it("pruneMissing deletes the whole v7 lineage family for missing paths", async () => {
  await withTempHome(async (home) => {
    const store = await loadHashStore();
    const { saveUndo } = await import("../../src/undo-edit.js");
    (store as unknown as InternalHashStore).commitSnapshot({
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
    (store as unknown as InternalHashStore).commitSnapshot({
      path: "/gone-pure.ts",
      content: "p\n",
      hashes: ["P01"],
      leases: { sessionKey: "s1", rows: [{ position: 0, hash: "P01" }] },
    });
    // Existing path keeps every row (no over-delete).
    const keep = join(home, "keep-fam.ts");
    await writeFile(keep, "x\ny\n", "utf-8");
    (store as unknown as InternalHashStore).commitSnapshot({
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

it("pruneMissing rolls back every table when a later delete faults", async () => {
  await withTempHome(async (home) => {
    const store = await loadHashStore();
    const { saveUndo } = await import("../../src/undo-edit.js");
    // Missing path with a full family; `file_undo` and the served meta row follow lineage in the
    // prune order, so a fault on the LAST delete must roll back every earlier one.
    store.upsertSnapshot("/gone-rb.ts", contentChecksum("a\n"), 1, ["H01"], "a\n");
    (store as unknown as InternalHashStore).commitSnapshot({
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
      "CREATE TRIGGER t3a_served_fault BEFORE DELETE ON served_session_meta " +
        "BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );
    setup.close();
    await expect(store.pruneMissing()).rejects.toThrow("injected");
    const check = new DatabaseSync(sqlitePath(home));
    const count = (sql: string, p: string) => (check.prepare(sql).get(p) as { n: number }).n;
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
    expect(
      count("SELECT COUNT(*) AS n FROM served_session_meta WHERE file_path = ?", "/gone-rb.ts"),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?", "/gone-rb.ts")).toBe(1);
    check.close();
  });
});

it("reopen janitor prunes the undo row when the TTL elapsed", async () => {
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
    raw.prepare("UPDATE file_undo SET updated_at = ? WHERE path = ?").run(1000, oldPath);
    raw.close();
    shutdownHashStore();
    // cutoff = now - 3600s: stamp 1000 is older by an hour margin, no wall-clock dependence.
    const store = await loadHashStore();
    expect(store.getUndo(oldPath)).toBeUndefined();
    const check = new DatabaseSync(sqlitePath(home));
    const v7 = check.prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?").get(oldPath) as {
      n: number;
    };
    check.close();
    expect(v7.n).toBe(0);
  });
});

it("reopen janitor keeps the undo row when its stamp is newer than the TTL", async () => {
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
    // Young stamp named explicitly: newer than the cutoff by an hour margin, and the
    // exact value the row contract below is asserted against.
    const youngStamp = Date.now();
    raw.prepare("UPDATE file_undo SET updated_at = ? WHERE path = ?").run(youngStamp, splitPath);
    raw.close();
    // Force the reopen: the janitor (and its newest-side TTL rule) runs on open.
    shutdownHashStore();
    const store = await loadHashStore();
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
      effectiveEnding: "\n",
      preImageMixed: 0,
      migratedFrom: null,
      migratedFromBOM: null,
    });
  });
});

it("deleteByPath removes only the lineage family and leaves the other families intact", async () => {
  await withTempHome(async (_home) => {
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const { saveUndo } = await import("../../src/undo-edit.js");
    const { snapshotHashFor } = await import("../../src/snapshot-store/lineage-store.js");
    const path = "/narrow.ts";
    const content = "alpha\nbeta\n";
    const hashes = ["AAA", "AAB"];

    internal.upsertSnapshot(path, contentChecksum(content), 2, hashes, content);
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
    // The lineage family was the ONLY snapshot source, so the read is a miss now.
    expect(internal.getSnapshot(path, content)).toBeUndefined();
  });
});

it("getSnapshot is a miss when the lineage family is corrupt (no legacy fallback)", async () => {
  await withTempHome(async (home) => {
    const internal = (await loadHashStore()) as unknown as InternalHashStore;
    const path = "/fallback.ts";
    const content = "alpha\nbeta\n";
    const hashes = ["AAA", "AAB"];
    internal.upsertSnapshot(path, contentChecksum(content), 2, hashes, content);

    // Corrupt the lineage family: right row count, non-sequential line_number.
    const db = new DatabaseSync(sqlitePath(home));
    db.prepare(
      "UPDATE line_lineage SET line_number = 99 WHERE line_number = 1 AND snapshot_id IN " +
        "(SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
    ).run(path);
    db.close();
    shutdownHashStore();

    const reopened = await loadHashStore();
    // The shape guard rejects the corrupt lineage, and there is no other source: a miss.
    expect(reopened.getSnapshot(path, content)).toBeUndefined();
  });
});
