/**
 * #193 — the encoding matrix, end to end through the public tools only.
 *
 * T1 (#191) gave the revert its migration clause and T2 (#192) gave the applied result its
 * migration notice. Those two claims only hold together if the bytes and both disclosures agree
 * in the same run, so this spec drives `read`, `edit` and `undo_last_edit` through their tool
 * seams — never the engine — and pins the bytes on disk plus the result text per case.
 *
 * Every case asserts BOTH columns: the on-disk bytes (`readFile` with no encoding, compared
 * as a `Buffer`) and the tool result text. The warning vocabulary under test is small on
 * purpose — one applied-tier code (`[W_ENCODING_MIGRATED]`, audience included) next to the
 * EOL tier it follows — and every assertion names the exact rendered line, not a substring
 * of it, except where a count pins the shape instead.
 *
 * Harness model: `test/integration/eol-matrix.test.ts` — the same `textOf`/`countOf` joins
 * (a notice carries on a block after the diff, so the matrix asserts the summary block
 * carries the warning, never that the text ends with it) and the same UTF-16LE/Windows-1251
 * byte fixtures as `test/core/undo-encoding.test.ts`. Nothing here duplicates the store
 * round-trip unit (`undo-encoding.test.ts` owns the on-disk pair); case 6 drops only the
 * in-process memo, which is the restart-shaped half of that same guarantee.
 */
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import iconv from "iconv-lite";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { clearEncodingState } from "../../src/file-encoding-state.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { shutdownHashStore } from "../../src/hash-store.js";
import { getUndo } from "../../src/undo-edit.js";
import { resolveTarget } from "../../src/paths.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { withWorkspace } from "../../src/workspace-context.js";
import { extractHash, getText, setupIntegrationTest, withTempBytes } from "../support/fixtures.js";

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

type ToolResult = { content: Array<{ text?: string }> };

/** Every text block of a tool result — a notice carries on a block after the diff. */
function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

/** Occurrences of a literal substring: an applied notice appears exactly once. */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The applied tier's audience-bearing header for a landed migration. */
const MIGRATED_MARK = "[W_ENCODING_MIGRATED]";
/** The applied tier's audience-bearing header for a landed EOL rewrite. */
const REWRITTEN_MARK = "[W_EOL_REWRITTEN]";
/** The exact undo-tool sentence when no pair exists. */
const NO_HISTORY = "No undo history";
/** The UTF-8 BOM as bytes: a migration never writes it, a control always keeps it. */
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** The served anchors of a read result, keyed by the row's content. */
function anchorsByContent(text: string): Map<string, string> {
  const rows = text.split("\n").filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
  return new Map(rows.map((row) => [row.split("│")[1]!, extractHash(row)]));
}

