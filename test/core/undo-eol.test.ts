/**
 * #171 — the undo restores at the terminator the EDIT wrote, and says so when the pre-image
 * was mixed (upstream pi-better-edit@aa10e61 / ADR-0019 §4, adapted).
 *
 * #169 gave a write ONE effective terminator and made it disclose a rewrite; the undo still
 * replayed the pre-image at `detectEnding`'s answer, so restoring a mixed file re-spelled it at
 * the wrong ending. The pair now records the write's effective ending and whether the pre-image
 * spelled more than one terminator kind, so the revert:
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
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
      const { harness, editText } = await readAndEdit(cwd, "t.txt", "a", "A\nEXTRA");
      expect(await readFile(path, "utf-8")).toBe("A\r\nEXTRA\r\nb\r\nc\r\nd\r\n");
      expect(editText).not.toContain("[E_");

      const text = getText(await harness.undoTool.execute("u1", { path: "t.txt" }));

      expect(await readFile(path, "utf-8")).toBe("a\r\nb\r\nc\r\nd\r\n");
      expect(text).toContain(`Restored at CRLF; ${MIXED_CLAUSE}`);
      expect(text).not.toContain("[E_");

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

      shutdownHashStore();
      const raw = new DatabaseSync(hashStorePath(cwd));
      raw.exec("UPDATE file_undo SET effective_ending = NULL, pre_image_mixed = NULL;");
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

describe("corruption — a bad new column heals the row", () => {
  it("a non-numeric pre_image_mixed reads as a miss and deletes the row", async () => {
    await withTempDir("undo-eol-heal-", async (dir) => {
      const path = join(dir, "a.txt");
      const content = "a\nb\n";
      const resultContent = "A\nb\n";
      const record = {
        content,
        bom: "",
        ending: "\n",
        hashes: ["AAA", "BBB"],
        resultContent,
      };
      const store = await loadHashStore();
      store.writeUndo(path, { ...record, snapshotHash: snapshotHashFor(content) });
      expect(store.getFileUndo(path)?.snapshotHash).toBe(snapshotHashFor(content));

      shutdownHashStore();
      const raw = new DatabaseSync(hashStorePath());
      raw.exec("UPDATE file_undo SET pre_image_mixed = 'oops'");
      raw.close();

      expect(await getUndo(path)).toBeUndefined();
      const reloaded = await loadHashStore();
      expect(reloaded.getFileUndo(path)).toBeUndefined();
      expect(reloaded.getUndo(path)).toBeUndefined();
    });
  });
});

/**
 * The column names `pragma_table_info` reports for one table — the schema fact the backfill owns.
 */
function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map(
    (column) => column.name,
  );
}

describe("upgrade — an old store gains the pair on BOTH tables", () => {
  it("backfills the columns and reads its surviving rows as 'not recorded'", async () => {
    await withTempDir("undo-eol-upgrade-", async (dir) => {
      const path = join(dir, "a.txt");
      const content = "a\nb\n";
      const record = {
        content,
        bom: "",
        ending: "\r\n",
        hashes: ["AAA", "BBB"],
        resultContent: "A\nb\n",
      };
      const store = await loadHashStore();
      store.writeUndo(path, { ...record, snapshotHash: snapshotHashFor(content) });
      shutdownHashStore();

      const preChange = new DatabaseSync(hashStorePath());
      preChange.exec(
        "ALTER TABLE undo DROP COLUMN effective_ending; " +
          "ALTER TABLE undo DROP COLUMN pre_image_mixed; " +
          "ALTER TABLE file_undo DROP COLUMN effective_ending; " +
          "ALTER TABLE file_undo DROP COLUMN pre_image_mixed;",
      );
      preChange.close();

      const dropped = new DatabaseSync(hashStorePath());
      expect(columnsOf(dropped, "undo")).not.toContain("effective_ending");
      expect(columnsOf(dropped, "file_undo")).not.toContain("pre_image_mixed");
      dropped.close();

      const reopened = await loadHashStore();
      const inspected = new DatabaseSync(hashStorePath());
      expect(columnsOf(inspected, "undo")).toEqual(
        expect.arrayContaining(["effective_ending", "pre_image_mixed"]),
      );
      expect(columnsOf(inspected, "file_undo")).toEqual(
        expect.arrayContaining(["effective_ending", "pre_image_mixed"]),
      );
      inspected.close();

      const legacyRow = reopened.getUndo(path);
      expect(legacyRow?.effectiveEnding).toBeNull();
      expect(legacyRow?.preImageMixed).toBeNull();
      const fileRow = reopened.getFileUndo(path);
      expect(fileRow?.effectiveEnding).toBeNull();
      expect(fileRow?.preImageMixed).toBeNull();

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
      expect(calls.at(-1)?.[6]).toEqual({ lineEnding: "\r\n" });
    });
  });

  it("the restore names it in prepareForSave, not only in the IO option", async () => {
    await withTempFile("t.txt", "a\nb\r\nc\r\nd\r\n", async ({ cwd, path }) => {
      const { harness } = await readAndEdit(cwd, "t.txt", "a", "A", rawWriteIO());
      expect(await readFile(path, "utf-8")).toBe("A\r\nb\r\nc\r\nd\r\n");

      clearEncodingState(await resolveTarget(path));

      await harness.undoTool.execute("u1", { path: "t.txt" });

      expect(await readFile(path, "utf-8")).toBe("a\r\nb\r\nc\r\nd\r\n");
    });
  });
});
