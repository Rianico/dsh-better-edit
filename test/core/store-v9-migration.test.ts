/**
 * Ticket #222 — store version 9: the v7 served state moves onto `served_session_meta`.
 *
 * The v6 shells keep their exact shapes (ADR-0016), so the upgrade is ONE forward migration that
 * copies the warm served mirror out of the `served` shell into the live v7 table. Ordering is
 * load-bearing: `ensureSchema` creates the table and backfills the shell columns, `migrateForward`
 * copies inside the same `BEGIN IMMEDIATE` that stamps the version, and the anchor-generation
 * sweep runs after it. The copy is `DO NOTHING` so a re-migration (stamp back to 8 after a
 * downgrade) can never clobber live v7 rows with the shell's stale ones.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import { HASH_STORE_VERSION } from "../../src/constants.js";
import { snapshotEpochKey } from "../../src/snapshot-store/epoch.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { getWritableTempRoot } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "store-v9-migration-"));
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

/**
 * The v6 shell row's payload. `path` MUST be a real file: the open's `pruneMissing` reclaims a
 * meta row whose path is gone, and this fixture is about the copy, not about retention.
 */
function seededServed(path: string) {
  return {
    session_id: "sessionA",
    path,
    hashes: JSON.stringify(["AAA", "BBB"]),
    reported: JSON.stringify(["AAA"]),
    retired: JSON.stringify([{ hash: "CCC", deathPos: null }]),
    canons: JSON.stringify(["ca", "cb"]),
    cards: JSON.stringify([1, 2]),
    // A RECENT stamp: the store-open TTL prune would otherwise reclaim the copied row immediately.
    updated_at: Date.now(),
  };
}

/**
 * A stamp-8 store as the previous build left it: the v6 `served` shell carries the warm mirror,
 * and `meta.anchor_generation` is the CURRENT epoch — so the open's sweep is a no-op and the
 * copied family survives (a foreign stamp would reclaim it, which the sweep's own suite pins).
 */
function seedStampEightStore(home: string, path: string) {
  const row = seededServed(path);
  const db = new DatabaseSync(sqlitePath(home));
  try {
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO meta (key, value) VALUES ('version', '8')").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('anchor_generation', ?)").run(
      snapshotEpochKey(),
    );
    db.exec(
      "CREATE TABLE served (" +
        "session_id TEXT NOT NULL, " +
        "path TEXT NOT NULL, " +
        "hashes TEXT NOT NULL, " +
        "reported TEXT, " +
        "retired TEXT, " +
        "canons TEXT, " +
        "cards TEXT, " +
        "updated_at INTEGER NOT NULL, " +
        "PRIMARY KEY (session_id, path)" +
        ")",
    );
    db.prepare(
      "INSERT INTO served (session_id, path, hashes, reported, retired, canons, cards, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      row.session_id,
      row.path,
      row.hashes,
      row.reported,
      row.retired,
      row.canons,
      row.cards,
      row.updated_at,
    );
  } finally {
    db.close();
  }
  return row;
}

