/**
 * #192 — the edit announces a migration it landed.
 *
 * A migration edit (`normalizeToUtf8: true` over a recorded legacy encoding) lands UTF-8 bytes
 * where a legacy codec used to be. The write is legal but not invisible: the applied result
 * carries one `[MODEL] [W_ENCODING_MIGRATED]` line — the abandoned codec and its BOM state —
 * pushed only after the write landed (next to the EOL notice), and never for a call that wrote
 * nothing (refusal, batch abort, dry run, byte-faithful no-op, all-noop, non-migrating file).
 *
 * Subject choice: `undo-encoding.test.ts` owns the REVERT clause ("Restored as UTF-8; …");
 * this file owns the EDIT notice ("Migrated … to UTF-8. …"). One subject per file.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import iconv from "iconv-lite";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { clearEncodingState } from "../../src/file-encoding-state.js";
import { _resetConfigCache } from "../../src/store-config.js";
import {
  extractHash,
  getText,
  setupIntegrationTest,
  withTempBytes,
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

type ToolResult = { content: Array<{ text?: string }> };

/** Every text block of a tool result — the notice can ride a block after the diff. */
function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

/** Occurrences of a literal substring: an applied notice must appear exactly once. */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const NOTICE_MARK = "[W_ENCODING_MIGRATED]";

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

describe("migrating write — utf16le+BOM announces exactly once", () => {
  it("names path/codec/BOM state and the undo-text-not-encoding fact; bytes land UTF-8 without BOM", async () => {
    await withTempBytes("u16.txt", utf16leBytes("первая\r\nвторая\r\n"), async ({ cwd, path }) => {
      setNormalizeToUtf8(true);
      const { editText } = await readAndEdit(cwd, "u16.txt", "вторая", "другая");

      expect(editText).toContain(
        "[MODEL] [W_ENCODING_MIGRATED] Migrated u16.txt from utf16le (with BOM) to UTF-8. " +
          "Undo restores the text, not the encoding.",
      );
      expect(countOf(editText, NOTICE_MARK)).toBe(1);

      const edited = await readFile(path);
      expect(edited.equals(Buffer.from("первая\r\nдругая\r\n", "utf-8"))).toBe(true);
    });
  });
});

describe("migrating write — windows-1251 via read({ encoding })", () => {
  it("names windows-1251 with the file's BOM state (no BOM here)", async () => {
    await withTempBytes("cp.txt", cp1251Bytes("Привет\nМир\n"), async ({ cwd, path }) => {
      setNormalizeToUtf8(true);
      const { editText } = await readAndEdit(cwd, "cp.txt", "Привет", "Пока", {
        encoding: "windows-1251",
      });

      expect(editText).toContain(
        "[MODEL] [W_ENCODING_MIGRATED] Migrated cp.txt from windows-1251 (no BOM) to UTF-8. " +
          "Undo restores the text, not the encoding.",
      );
      expect(countOf(editText, NOTICE_MARK)).toBe(1);
      expect(await readFile(path, "utf-8")).toBe("Пока\nМир\n");
    });
  });
});

describe("two files — exactly one notice, naming only the migrating path", () => {
  it("the legacy file announces; the UTF-8 file stays silent", async () => {
    await withTempBytes(
      "legacy.txt",
      cp1251Bytes("Привет\nМир\n"),
      async ({ cwd, path: legacyPath }) => {
        await writeFile(join(cwd, "plain.txt"), "alpha\nbeta\n", "utf-8");
        setNormalizeToUtf8(true);

        const migrated = await readAndEdit(cwd, "legacy.txt", "Привет", "Пока", {
          encoding: "windows-1251",
        });
        const untouched = await readAndEdit(cwd, "plain.txt", "alpha", "ALPHA");

        expect(countOf(migrated.editText, NOTICE_MARK)).toBe(1);
        expect(migrated.editText).toContain("Migrated legacy.txt from windows-1251");
        expect(migrated.editText).not.toContain("plain.txt");
        expect(untouched.editText).not.toContain(NOTICE_MARK);
        expect(await readFile(legacyPath, "utf-8")).toBe("Пока\nМир\n");
      },
    );
  });
});

