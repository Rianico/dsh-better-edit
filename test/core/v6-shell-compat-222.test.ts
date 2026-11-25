/**
 * Ticket #222 — the v6 shells are still shells.
 *
 * ADR-0016's shell-retention contract: `snapshots`, `undo` and `served` keep their exact v6
 * shapes (a v6 process prepares statements against them on store open), and v7 must neither
 * read nor write them. This suite pins the contract from both sides:
 *
 *  1. the schema after a v9 open is the v6 column list, column for column;
 *  2. a full v7 cycle (serve, materialize, undo, wipe, TTL prune, pruneMissing) leaves all three
 *     shells at zero rows while the v7 tables carry the state;
 *  3. a v6 client's own read/write/delete statement set still succeeds against the v9 store, and
 *     the v7 readers ignore every row it writes.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadHashStore, loadServedStore, shutdownHashStore } from "../../src/hash-store.js";
import { recordServed } from "../../src/session-view.js";
import { saveUndo } from "../../src/undo-edit.js";
import { initHasher, contentChecksum } from "../../src/hashline/hash-assign.js";
import { getWritableTempRoot } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "v6-shell-compat-"));
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

/** The released v6 column lists — the shape a v6 process prepares against (ADR-0016). */
const V6_COLUMNS = {
  snapshots: ["path", "checksum", "line_count", "hashes", "updated_at"],
  undo: [
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
  ],
  served: ["session_id", "path", "hashes", "reported", "retired", "canons", "cards", "updated_at"],
} as const;

const SHELL_TABLES = ["snapshots", "undo", "served"] as const;

function shellCounts(db: DatabaseSync): Record<(typeof SHELL_TABLES)[number], number> {
  const counts = {} as Record<(typeof SHELL_TABLES)[number], number>;
  for (const table of SHELL_TABLES) {
    // Table names are SQL identifiers and come from the literal allowlist above, never a caller.
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return counts;
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  // Parameterized: `pragma_table_info` is a table-valued function, so the table is a VALUE.
  return (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map(
    (column) => column.name,
  );
}

describe("v6 shells — exact shapes after a v9 open", () => {
  it("keeps snapshots, undo and served at their released v6 column arrays", async () => {
    await withTempHome(async (home) => {
      await loadHashStore();
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as never);
      try {
        for (const table of SHELL_TABLES) {
          expect({ table, columns: tableColumns(db, table) }).toEqual({
            table,
            columns: [...V6_COLUMNS[table]],
          });
        }
        expect(tableColumns(db, "served_session_meta")).toEqual([
          "session_id",
          "file_path",
          "hashes",
          "reported",
          "retired",
          "canons",
          "cards",
          "updated_at",
        ]);
      } finally {
        db.close();
      }
    });
  });
});

describe("v6 shells — a full v7 cycle never writes them", () => {
  it("populates the v7 tables and leaves every shell at zero rows", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const served = await loadServedStore();

      const raw = (): DatabaseSync =>
        new DatabaseSync(sqlitePath(home), { defensive: false } as never);
      const before = raw();
      const shellsBefore = shellCounts(before);
      before.close();
      expect(shellsBefore).toEqual({ snapshots: 0, undo: 0, served: 0 });

      // Serve (served_session_meta), materialize (file_snapshots + line_lineage), undo (file_undo).
      await recordServed("cycle-session", "/cycle.ts", [{ position: 0, hash: "C01" }], 1, {
        hashes: ["C01"],
        content: "cycle\n",
        fullRead: true,
      });
      store.upsertSnapshot("/cycle.ts", contentChecksum("cycle\n"), 1, ["C01"], "cycle\n");
      await saveUndo("/cycle.ts", {
        content: "before\n",
        bom: "",
        originalEnding: "\n",
        hashes: ["B01"],
        resultContent: "cycle\n",
      });

      const populated = raw();
      try {
        expect(served.getServed("cycle-session", "/cycle.ts")).toEqual(["C01"]);
        expect(store.getUndo("/cycle.ts")).toBeDefined();
        expect(
          (
            populated.prepare("SELECT COUNT(*) AS n FROM served_session_meta").get() as {
              n: number;
            }
          ).n,
        ).toBe(1);
        expect(
          (populated.prepare("SELECT COUNT(*) AS n FROM file_undo").get() as { n: number }).n,
        ).toBe(1);
        expect(
          (populated.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }).n,
        ).toBe(1);
        expect(shellCounts(populated)).toEqual({ snapshots: 0, undo: 0, served: 0 });
      } finally {
        populated.close();
      }

      // Session wipe and the whole-row TTL prune both target the meta table only.
      await recordServed("cycle-session", "/cycle.ts", [{ position: 0, hash: "C01" }], 1, {
        hashes: ["C01"],
        content: "cycle\n",
        fullRead: true,
      });
      served.wipeServed("cycle-session");
      expect(served.getServed("cycle-session", "/cycle.ts")).toEqual([]);

      await recordServed("cycle-session", "/cycle.ts", [{ position: 0, hash: "C01" }], 1, {
        hashes: ["C01"],
        content: "cycle\n",
        fullRead: true,
      });
      served.pruneServedOlderThan(Date.now() + 60_000);
      expect(served.getServed("cycle-session", "/cycle.ts")).toEqual([]);

      // pruneMissing owns whole-path deletion for the v7 families; the shells are not consulted.
      await recordServed("cycle-session", "/gone.ts", [{ position: 0, hash: "G01" }], 1);
      await store.pruneMissing();
      expect(served.getServed("cycle-session", "/gone.ts")).toEqual([]);

      const after = raw();
      try {
        expect(shellCounts(after)).toEqual({ snapshots: 0, undo: 0, served: 0 });
      } finally {
        after.close();
      }
    });
  });
});

