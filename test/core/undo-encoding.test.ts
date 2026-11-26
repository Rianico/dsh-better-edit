/**
 * #191 — the undo names the codec a migration edit abandoned.
 *
 * A migration edit (`normalizeToUtf8: true` over a recorded legacy encoding) lands UTF-8 bytes
 * where a legacy codec used to be. The revert still writes UTF-8 — it never refuses and never
 * claims the old bytes came back — but it says which codec was abandoned, because silence would
 * claim a restoration that never happened. The verdict is taken once, at the save seam
 * (`prepareForSave`), forwarded through the undo pair (durable on disk, never an in-process memo),
 * and rendered as exactly one clause after the existing mixture clause.
 *
 * Old rows (both new columns NULL) carry no migration and claim none; a stale revert refuses
 * before any disclosure; the store round-trips the verdict across a restart.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import iconv from "iconv-lite";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import { getUndo } from "../../src/undo-edit.js";
import { withWorkspace } from "../../src/workspace-context.js";
import { _resetConfigCache } from "../../src/store-config.js";
import {
  clearEncodingState,
  prepareForSave,
  setEncodingState,
} from "../../src/file-encoding-state.js";
import { persistUndoAndWrite } from "../../src/mutation.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { resolveTarget } from "../../src/paths.js";
import {
  extractHash,
  getText,
  setupIntegrationTest,
  withTempBytes,
  withTempDir,
  withTempFile,
} from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

beforeEach(() => {
  clearEncodingState();
  _resetConfigCache();
  delete process.env.DSH_BETTER_EDIT_NORMALIZE_TO_UTF8;
});

afterEach(() => {
  clearEncodingState();
  _resetConfigCache();
  delete process.env.DSH_BETTER_EDIT_NORMALIZE_TO_UTF8;
});

function setNormalizeToUtf8(value: boolean): void {
  if (value) process.env.DSH_BETTER_EDIT_NORMALIZE_TO_UTF8 = "true";
  else delete process.env.DSH_BETTER_EDIT_NORMALIZE_TO_UTF8;
  _resetConfigCache();
}

/** The served anchors of a read result, keyed by the row's content. */
function anchorsByContent(text: string): Map<string, string> {
  const rows = text.split("\n").filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
  return new Map(rows.map((row) => [row.split("│")[1]!, extractHash(row)]));
}

