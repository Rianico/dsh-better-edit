/**
 * #171 — the undo restores at the terminator the EDIT wrote, and says so when the pre-image
 * was mixed (upstream pi-better-edit@aa10e61 / ADR-0019 §4, adapted).
 *
 * #169 gave a write ONE effective terminator and made it disclose a rewrite; the undo still
 * replayed the pre-image at `detectEnding`'s answer, so restoring a mixed file re-spelled it at
 * the wrong ending. The pair now records the write's effective ending and whether the pre-image
 * spelled more than one terminator kind, so the revert:
 *
 *  - restores at the ending the edit actually used (byte-identical for a uniform file),
 *  - compares staleness against the same ending it will write,
 *  - and pushes one clause naming that ending when the pre-image was mixed — the mixture itself
 *    is not restorable, and saying nothing would claim it was.
 *
 * Old rows (the two columns NULL) fall back to `ending` and never claim a mixture, so an upgrade
 * needs no destructive migration and no version bump.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { loadHashStore, shutdownHashStore, type UndoRecord } from "../../src/hash-store.js";
import { getUndo, saveUndo } from "../../src/undo-edit.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { withWorkspace } from "../../src/workspace-context.js";
import { clearEncodingState, localIO, type FileIO } from "../../src/fs-bridge.js";
import { resolveTarget } from "../../src/paths.js";
import {
  extractHash,
  getText,
  setupIntegrationTest,
  withTempDir,
  withTempFile,
} from "../support/fixtures.js";

const MIXED_CLAUSE = "the pre-edit mixture is not restored.";
const ANCHOR_ROW = /^([A-Za-z0-9]{3})│(.*)$/;

beforeAll(async () => {
  await initHasher();
});

afterEach(() => {
  // The effective ending is a config rung; a forgotten override must not leak across files.
  _resetConfigCache();
  delete process.env.DSH_BETTER_EDIT_EOL;
});

/** The served anchors of a read result, keyed by the row's content. */
function anchorsByContent(text: string): Map<string, string> {
  const rows: RegExpExecArray[] = [];
  for (const line of text.split("\n")) {
    const match = ANCHOR_ROW.exec(line);
    if (match !== null) rows.push(match);
  }
  return new Map(rows.map((match) => [match[2]!, extractHash(match[0])]));
}

/** Read, then edit one line by its content; returns the edit's text. */
async function readAndEdit(
  cwd: string,
  name: string,
  from: string,
  to: string,
  io?: FileIO,
): Promise<{ harness: ReturnType<typeof setupIntegrationTest>; editText: string }> {
  const harness = setupIntegrationTest(cwd, io);
  const anchors = anchorsByContent(getText(await harness.readTool.execute("r1", { path: name })));
  const anchor = anchors.get(from);
  expect(anchor, `read served no row for ${JSON.stringify(from)}`).toBeDefined();
  const editText = getText(
    await harness.editTool.execute("e1", {
      path: name,
      anchor_from: anchor!,
      anchor_to: anchor!,
      replace_with: to,
    }),
  );
  return { harness, editText };
}

/**
 * A `FileIO` that records every `writeText` call and delegates: the only way to observe the
 * options the tool passes (a wrapper that dropped them would change the bytes silently).
 */
function recordingIO(): { io: FileIO; calls: unknown[][] } {
  const base = localIO();
  const calls: unknown[][] = [];
  const io: FileIO = {
    ...base,
    writeText(...args: Parameters<FileIO["writeText"]>) {
      calls.push(args);
      return base.writeText(...args);
    },
  };
  return { io, calls };
}

/**
 * A `FileIO` that isolates the SAVE seam: it writes literally (no `prepareForSave` re-spelling on
 * the far side) and records no encoding memo, because its `readText` clears the entry it just
 * produced. Both halves are needed: the undo's own staleness read runs immediately before the save
 * and would otherwise re-record the ending it observed (which equals the effective ending here),
 * masking a missing `lineEnding` option and letting this fixture pass for the wrong reason.
 */
function rawWriteIO(): FileIO {
  const base = localIO();
  return {
    ...base,
    async readText(absolutePath: string, signal?: AbortSignal, encoding?: string) {
      const text = await base.readText(absolutePath, signal, encoding);
      clearEncodingState(absolutePath);
      return text;
    },
    async writeText(absolutePath: string, content: string) {
      await writeFile(absolutePath, content, "utf-8");
    },
  };
}