describe("v6 shells — a v6 client still owns its statement set", () => {
  it("replays the v6 read/write/delete shapes and v7 readers ignore the rows", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const served = await loadServedStore();
      const now = Date.now();

      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as never);
      try {
        // ---- v6 write shapes: every released statement still prepares and runs.
        db.prepare(
          "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, " +
            "hashes = excluded.hashes, updated_at = excluded.updated_at",
        ).run("/v6.ts", "ck", 1, JSON.stringify(["AAA"]), now);
        db.prepare(
          "INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(path) DO UPDATE SET content = excluded.content, bom = excluded.bom, " +
            "ending = excluded.ending, hashes = excluded.hashes, " +
            "result_content = excluded.result_content, updated_at = excluded.updated_at",
        ).run("/v6u.ts", "c", "", "\n", JSON.stringify(["DDD"]), "r", now);
        db.prepare(
          "INSERT INTO served (session_id, path, hashes, reported, updated_at) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(session_id, path) DO UPDATE SET hashes = excluded.hashes, " +
            "updated_at = excluded.updated_at",
        ).run("v6-session", "/v6.ts", JSON.stringify(["CCC"]), null, now);

        // ---- v6 read shapes: the rows come back from the shells, untouched.
        const snapshot = db
          .prepare(
            "SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?",
          )
          .get("/v6.ts", "ck", 1) as { hashes: string };
        expect(JSON.parse(snapshot.hashes)).toEqual(["AAA"]);
        const undo = db
          .prepare("SELECT content, bom, ending, hashes, result_content FROM undo WHERE path = ?")
          .get("/v6u.ts") as { hashes: string };
        expect(JSON.parse(undo.hashes)).toEqual(["DDD"]);
        const servedRow = db
          .prepare("SELECT hashes FROM served WHERE session_id = ? AND path = ?")
          .get("v6-session", "/v6.ts") as { hashes: string };
        expect(JSON.parse(servedRow.hashes)).toEqual(["CCC"]);

        // ---- v7 readers are blind to all three rows: the shells are not v7 evidence.
        expect(store.getSnapshot("/v6.ts", "v6 content\n")).toBeUndefined();
        expect(store.getUndo("/v6u.ts")).toBeUndefined();
        expect(store.getFileUndo("/v6u.ts")).toBeUndefined();
        expect(served.getServed("v6-session", "/v6.ts")).toEqual([]);
        expect(
          (db.prepare("SELECT COUNT(*) AS n FROM served_session_meta").get() as { n: number }).n,
        ).toBe(0);

        // ---- v6 delete shapes: still the shell owner's calls.
        db.prepare("DELETE FROM snapshots WHERE path = ?").run("/v6.ts");
        db.prepare("DELETE FROM undo WHERE path = ?").run("/v6u.ts");
        db.prepare("DELETE FROM served WHERE session_id = ?").run("v6-session");
        expect(shellCounts(db)).toEqual({ snapshots: 0, undo: 0, served: 0 });
      } finally {
        db.close();
      }
    });
  });
});
