import { beforeAll, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { HASH_STORE_VERSION } from "../../src/constants.js";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import { HASH_RE, initHasher, rawDigest } from "../../src/hashline/hash-assign.js";
import { lineHashes } from "../../src/hashline/hash.js";
import { useTestHome } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

const home = useTestHome();

function pathFor(name: string): string {
  return join(dirname(home.testPath), name);
}

function sqlitePath(): string {
  return join(dirname(home.testPath), ".dsh", "plugins", "dsh-better-edit", "hash-store.sqlite");
}

describe("line_lineage.raw_hash — schema column", () => {
  it("is part of the current schema (added after the shared-store era)", () => {
    expect(HASH_STORE_VERSION).toBeGreaterThanOrEqual(8);
  });

  it("persists the raw-line digest beside the canon digest", async () => {
    const path = pathFor("raw-persisted.txt");
    await lineHashes("  a\nb\n", path);

    const rows = (await loadHashStore()).latestLineageFor(path);

    expect(rows?.map((row) => row.rawHash)).toEqual([rawDigest("  a"), rawDigest("b")]);
    expect(rawDigest("  a")).not.toBe(rawDigest("a"));
    for (const row of rows ?? []) expect(HASH_RE.test(row.anchor)).toBe(true);
  });

  it("backfills the nullable column on an old store and reads legacy rows as no evidence", async () => {
    const path = pathFor("legacy-store.txt");
    await lineHashes("a\nb\nc\n", path);

    shutdownHashStore();
    const old = new DatabaseSync(sqlitePath(), { defensive: false } as any);
    old.exec("ALTER TABLE line_lineage DROP COLUMN raw_hash");
    old.prepare("UPDATE meta SET value = ? WHERE key = 'version'").run("7");
    old.close();

    const reopened = await loadHashStore();
    const rows = reopened.latestLineageFor(path);

    expect(rows).toHaveLength(3);
    expect(rows?.map((row) => row.rawHash)).toEqual([undefined, undefined, undefined]);

    shutdownHashStore();
    const after = new DatabaseSync(sqlitePath(), { defensive: false } as any);
    const columns = after.prepare("PRAGMA table_info(line_lineage)").all() as { name: string }[];
    const stamp = after.prepare("SELECT value FROM meta WHERE key = 'version'").get() as {
      value: string;
    };
    after.close();

    expect(columns.some((column) => column.name === "raw_hash")).toBe(true);
    expect(stamp.value).toBe(String(HASH_STORE_VERSION));
  });
});