describe("mixed pre-image — the undo restores at the ending the edit used", () => {
  it("first separator differs from the majority: restores at CRLF and discloses the mixture", async () => {
    await withTempFile("t.txt", "a\nb\r\nc\r\nd\r\n", async ({ cwd, path }) => {
      // The edit adds a line as well as changing one: the line-count summary then exists, which is
      // what the ordering assertion below needs (the clause must follow it and precede the revert).
      const { harness, editText } = await readAndEdit(cwd, "t.txt", "a", "A\nEXTRA");
      // The edit itself normalized the file; that is #169's contract, not this test's claim.
      expect(await readFile(path, "utf-8")).toBe("A\r\nEXTRA\r\nb\r\nc\r\nd\r\n");
      expect(editText).not.toContain("[E_");

      const text = getText(await harness.undoTool.execute("u1", { path: "t.txt" }));

      expect(await readFile(path, "utf-8")).toBe("a\r\nb\r\nc\r\nd\r\n");
      expect(text).toContain(`Restored at CRLF; ${MIXED_CLAUSE}`);
      expect(text).not.toContain("[E_");

      // Response order is the contract: the line-count summary, then the mixture clause, then the
      // revert summary. A clause pushed after the revert would read as a footnote about it.
      const summaryAt = text.indexOf("line(s) that were added");
      const clauseAt = text.indexOf("Restored at CRLF");
      const revertedAt = text.indexOf("File reverted to previous state.");
      expect(summaryAt).toBeGreaterThanOrEqual(0);
      expect(summaryAt).toBeLessThan(clauseAt);
      expect(clauseAt).toBeLessThan(revertedAt);
    });
  });

  it("the opposite order: restores at LF and the clause names LF", async () => {
    await withTempFile("t.txt", "a\r\nb\nc\nd\n", async ({ cwd, path }) => {
      const { harness } = await readAndEdit(cwd, "t.txt", "a", "A");
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\nd\n");

      const text = getText(await harness.undoTool.execute("u1", { path: "t.txt" }));

      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\n");
      expect(text).toContain(`Restored at LF; ${MIXED_CLAUSE}`);
      expect(text).not.toContain("[E_");
    });
  });
});

describe("uniform pre-image — byte-for-byte restore, no clause", () => {
  const cases: Array<{ ending: string; name: string; original: string }> = [
    { ending: "LF", name: "lf.txt", original: "a\nb\n" },
    { ending: "CRLF", name: "crlf.txt", original: "a\r\nb\r\n" },
    { ending: "CR", name: "cr.txt", original: "a\rb\r" },
  ];

  for (const { ending, name, original } of cases) {
    it(`restores every ${ending} terminator exactly and says nothing about a mixture`, async () => {
      await withTempFile(name, original, async ({ cwd, path }) => {
        const { harness } = await readAndEdit(cwd, name, "a", "A");

        const text = getText(await harness.undoTool.execute("u1", { path: name }));

        expect(await readFile(path, "utf-8")).toBe(original);
        expect(text).not.toContain("Restored at");
      });
    });
  }
});

describe("old rows — the two columns carrying NULL mean 'no mixture'", () => {
  it("a pre-change row falls back to `ending` and restores at it without the clause", async () => {
    await withTempFile("t.txt", "a\r\nb\r\n", async ({ cwd, path }) => {
      const { harness } = await readAndEdit(cwd, "t.txt", "a", "A");
      expect(await readFile(path, "utf-8")).toBe("A\r\nb\r\n");

      // Simulate the pre-change row WITHOUT a migration: the columns exist (an additive
      // backfill), so the upgrade state is exactly "present, unset". Blanking them is the
      // whole fixture — an old store's row is indistinguishable from this one after
      // `addColumnIfMissing` ran, which is why no destructive step is needed.
      shutdownHashStore();
      const raw = new DatabaseSync(hashStorePath(cwd));
      raw.exec(
        "UPDATE undo SET effective_ending = NULL, pre_image_mixed = NULL; " +
          "UPDATE file_undo SET effective_ending = NULL, pre_image_mixed = NULL;",
      );
      raw.close();

      const entry = await withWorkspace(cwd, () => getUndo(path));
      expect(entry?.effectiveEnding).toBe("\r\n");
      expect(entry?.preImageMixed).toBe(false);

      const text = getText(await harness.undoTool.execute("u1", { path: "t.txt" }));

      expect(await readFile(path, "utf-8")).toBe("a\r\nb\r\n");
      expect(text).not.toContain("Restored at");
    });
  });
});