/** Read, then edit one line by its content; returns the edit's text. */
async function readAndEdit(
  cwd: string,
  name: string,
  from: string,
  to: string,
  readParams?: Record<string, unknown>,
): Promise<{ harness: ReturnType<typeof setupIntegrationTest>; editText: string }> {
  const harness = setupIntegrationTest(cwd);
  const anchors = anchorsByContent(
    getText(await harness.readTool.execute("r1", { path: name, ...readParams })),
  );
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

function utf16leBytes(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

function cp1251Bytes(text: string): Uint8Array {
  return new Uint8Array(iconv.encode(text, "windows-1251"));
}

const UTF16_BOM_CLAUSE =
  "Restored as UTF-8; the pre-edit utf16le encoding and its BOM are not restored.";
const CP1251_CLAUSE = "Restored as UTF-8; the pre-edit windows-1251 encoding is not restored.";

describe("migration — utf16le-with-BOM edit migrates and the undo names the codec", () => {
  it("edit bytes land UTF-8 without BOM, undo bytes match, text restored, clause names utf16le + BOM", async () => {
    await withTempBytes("u16.txt", utf16leBytes("первая\r\nвторая\r\n"), async ({ cwd, path }) => {
      setNormalizeToUtf8(true);
      const { harness } = await readAndEdit(cwd, "u16.txt", "вторая", "другая");

      // The edit migrated: UTF-8 bytes, no BOM.
      const edited = await readFile(path);
      expect(edited.equals(Buffer.from("первая\r\nдругая\r\n", "utf-8"))).toBe(true);

      const text = getText(await harness.undoTool.execute("u1", { path: "u16.txt" }));

      // The revert writes UTF-8 (never the legacy bytes), the content is back, and the
      // clause names the abandoned codec verbatim — plus its BOM.
      expect(await readFile(path, "utf-8")).toBe("первая\r\nвторая\r\n");
      expect([...(await readFile(path)).subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
      expect(text).toContain(UTF16_BOM_CLAUSE);
      expect(text).not.toContain("[E_");
    });
  });

  it("clearing the encoding memo before undo keeps the identical clause and writes no BOM", async () => {
    await withTempBytes(
      "u16-memo.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        setNormalizeToUtf8(true);
        const { harness } = await readAndEdit(cwd, "u16-memo.txt", "вторая", "другая");

        // The verdict rides the durable undo pair, not the in-process memo: dropping the memo
        // must change neither the clause nor the bytes.
        clearEncodingState();

        const text = getText(await harness.undoTool.execute("u1", { path: "u16-memo.txt" }));

        expect(text).toContain(UTF16_BOM_CLAUSE);
        const bytes = await readFile(path);
        expect(bytes.toString("utf-8")).toBe("первая\r\nвторая\r\n");
        expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
      },
    );
  });
});

describe("migration — windows-1251 via read({ encoding })", () => {
  it("a non-ASCII file migrates and the undo names windows-1251 without a BOM claim", async () => {
    await withTempBytes("cp.txt", cp1251Bytes("Привет\nМир\n"), async ({ cwd, path }) => {
      setNormalizeToUtf8(true);
      const { harness } = await readAndEdit(cwd, "cp.txt", "Привет", "Пока", {
        encoding: "windows-1251",
      });

      expect(await readFile(path, "utf-8")).toBe("Пока\nМир\n");

      const text = getText(await harness.undoTool.execute("u1", { path: "cp.txt" }));

      expect(await readFile(path, "utf-8")).toBe("Привет\nМир\n");
      expect(text).toContain(CP1251_CLAUSE);
      expect(text).not.toContain("BOM");
    });
  });

  it("an ASCII-only file recorded as windows-1251: no verdict, no clause, bytes identical", async () => {
    await withTempBytes("ascii.txt", cp1251Bytes("alpha\nbeta\n"), async ({ cwd, path }) => {
      const before = await readFile(path);
      // No normalize flag: a byte-faithful body needs no migration to be writable.
      const { harness } = await readAndEdit(cwd, "ascii.txt", "alpha", "ALPHA", {
        encoding: "windows-1251",
      });
      expect((await readFile(path)).equals(Buffer.from("ALPHA\nbeta\n", "utf-8"))).toBe(true);

      const text = getText(await harness.undoTool.execute("u1", { path: "ascii.txt" }));

      expect((await readFile(path)).equals(before)).toBe(true);
      expect(text).not.toContain("Restored as UTF-8");
    });
  });

  it("an ASCII-only file recorded as windows-1251 with normalize ON: still no verdict, bytes identical", async () => {
    // Mutant caught: `normalize ? { encoding: recorded, hasBOM } : undefined` in place of
    // `faithful ? undefined : { encoding: recorded, hasBOM }` mints a verdict for this faithful
    // body and pushes the clause — this arm pins the faithful gate, not the normalize flag.
    await withTempBytes("ascii-norm.txt", cp1251Bytes("alpha\nbeta\n"), async ({ cwd, path }) => {
      const before = await readFile(path);
      setNormalizeToUtf8(true);
      const { harness } = await readAndEdit(cwd, "ascii-norm.txt", "alpha", "ALPHA", {
        encoding: "windows-1251",
      });
      // The faithful body lands byte-identical UTF-8 bytes with no verdict at any step.
      expect((await readFile(path)).equals(Buffer.from("ALPHA\nbeta\n", "utf-8"))).toBe(true);

      const text = getText(await harness.undoTool.execute("u1", { path: "ascii-norm.txt" }));

      expect((await readFile(path)).equals(before)).toBe(true);
      expect(text).not.toContain("Restored as UTF-8");
    });
  });
});

describe("control — utf8bom round-trips the BOM and claims no migration", () => {
  it("BOM restored, no clause", async () => {
    await withTempBytes(
      "bom.txt",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n", "utf-8")]),
      async ({ cwd, path }) => {
        const { harness } = await readAndEdit(cwd, "bom.txt", "a", "A");

        const text = getText(await harness.undoTool.execute("u1", { path: "bom.txt" }));

        const bytes = await readFile(path);
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(bytes.subarray(3).toString("utf-8")).toBe("a\r\nb\r\n");
        expect(text).not.toContain("Restored as UTF-8");
      },
    );
  });
});

describe("old rows — both new columns NULL mean 'no migration recorded'", () => {
  it("a pre-change pair reads back with no migration and the undo claims none", async () => {
    await withTempBytes(
      "u16-old.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        setNormalizeToUtf8(true);
        const { harness } = await readAndEdit(cwd, "u16-old.txt", "вторая", "другая");
        const abs = await resolveTarget(path);

        // Model the pre-change row: the row exists but carries no verdict. Strip the verdict
        // through the store's own writer, so the shape is exactly what an old store holds.
        await withWorkspace(cwd, async () => {
          const store = await loadHashStore();
          const v7 = store.getFileUndo(abs);
          expect(v7).toBeDefined();
          const {
            migratedFrom: _v,
            migratedFromBOM: _vb,
            ...v7Base
          } = v7 as typeof v7 & { migratedFrom?: unknown; migratedFromBOM?: unknown };
          store.writeUndo(abs, v7Base);

          const entry = await getUndo(abs);
          expect(entry?.migration).toBeUndefined();
        });

        const text = getText(await harness.undoTool.execute("u1", { path: "u16-old.txt" }));
        expect(await readFile(path, "utf-8")).toBe("первая\r\nвторая\r\n");
        expect(text).not.toContain("Restored as UTF-8");
      },
    );
  });
});

describe("staleness — a migrated file that drifted refuses before any disclosure", () => {
  it("E_UNDO_STALE, history cleared, no encoding claim", async () => {
    await withTempBytes(
      "u16-stale.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        setNormalizeToUtf8(true);
        const { harness } = await readAndEdit(cwd, "u16-stale.txt", "вторая", "другая");

        await writeFile(path, "external\n", "utf-8");
        const text = getText(await harness.undoTool.execute("u1", { path: "u16-stale.txt" }));

        expect(text).toContain("[E_UNDO_STALE]");
        expect(text).not.toContain("Restored as UTF-8");
        expect(await readFile(path, "utf-8")).toBe("external\n");
        await withWorkspace(cwd, async () => {
          expect(await getUndo(await resolveTarget(path))).toBeUndefined();
        });
      },
    );
  });
});

describe("storage — the verdict survives a store close + reopen without the memo", () => {
  it("migration round-trips through the on-disk pair", async () => {
    await withTempBytes(
      "u16-store.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        setNormalizeToUtf8(true);
        await readAndEdit(cwd, "u16-store.txt", "вторая", "другая");
        const abs = await resolveTarget(path);

        shutdownHashStore();
        clearEncodingState();

        await withWorkspace(cwd, async () => {
          const entry = await getUndo(abs);
          expect(entry?.migration).toEqual({ encoding: "utf16le", hasBOM: true });
        });
      },
    );
  });

  it("saveUndo callers that name no migration store NULL and read back no claim", async () => {
    await withTempDir("undo-enc-store-", async (dir) => {
      const path = join(dir, "a.txt");
      const { saveUndo } = await import("../../src/undo-edit.js");
      await withWorkspace(dir, async () => {
        await saveUndo(path, {
          content: "a\nb\n",
          bom: "",
          originalEnding: "\n",
          hashes: ["AAA", "BBB"],
          resultContent: "A\nb\n",
        });
        expect((await getUndo(path))?.migration).toBeUndefined();
      });
    });
  });
});