describe("non-migrating writes stay silent", () => {
  it("UTF-8 and UTF-8-BOM edits announce nothing; the BOM round-trips", async () => {
    await withTempFile("u8.txt", "a\nb\n", async ({ cwd, path }) => {
      const { editText } = await readAndEdit(cwd, "u8.txt", "a", "A");
      expect(editText).not.toContain(NOTICE_MARK);
      expect(await readFile(path, "utf-8")).toBe("A\nb\n");
    });
    await withTempBytes(
      "bom.txt",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\nb\n", "utf-8")]),
      async ({ cwd, path }) => {
        const { editText } = await readAndEdit(cwd, "bom.txt", "a", "A");
        expect(editText).not.toContain(NOTICE_MARK);
        const bytes = await readFile(path);
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(bytes.subarray(3).toString("utf-8")).toBe("A\nb\n");
      },
    );
  });

  it("windows-1251 ASCII-only with normalize ON: no notice, bytes unchanged", async () => {
    await withTempBytes("ascii.txt", cp1251Bytes("alpha\nbeta\n"), async ({ cwd, path }) => {
      const before = await readFile(path);
      setNormalizeToUtf8(true);
      const { editText } = await readAndEdit(cwd, "ascii.txt", "alpha", "ALPHA", {
        encoding: "windows-1251",
      });
      expect(editText).not.toContain(NOTICE_MARK);
      expect((await readFile(path)).equals(Buffer.from("ALPHA\nbeta\n", "utf-8"))).toBe(true);
      expect(before.equals(Buffer.from("alpha\nbeta\n", "utf-8"))).toBe(true);
    });
  });
});

describe("calls that write nothing announce nothing", () => {
  it("default config on UTF-16LE: E_ENCODING_UNWRITABLE, no notice, nothing written", async () => {
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

        const attempt = harness.editTool.execute("e1", {
          path: "u16-refuse.txt",
          anchor_from: anchor!,
          anchor_to: anchor!,
          replace_with: "другая",
        });
        await expect(attempt).rejects.toMatchObject({ code: "E_ENCODING_UNWRITABLE" });
        const error = await attempt.catch((e: unknown) => e);
        expect((error as Error).message).toContain("[E_ENCODING_UNWRITABLE]");
        expect(getText(await harness.undoTool.execute("u1", { path: "u16-refuse.txt" }))).toContain(
          "No undo history",
        );
        expect((await readFile(path)).equals(before)).toBe(true);
      },
    );
  });

  it("migrating batch with a refusing item: E_BATCH_ABORT, nothing written, no notice", async () => {
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

        const attempt = harness.editTool.execute("e1", {
          file: "u16-batch.txt",
          edits: [
            { anchor_from: anchor!, anchor_to: anchor!, replace_with: "другая" },
            { anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "bogus" },
          ],
        });
        await expect(attempt).rejects.toMatchObject({ code: "E_BATCH_ABORT" });
        expect(getText(await harness.undoTool.execute("u1", { path: "u16-batch.txt" }))).toContain(
          "No undo history",
        );
        expect((await readFile(path)).equals(before)).toBe(true);
      },
    );
  });

  it("dry_run on a would-migrate file: [DRY RUN], no notice, no undo row, bytes unchanged", async () => {
    await withTempBytes(
      "u16-dry.txt",
      utf16leBytes("первая\r\nвторая\r\n"),
      async ({ cwd, path }) => {
        const before = await readFile(path);
        setNormalizeToUtf8(true);
        const harness = setupIntegrationTest(cwd);
        const anchors = anchorsByContent(
          textOf(await harness.readTool.execute("r1", { path: "u16-dry.txt" })),
        );
        const anchor = anchors.get("вторая");
        expect(anchor).toBeDefined();

        const preview = textOf(
          await harness.editTool.execute("e1", {
            file: "u16-dry.txt",
            dry_run: true,
            edits: [{ anchor_from: anchor!, anchor_to: anchor!, replace_with: "другая" }],
          }),
        );
        expect(preview.split("\n")[0]).toMatch(/^\[DRY RUN\] /);
        expect(preview).not.toContain(NOTICE_MARK);
        expect((await readFile(path)).equals(before)).toBe(true);
        expect(getText(await harness.undoTool.execute("u1", { path: "u16-dry.txt" }))).toContain(
          "No undo history",
        );
      },
    );
  });

  it("all-noop on a migrated file: no notice", async () => {
    await withTempBytes("u16-noop.txt", utf16leBytes("первая\r\nвторая\r\n"), async ({ cwd }) => {
      setNormalizeToUtf8(true);
      const first = await readAndEdit(cwd, "u16-noop.txt", "вторая", "другая");
      expect(countOf(first.editText, NOTICE_MARK)).toBe(1);

      const second = await readAndEdit(cwd, "u16-noop.txt", "другая", "другая");
      expect(second.editText).not.toContain(NOTICE_MARK);
    });
  });
});