describe("storage — both rows round-trip the new columns", () => {
  it("saveUndo stores the effective ending and the mixed flag; an absent one falls back", async () => {
    await withTempDir("undo-eol-store-", async (dir) => {
      const path = join(dir, "a.txt");
      await saveUndo(path, {
        content: "a\nb\n",
        bom: "",
        originalEnding: "\n",
        hashes: ["AAA", "BBB"],
        resultContent: "A\nb\n",
        effectiveEnding: "\r\n",
        preImageMixed: true,
      });

      const entry = await getUndo(path);
      expect(entry?.effectiveEnding).toBe("\r\n");
      expect(entry?.preImageMixed).toBe(true);

      // A caller that names neither (every pre-#171 call site) records the original ending and
      // never claims a mixture — the same shape an old row reads back as.
      await saveUndo(path, {
        content: "c\nd\n",
        bom: "",
        originalEnding: "\r",
        hashes: ["CCC", "DDD"],
        resultContent: "C\nd\n",
      });

      const replaced = await getUndo(path);
      expect(replaced?.effectiveEnding).toBe("\r");
      expect(replaced?.preImageMixed).toBe(false);
    });
  });
});

describe("staleness — the comparison uses the ending the restore writes", () => {
  it("an external write clears the pair and reports E_UNDO_STALE", async () => {
    await withTempFile("t.txt", "a\nb\r\nc\r\nd\r\n", async ({ cwd, path }) => {
      const { harness } = await readAndEdit(cwd, "t.txt", "a", "A");
      expect(await readFile(path, "utf-8")).toBe("A\r\nb\r\nc\r\nd\r\n");

      await writeFile(path, "external\r\n", "utf-8");
      const text = getText(await harness.undoTool.execute("u1", { path: "t.txt" }));

      expect(text).toContain("[E_UNDO_STALE]");
      expect(await readFile(path, "utf-8")).toBe("external\r\n");
      expect(await withWorkspace(cwd, () => getUndo(path))).toBeUndefined();
    });
  });
});

describe("corruption — a bad new column heals the pair", () => {
  it("a non-numeric pre_image_mixed reads as a miss and deletes both rows", async () => {
    await withTempDir("undo-eol-heal-", async (dir) => {
      const path = join(dir, "a.txt");
      const content = "a\nb\n";
      const resultContent = "A\nb\n";
      const legacy: UndoRecord = {
        content,
        bom: "",
        ending: "\n",
        hashes: ["AAA", "BBB"],
        resultContent,
      };
      const store = await loadHashStore();
      store.writeUndoPair(path, legacy, { ...legacy, snapshotHash: snapshotHashFor(content) });
      // The pair is readable before the corruption, so the miss below is the healing, not a
      // generation refusal or a missing row.
      expect(store.getFileUndo(path)?.snapshotHash).toBe(snapshotHashFor(content));

      shutdownHashStore();
      const raw = new DatabaseSync(hashStorePath());
      raw.exec("UPDATE file_undo SET pre_image_mixed = 'oops'");
      raw.close();

      expect(await getUndo(path)).toBeUndefined();
      const reloaded = await loadHashStore();
      expect(reloaded.getFileUndo(path)).toBeUndefined();
      // The healing is pair-wide: the legacy row does not survive its v7 half.
      expect(reloaded.getUndo(path)).toBeUndefined();
    });
  });
});

/**
 * The column names `pragma_table_info` reports for one table — the schema fact the backfill owns.
 */