describe("prepareForSave — the verdict fires once, at the save seam", () => {
  it("no migration for the utf8 / utf8bom arms", () => {
    expect(
      prepareForSave(
        "a\n",
        { encoding: "utf8", hasBOM: false, lineEnding: "\n", version: undefined },
        {},
      ).migration,
    ).toBeUndefined();
    expect(
      prepareForSave(
        "a\n",
        { encoding: "utf8bom", hasBOM: true, lineEnding: "\n", version: undefined },
        {},
      ).migration,
    ).toBeUndefined();
  });

  it("no migration for a byte-faithful legacy body", () => {
    expect(
      prepareForSave(
        "plain ascii\n",
        { encoding: "windows-1251", hasBOM: false, lineEnding: "\n", version: undefined },
        {},
      ).migration,
    ).toBeUndefined();
  });

  it("no migration for a byte-faithful legacy body even when normalize is ON", () => {
    // Mutant caught: `normalize ? { encoding: recorded, hasBOM } : undefined` in place of
    // `faithful ? undefined : { encoding: recorded, hasBOM }` mints a verdict here — the
    // faithful gate, not the normalize flag, decides.
    expect(
      prepareForSave(
        "plain ascii\n",
        { encoding: "windows-1251", hasBOM: false, lineEnding: "\n", version: undefined },
        { normalizeToUtf8: true },
      ).migration,
    ).toBeUndefined();
  });

  it("exactly one verdict for a non-faithful legacy body: recorded codec + recorded BOM-ness", () => {
    const utf16 = prepareForSave(
      "первая\n",
      { encoding: "utf16le", hasBOM: true, lineEnding: "\n", version: undefined },
      { normalizeToUtf8: true },
    );
    expect(utf16.migration).toEqual({ encoding: "utf16le", hasBOM: true });

    const cp = prepareForSave(
      "Привет\n",
      { encoding: "windows-1251", hasBOM: false, lineEnding: "\n", version: undefined },
      { normalizeToUtf8: true },
    );
    expect(cp.migration).toEqual({ encoding: "windows-1251", hasBOM: false });
  });
});