/** Read, then edit one line by its content; returns the FULL edit result text. */
async function readAndEdit(
  cwd: string,
  name: string,
  from: string,
  to: string,
  readParams?: Record<string, unknown>,
): Promise<{ harness: ReturnType<typeof setupIntegrationTest>; editText: string }> {
  const harness = setupIntegrationTest(cwd);
  const anchors = anchorsByContent(
    textOf(await harness.readTool.execute("r1", { path: name, ...readParams })),
  );
  const anchor = anchors.get(from);
  expect(anchor, `read served no row for ${JSON.stringify(from)}`).toBeDefined();
  const editText = textOf(
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

const UTF16_EDIT_NOTICE =
  "[MODEL] [W_ENCODING_MIGRATED] Migrated u16.txt from utf16le (with BOM) to UTF-8. " +
  "Undo restores the text, not the encoding.";
const UTF16_UNDO_CLAUSE =
  "Restored as UTF-8; the pre-edit utf16le encoding and its BOM are not restored.";
const CP1251_EDIT_NOTICE =
  "[MODEL] [W_ENCODING_MIGRATED] Migrated cp.txt from windows-1251 (no BOM) to UTF-8. " +
  "Undo restores the text, not the encoding.";
const CP1251_UNDO_CLAUSE = "Restored as UTF-8; the pre-edit windows-1251 encoding is not restored.";

describe("opt-in utf16le+BOM read, edit and undo", () => {
  it("edit bytes land UTF-8 without BOM; edit carries the with-BOM notice; undo bytes match; undo carries the naming clause", async () => {
    await withTempBytes("u16.txt", utf16leBytes("первая\r\nвторая\r\n"), async ({ cwd, path }) => {
      setNormalizeToUtf8(true);
      const { harness, editText } = await readAndEdit(cwd, "u16.txt", "вторая", "другая");

      expect(editText).toContain(UTF16_EDIT_NOTICE);
      expect(countOf(editText, MIGRATED_MARK)).toBe(1);

      const edited = await readFile(path);
      expect(edited.equals(Buffer.from("первая\r\nдругая\r\n", "utf-8"))).toBe(true);
      expect([...edited.subarray(0, 3)]).not.toEqual(UTF8_BOM);

      const undoText = getText(await harness.undoTool.execute("u1", { path: "u16.txt" }));

      expect(undoText).toContain(UTF16_UNDO_CLAUSE);
      expect(undoText).not.toContain("[E_");
      const reverted = await readFile(path);
      expect(reverted.equals(Buffer.from("первая\r\nвторая\r\n", "utf-8"))).toBe(true);
      expect([...reverted.subarray(0, 3)]).not.toEqual(UTF8_BOM);
    });
  });
});

describe("opt-in windows-1251 read({ encoding }), edit and undo", () => {
  it("names windows-1251 with the file's BOM state; bytes land and revert as UTF-8", async () => {
    await withTempBytes("cp.txt", cp1251Bytes("Привет\nМир\n"), async ({ cwd, path }) => {
      setNormalizeToUtf8(true);
      const { harness, editText } = await readAndEdit(cwd, "cp.txt", "Привет", "Пока", {
        encoding: "windows-1251",
      });

      expect(editText).toContain(CP1251_EDIT_NOTICE);
      expect(countOf(editText, MIGRATED_MARK)).toBe(1);
      expect(await readFile(path)).toEqual(Buffer.from("Пока\nМир\n", "utf-8"));

      const undoText = getText(await harness.undoTool.execute("u1", { path: "cp.txt" }));

      expect(undoText).toContain(CP1251_UNDO_CLAUSE);
      expect(undoText).not.toContain("its BOM");
      expect(await readFile(path)).toEqual(Buffer.from("Привет\nМир\n", "utf-8"));
    });
  });
});

describe("windows-1251 ASCII-only under the opt-in", () => {
  it("no edit notice, no undo clause, bytes identical at every step", async () => {
    await withTempBytes("ascii.txt", cp1251Bytes("alpha\nbeta\n"), async ({ cwd, path }) => {
      const before = await readFile(path);
      setNormalizeToUtf8(true);
      const { harness, editText } = await readAndEdit(cwd, "ascii.txt", "alpha", "ALPHA", {
        encoding: "windows-1251",
      });

      // The faithful body is already UTF-8 byte-for-byte: nothing migrated, so nothing is announced.
      expect(editText).not.toContain(MIGRATED_MARK);
      expect((await readFile(path)).equals(Buffer.from("ALPHA\nbeta\n", "utf-8"))).toBe(true);

      const undoText = getText(await harness.undoTool.execute("u1", { path: "ascii.txt" }));

      expect(undoText).not.toContain("Restored as UTF-8");
      expect((await readFile(path)).equals(before)).toBe(true);
    });
  });
});

describe("UTF-8+BOM control", () => {
  it("the BOM round-trips through edit and undo; neither carries an encoding disclosure", async () => {
    await withTempBytes(
      "bom.txt",
      Buffer.concat([Buffer.from(UTF8_BOM), Buffer.from("a\r\nb\r\n", "utf-8")]),
      async ({ cwd, path }) => {
        const { harness, editText } = await readAndEdit(cwd, "bom.txt", "a", "A");

        expect(editText).not.toContain(MIGRATED_MARK);
        const edited = await readFile(path);
        expect([...edited.subarray(0, 3)]).toEqual(UTF8_BOM);
        expect(edited.subarray(3).equals(Buffer.from("A\r\nb\r\n", "utf-8"))).toBe(true);

        const undoText = getText(await harness.undoTool.execute("u1", { path: "bom.txt" }));

        expect(undoText).not.toContain("Restored as UTF-8");
        const reverted = await readFile(path);
        expect([...reverted.subarray(0, 3)]).toEqual(UTF8_BOM);
        expect(reverted.subarray(3).equals(Buffer.from("a\r\nb\r\n", "utf-8"))).toBe(true);
      },
    );
  });
});

describe("default config on a legacy file", () => {
  it("refuses E_ENCODING_UNWRITABLE; bytes untouched; no undo row", async () => {
    await withTempBytes(
      "u16-refuse.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        const before = await readFile(path);
        const harness = setupIntegrationTest(cwd);
        const anchors = anchorsByContent(
          textOf(await harness.readTool.execute("r1", { path: "u16-refuse.txt" })),
        );
        const anchor = anchors.get("вторая");
        expect(anchor).toBeDefined();

        await expect(
          harness.editTool.execute("e1", {
            path: "u16-refuse.txt",
            anchor_from: anchor!,
            anchor_to: anchor!,
            replace_with: "другая",
          }),
        ).rejects.toMatchObject({ code: "E_ENCODING_UNWRITABLE" });

        expect((await readFile(path)).equals(before)).toBe(true);
        expect(getText(await harness.undoTool.execute("u1", { path: "u16-refuse.txt" }))).toContain(
          NO_HISTORY,
        );
      },
    );
  });
});

describe("restart between a migration edit and its undo", () => {
  it("dropping the memo keeps the identical clause and writes no BOM", async () => {
    await withTempBytes(
      "u16-restart.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        setNormalizeToUtf8(true);
        const { harness, editText } = await readAndEdit(cwd, "u16-restart.txt", "вторая", "другая");
        expect(countOf(editText, MIGRATED_MARK)).toBe(1);

        // The verdict rides the durable undo pair, not the in-process memo.
        clearEncodingState();

        const undoText = getText(await harness.undoTool.execute("u1", { path: "u16-restart.txt" }));

        expect(undoText).toContain(UTF16_UNDO_CLAUSE);
        const reverted = await readFile(path);
        expect(reverted.equals(Buffer.from("первая\r\nвторая\r\n", "utf-8"))).toBe(true);
        expect([...reverted.subarray(0, 3)]).not.toEqual(UTF8_BOM);
      },
    );
  });
});