function columnsOf(db: DatabaseSync, table: string): string[] {
  // Parameterized: `pragma_table_info` is a table-valued function, so the table is a VALUE.
  return (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map(
    (column) => column.name,
  );
}

describe("upgrade — an old store gains the pair on BOTH tables", () => {
  it("backfills the columns and reads its surviving rows as 'not recorded'", async () => {
    await withTempDir("undo-eol-upgrade-", async (dir) => {
      const path = join(dir, "a.txt");
      const content = "a\nb\n";
      const legacy: UndoRecord = {
        content,
        bom: "",
        ending: "\r\n",
        hashes: ["AAA", "BBB"],
        resultContent: "A\nb\n",
      };
      const store = await loadHashStore();
      store.writeUndoPair(path, legacy, { ...legacy, snapshotHash: snapshotHashFor(content) });
      shutdownHashStore();

      // Model the pre-#171 store: neither half carries the pair. DROP COLUMN takes the values with
      // it, so whatever the open path re-adds arrives NULL on the existing rows — which is exactly
      // the upgrade state this ticket promises (no destructive migration, no version bump).
      const preChange = new DatabaseSync(hashStorePath());
      preChange.exec(
        "ALTER TABLE undo DROP COLUMN effective_ending; " +
          "ALTER TABLE undo DROP COLUMN pre_image_mixed; " +
          "ALTER TABLE file_undo DROP COLUMN effective_ending; " +
          "ALTER TABLE file_undo DROP COLUMN pre_image_mixed;",
      );
      preChange.close();

      // The fixture really removed them, so the assertions below cannot pass vacuously.
      const dropped = new DatabaseSync(hashStorePath());
      expect(columnsOf(dropped, "undo")).not.toContain("effective_ending");
      expect(columnsOf(dropped, "file_undo")).not.toContain("pre_image_mixed");
      dropped.close();

      // The open path backfills BOTH tables. Deleting either `addColumnIfMissing` call fails here,
      // on the table it belongs to — that is the whole point of inspecting the live schema.
      const reopened = await loadHashStore();
      const inspected = new DatabaseSync(hashStorePath());
      expect(columnsOf(inspected, "undo")).toEqual(
        expect.arrayContaining(["effective_ending", "pre_image_mixed"]),
      );
      expect(columnsOf(inspected, "file_undo")).toEqual(
        expect.arrayContaining(["effective_ending", "pre_image_mixed"]),
      );
      inspected.close();

      // The re-added columns are NULL on the surviving rows: "not recorded", never a claim.
      const legacyRow = reopened.getUndo(path);
      expect(legacyRow?.effectiveEnding).toBeNull();
      expect(legacyRow?.preImageMixed).toBeNull();
      const fileRow = reopened.getFileUndo(path);
      expect(fileRow?.effectiveEnding).toBeNull();
      expect(fileRow?.preImageMixed).toBeNull();

      // … so the reader falls back to the pre-image's ending and reports no mixture.
      const entry = await getUndo(path);
      expect(entry?.effectiveEnding).toBe("\r\n");
      expect(entry?.preImageMixed).toBe(false);
    });
  });
});

describe("seams — the effective ending is named at both write points", () => {
  it("the undo passes it as the write option (the IO seam re-prepares against the memo)", async () => {
    await withTempFile("t.txt", "a\nb\r\nc\r\nd\r\n", async ({ cwd }) => {
      const { io, calls } = recordingIO();
      const { harness } = await readAndEdit(cwd, "t.txt", "a", "A", io);

      const text = getText(await harness.undoTool.execute("u1", { path: "t.txt" }));

      expect(text).toContain(`Restored at CRLF; ${MIXED_CLAUSE}`);
      // The LAST write is the revert; its 7th argument names the ending the restore used. Drop that
      // argument and the IO seam re-prepares against a memo that still says `ending`.
      expect(calls.at(-1)?.[6]).toEqual({ lineEnding: "\r\n" });
    });
  });

  it("the restore names it in prepareForSave, not only in the IO option", async () => {
    await withTempFile("t.txt", "a\nb\r\nc\r\nd\r\n", async ({ cwd, path }) => {
      // A literal-writing IO: no `prepareForSave` on the far side can rescue a wrong ending, so the
      // bytes are decided by the save seam's own option alone.
      const { harness } = await readAndEdit(cwd, "t.txt", "a", "A", rawWriteIO());
      expect(await readFile(path, "utf-8")).toBe("A\r\nb\r\nc\r\nd\r\n");

      // Drop the memo: the undo must take its ending from the pair, not from a leftover record.
      clearEncodingState(await resolveTarget(path));

      await harness.undoTool.execute("u1", { path: "t.txt" });

      // `undo.content` is the NORMALIZED pre-image, so without `lineEnding` the literal write would
      // land LF and this assertion fails.
      expect(await readFile(path, "utf-8")).toBe("a\r\nb\r\nc\r\nd\r\n");
    });
  });
});