describe("half-record — one new column NULL claims nothing", () => {
  it("codec without its BOM flag on the legacy half: no verdict, no clause, undo still restores", async () => {
    // Mutant caught: `typeof migratedFrom === "string" ? { encoding: migratedFrom, ... } : undefined`
    // (BOM flag unchecked) or `||` in place of `&&` rebuilds a verdict from this half-record
    // and pushes the clause — the gate needs BOTH columns fully typed.
    await withTempBytes(
      "u16-half.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        setNormalizeToUtf8(true);
        const { harness } = await readAndEdit(cwd, "u16-half.txt", "вторая", "другая");
        const abs = await resolveTarget(path);
        await withWorkspace(cwd, async () => {
          const store = await loadHashStore();
          expect(store.getUndo(abs)?.migratedFrom).toBe("utf16le");
        });

        // Strip the BOM flag so the stored row is a half-record. `getUndo` rebuilds the verdict
        // from the one row, so both readers are pinned observably below.
        shutdownHashStore();
        const raw = new DatabaseSync(hashStorePath(cwd));
        raw.exec("UPDATE file_undo SET migrated_from = 'utf16le', migrated_from_bom = NULL;");
        raw.close();

        await withWorkspace(cwd, async () => {
          expect((await getUndo(abs))?.migration).toBeUndefined();
          const store = await loadHashStore();
          expect(store.getFileUndo(abs)?.migratedFrom).toBe("utf16le");
          expect(store.getFileUndo(abs)?.migratedFromBOM).toBeNull();
        });

        const text = getText(await harness.undoTool.execute("u1", { path: "u16-half.txt" }));
        expect(await readFile(path, "utf-8")).toBe("первая\r\nвторая\r\n");
        expect(text).not.toContain("Restored as UTF-8");
      },
    );
  });

  it("BOM flag without its codec on the legacy half: no verdict, no clause, undo still restores", async () => {
    // Mutant caught: `typeof migratedFromBOM === "number" ? { ... } : undefined`
    // (codec unchecked) rebuilds a verdict from this reverse half-record — same gate, other side.
    await withTempBytes(
      "u16-half-rev.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        setNormalizeToUtf8(true);
        const { harness } = await readAndEdit(cwd, "u16-half-rev.txt", "вторая", "другая");
        const abs = await resolveTarget(path);

        shutdownHashStore();
        const raw = new DatabaseSync(hashStorePath(cwd));
        raw.exec("UPDATE file_undo SET migrated_from = NULL, migrated_from_bom = 0;");
        raw.close();

        await withWorkspace(cwd, async () => {
          expect((await getUndo(abs))?.migration).toBeUndefined();
          const store = await loadHashStore();
          expect(store.getFileUndo(abs)?.migratedFrom).toBeNull();
          expect(store.getFileUndo(abs)?.migratedFromBOM).toBe(0);
        });

        const text = getText(await harness.undoTool.execute("u1", { path: "u16-half-rev.txt" }));
        expect(await readFile(path, "utf-8")).toBe("первая\r\nвторая\r\n");
        expect(text).not.toContain("Restored as UTF-8");
      },
    );
  });
});

describe("transaction — persistUndoAndWrite forwards the verdict", () => {
  it("returns the populated AppliedMigration for a migrated file", async () => {
    // Mutant caught: `return []` / dropping `prep.migration` in `persistUndoAndWrite` keeps the
    // write+memo correct while silencing the return — this pins the populated arm (`[]` alone is
    // already pinned at `coverage-agent-c-mutation-engine.test.ts`).
    await withTempDir("undo-enc-applied-", async (dir) => {
      const abs = join(dir, "u16.txt");
      setNormalizeToUtf8(true);
      setEncodingState(abs, {
        encoding: "utf16le",
        hasBOM: true,
        lineEnding: "\n",
        version: undefined,
      });
      const io = { writeText: async () => undefined };
      const sandbox = { mapError: (error: unknown) => error as Error };
      const applied = await withWorkspace(dir, () =>
        persistUndoAndWrite({
          io: io as never,
          files: [
            {
              absolutePath: abs,
              displayPath: "u16.txt",
              originalNormalized: "первая\n",
              bom: "",
              originalEnding: "\n",
              effectiveEnding: "\n",
              preImageMixed: false,
              originalHashes: ["AAA"],
              result: "другая\n",
            },
          ],
          exec: {} as never,
          sandbox: sandbox as never,
          sandboxPolicy: undefined,
          undoUnavailableMessage: () => "x",
        }),
      );
      expect(applied).toEqual([
        { displayPath: "u16.txt", migration: { encoding: "utf16le", hasBOM: true } },
      ]);
    });
  });
});