describe("store v9 forward migration — served shell copied into served_session_meta", () => {
  it("copies every payload column, leaves the v6 shell byte-identical, and stamps 9", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      const path = join(home, "p.ts");
      await writeFile(path, "x\n", "utf-8");
      const seeded = seedStampEightStore(home, path);

      const shellBeforeDb = new DatabaseSync(sqlitePath(home));
      const shellBefore = shellBeforeDb
        .prepare("SELECT * FROM served ORDER BY session_id, path")
        .all();
      shellBeforeDb.close();

      await loadHashStore();
      shutdownHashStore();

      const check = new DatabaseSync(sqlitePath(home));
      try {
        const metaRow = check
          .prepare(
            "SELECT session_id, file_path, hashes, reported, retired, canons, cards, updated_at " +
              "FROM served_session_meta WHERE session_id = ? AND file_path = ?",
          )
          .get(seeded.session_id, seeded.path) as Record<string, unknown> | undefined;
        expect(metaRow).toEqual({
          session_id: seeded.session_id,
          file_path: seeded.path,
          hashes: seeded.hashes,
          reported: seeded.reported,
          retired: seeded.retired,
          canons: seeded.canons,
          cards: seeded.cards,
          updated_at: seeded.updated_at,
        });

        // The shell is a v6 client's property: the migration READS it and never writes it.
        expect(check.prepare("SELECT * FROM served ORDER BY session_id, path").all()).toEqual(
          shellBefore,
        );

        const version = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
          | { value?: string }
          | undefined;
        expect(version?.value).toBe(String(HASH_STORE_VERSION));
        expect(HASH_STORE_VERSION).toBe(9);
      } finally {
        check.close();
      }
    });
  });

  it("re-migrates with DO NOTHING so a stale shell row cannot clobber the live meta row", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      const path = join(home, "p.ts");
      await writeFile(path, "x\n", "utf-8");
      const seeded = seedStampEightStore(home, path);

      // First open: copies and stamps 9.
      await loadHashStore();
      shutdownHashStore();

      // A v6 process re-stamps the store and writes a CONFLICTING row for the same key. The
      // re-migration must keep the live v7 row (DO NOTHING), and must still not write the shell.
      const raw = new DatabaseSync(sqlitePath(home));
      raw.prepare("UPDATE meta SET value = '8' WHERE key = 'version'").run();
      raw
        .prepare("UPDATE served SET hashes = ? WHERE session_id = ? AND path = ?")
        .run(JSON.stringify(["ZZZ"]), seeded.session_id, seeded.path);
      raw.close();

      await loadHashStore();
      shutdownHashStore();

      const check = new DatabaseSync(sqlitePath(home));
      try {
        const metaRow = check
          .prepare("SELECT hashes FROM served_session_meta WHERE session_id = ? AND file_path = ?")
          .get(seeded.session_id, seeded.path) as { hashes: string };
        expect(JSON.parse(metaRow.hashes)).toEqual(["AAA", "BBB"]);

        const shellRow = check
          .prepare("SELECT hashes FROM served WHERE session_id = ? AND path = ?")
          .get(seeded.session_id, seeded.path) as { hashes: string };
        expect(JSON.parse(shellRow.hashes)).toEqual(["ZZZ"]);

        const version = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
          | { value?: string }
          | undefined;
        expect(version?.value).toBe(String(HASH_STORE_VERSION));
      } finally {
        check.close();
      }
    });
  });

  it("is idempotent: a second open at stamp 9 copies nothing and rewrites nothing", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      const path = join(home, "p.ts");
      await writeFile(path, "x\n", "utf-8");
      seedStampEightStore(home, path);

      await loadHashStore();
      shutdownHashStore();

      const raw = new DatabaseSync(sqlitePath(home));
      const metaBefore = raw
        .prepare(
          "SELECT session_id, file_path, hashes, reported, retired, canons, cards, updated_at " +
            "FROM served_session_meta ORDER BY session_id, file_path",
        )
        .all();
      const shellBefore = raw.prepare("SELECT * FROM served ORDER BY session_id, path").all();
      raw.close();

      await loadHashStore();
      shutdownHashStore();

      const check = new DatabaseSync(sqlitePath(home));
      try {
        const metaAfter = check
          .prepare(
            "SELECT session_id, file_path, hashes, reported, retired, canons, cards, updated_at " +
              "FROM served_session_meta ORDER BY session_id, file_path",
          )
          .all();
        expect(metaAfter).toEqual(metaBefore);
        expect(metaAfter).toHaveLength(1);
        expect(check.prepare("SELECT * FROM served ORDER BY session_id, path").all()).toEqual(
          shellBefore,
        );
      } finally {
        check.close();
      }
    });
  });
});