describe("aborting batch with a migrating item", () => {
  it("nothing is written, no notice rides anywhere, no undo row exists", async () => {
    await withTempBytes(
      "u16-batch.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        const before = await readFile(path);
        setNormalizeToUtf8(true);
        const harness = setupIntegrationTest(cwd);
        const anchors = anchorsByContent(
          textOf(await harness.readTool.execute("r1", { path: "u16-batch.txt" })),
        );
        const anchor = anchors.get("вторая");
        expect(anchor).toBeDefined();

        await expect(
          harness.editTool.execute("e1", {
            file: "u16-batch.txt",
            edits: [
              { anchor_from: anchor!, anchor_to: anchor!, replace_with: "другая" },
              { anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "bogus" },
            ],
          }),
        ).rejects.toMatchObject({ code: "E_BATCH_ABORT" });

        // The abort throws before any applied-tier warning exists; the observable halves of
        // "announced nothing" are the untouched bytes and the missing undo row.
        expect((await readFile(path)).equals(before)).toBe(true);
        expect(getText(await harness.undoTool.execute("u1", { path: "u16-batch.txt" }))).toContain(
          NO_HISTORY,
        );
      },
    );
  });
});

describe("pre-change row with both migration columns NULL", () => {
  it("the undo restores content with no encoding claim", async () => {
    await withTempBytes(
      "u16-old.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        setNormalizeToUtf8(true);
        const { harness } = await readAndEdit(cwd, "u16-old.txt", "вторая", "другая");
        const abs = await resolveTarget(path);

        // Model the pre-change row: the pair exists but carries no verdict on either half.
        shutdownHashStore();
        const raw = new DatabaseSync(hashStorePath(cwd));
        raw.exec(
          "UPDATE undo SET migrated_from = NULL, migrated_from_bom = NULL; " +
            "UPDATE file_undo SET migrated_from = NULL, migrated_from_bom = NULL;",
        );
        raw.close();

        await withWorkspace(cwd, async () => {
          expect((await getUndo(abs))?.migration).toBeUndefined();
        });

        const undoText = getText(await harness.undoTool.execute("u1", { path: "u16-old.txt" }));

        expect(await readFile(path)).toEqual(Buffer.from("первая\r\nвторая\r\n", "utf-8"));
        expect(undoText).not.toContain("Restored as UTF-8");
      },
    );
  });
});

describe("stale revert after a migration edit", () => {
  it("refuses E_UNDO_STALE, clears the history, claims no encoding", async () => {
    await withTempBytes(
      "u16-stale.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        setNormalizeToUtf8(true);
        const { harness } = await readAndEdit(cwd, "u16-stale.txt", "вторая", "другая");
        const abs = await resolveTarget(path);

        await writeFile(path, "external\n", "utf-8");
        const undoText = getText(await harness.undoTool.execute("u1", { path: "u16-stale.txt" }));

        expect(undoText).toContain("[E_UNDO_STALE]");
        expect(undoText).not.toContain("Restored as UTF-8");
        expect(await readFile(path)).toEqual(Buffer.from("external\n", "utf-8"));
        await withWorkspace(cwd, async () => {
          expect(await getUndo(abs)).toBeUndefined();
        });
      },
    );
  });
});

describe("multi-item applied payload on a migrating file", () => {
  it("one two-range file+edits call carries exactly one migration notice", async () => {
    // Refutability: this is the only success-path coverage of the multi-item applied branch in
    // `src/mutation.ts` (`pushAppliedWriteNotices` after the multi-item commit). Emptying that
    // call silences this notice while the single-call branch keeps working.
    await withTempBytes(
      "u16m.txt",
      utf16leBytes("первая\r\nвторая\r\nтретья\r\n"),
      async ({ cwd, path }) => {
        setNormalizeToUtf8(true);
        const harness = setupIntegrationTest(cwd);
        const anchors = anchorsByContent(
          textOf(await harness.readTool.execute("r1", { path: "u16m.txt" })),
        );
        const second = anchors.get("вторая");
        const third = anchors.get("третья");
        expect(second).toBeDefined();
        expect(third).toBeDefined();

        const editText = textOf(
          await harness.editTool.execute("e1", {
            file: "u16m.txt",
            edits: [
              { anchor_from: second!, anchor_to: second!, replace_with: "ДРУГАЯ" },
              { anchor_from: third!, anchor_to: third!, replace_with: "ТРЕТЬЯ" },
            ],
          }),
        );

        expect(editText).toContain(
          "[MODEL] [W_ENCODING_MIGRATED] Migrated u16m.txt from utf16le (with BOM) to UTF-8. " +
            "Undo restores the text, not the encoding.",
        );
        expect(countOf(editText, MIGRATED_MARK)).toBe(1);
        expect(await readFile(path)).toEqual(
          Buffer.from("первая\r\nДРУГАЯ\r\nТРЕТЬЯ\r\n", "utf-8"),
        );
      },
    );
  });
});

describe("EOL rewrite before the encoding notice", () => {
  it("a mixed-endings migration carries both notices with the EOL one first, exactly once", async () => {
    // Refutability: `pushAppliedWriteNotices` pushes the EOL notice before the migration notices.
    // Swapping the two pushes keeps every count green while the order inverts, so this case pins
    // the order, not just the presence.
    await withTempBytes(
      "u16mix.txt",
      utf16leBytes("первая\r\nвторая\nтретья\r\n"),
      async ({ cwd, path }) => {
        setNormalizeToUtf8(true);
        const { editText } = await readAndEdit(cwd, "u16mix.txt", "вторая", "другая");

        expect(editText).toContain(
          "[MODEL] [W_EOL_REWRITTEN] EOL normalized to CRLF (file): 1 terminators changed. " +
            "Undo restores normalized content.",
        );
        expect(editText).toContain(
          "[MODEL] [W_ENCODING_MIGRATED] Migrated u16mix.txt from utf16le (with BOM) to UTF-8. " +
            "Undo restores the text, not the encoding.",
        );
        expect(countOf(editText, MIGRATED_MARK)).toBe(1);
        expect(editText.indexOf(REWRITTEN_MARK)).toBeLessThan(editText.indexOf(MIGRATED_MARK));
        expect(await readFile(path)).toEqual(
          Buffer.from("первая\r\nдругая\r\nтретья\r\n", "utf-8"),
        );
      },
    );
  });
});
