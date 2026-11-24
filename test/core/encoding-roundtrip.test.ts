/**
 * #112 — the write side consumes the recorded encoding, and refuses loudly when the
 * recorded encoding cannot be reproduced through the text-only write seam.
 *
 * Every mutating read (`edit`, `str_replace_editor`, the undo staleness check) must
 * pass the memo's encoding as its decode hint, so a file admitted by
 * `read({ encoding })` is addressable by its anchors. When the bytes cannot be
 * written back byte-faithfully (UTF-16LE, windows-1251 non-ASCII), the mutation
 * fails BEFORE any write with `E_ENCODING_UNWRITABLE`, naming the text-only write
 * limitation and the `normalizeToUtf8: true` remedy. The file is left untouched.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import iconv from "iconv-lite";

import {
  clearEncodingState,
  getEncodingState,
  prepareForSave,
} from "../../src/file-encoding-state.js";
import { localIO } from "../../src/fs-bridge.js";
import { shutdownHashStore } from "../../src/hash-store.js";
import { buildStrReplaceEditorTool } from "../../src/tool-str-replace-editor.js";
import { saveUndo, getUndo } from "../../src/undo-edit.js";
import { persistUndoAndWrite } from "../../src/mutation.js";
import { initHasher, lineHashes } from "../../src/hashline/index.js";
import { resolveTarget } from "../../src/paths.js";
import { withWorkspace } from "../../src/workspace-context.js";
import { _resetConfigCache } from "../../src/store-config.js";
import {
  getText,
  makeExec,
  makeTestSandbox,
  setupIntegrationTest,
  withHome,
} from "../support/fixtures.js";

/**
 * Teardown-ordering control for the spec-local fixture. The two module stubs below
 * delegate every production call unchanged; they only observe whether the hash store
 * closed before the temp dir was removed, and let one pin inject a Windows-style
 * unlink failure.
 */
const teardown = vi.hoisted(() => ({
  failRmWith: undefined as Error | undefined,
  rmTarget: undefined as string | undefined,
  shutdownCalls: 0,
  shutdownCallsAtRm: -1,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      teardown.rmTarget = String(args[0]);
      teardown.shutdownCallsAtRm = teardown.shutdownCalls;
      if (teardown.failRmWith !== undefined) throw teardown.failRmWith;
      return actual.rm(...args);
    },
  };
});

vi.mock("../../src/hash-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hash-store.js")>();
  return {
    ...actual,
    shutdownHashStore: () => {
      teardown.shutdownCalls += 1;
      actual.shutdownHashStore();
    },
  };
});

beforeAll(async () => {
  await initHasher();
});

const UTF16_TEXT = "первая строка\nвторая строка\n";
const CP1251_TEXT = "Привет\nМир\n";

function utf16leBytes(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

function cp1251Bytes(text: string): Uint8Array {
  return new Uint8Array(iconv.encode(text, "windows-1251"));
}

function anchorsByContent(text: string): Map<string, string> {
  const rows = text.split("\n").filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
  return new Map(rows.map((row) => [row.split("│")[1]!, row.slice(0, 3)]));
}

/** The memo is keyed by the canonical path (macOS /var resolves under /private). */
async function memoFor(path: string) {
  return getEncodingState(await resolveTarget(path));
}

/**
 * The shared `withHome` owns HOME/DSH_HOME only. On Windows `os.homedir()` — which
 * `store-config`'s `homeBase()` falls back to when HOME is empty — reads USERPROFILE,
 * so this spec's fixture must own that variable too. Spec-local on purpose: the
 * shared helper's contract is not this ticket's surface.
 */
function withSpecHome(home: string): () => void {
  const previousProfile = process.env.USERPROFILE;
  const restoreShared = withHome(home);
  process.env.USERPROFILE = home;
  return () => {
    restoreShared();
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  };
}

/** Isolated cwd + HOME so the hash store and undo history never touch the developer's home. */
async function withTempBytes(
  name: string,
  bytes: Uint8Array,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "enc-roundtrip-"));
  const path = join(cwd, name);
  const restoreHome = withSpecHome(cwd);
  try {
    await writeFile(path, bytes);
    await run({ cwd, path });
  } finally {
    clearEncodingState();
    _resetConfigCache();
    delete process.env.DSH_BETTER_EDIT_NORMALIZE_TO_UTF8;
    // Windows refuses to unlink an open `hash-store.sqlite` (EBUSY), so the store
    // must close before the directory goes away (upstream 9937e18).
    shutdownHashStore();
    try {
      await rm(cwd, { recursive: true, force: true });
    } finally {
      // Unconditional: a failed rm must not leak the mutated HOME/DSH_HOME.
      restoreHome();
    }
  }
}

function setNormalizeToUtf8(value: boolean): void {
  if (value) process.env.DSH_BETTER_EDIT_NORMALIZE_TO_UTF8 = "true";
  else delete process.env.DSH_BETTER_EDIT_NORMALIZE_TO_UTF8;
  _resetConfigCache();
}

beforeEach(() => {
  clearEncodingState();
  _resetConfigCache();
  delete process.env.DSH_BETTER_EDIT_NORMALIZE_TO_UTF8;
  delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
});

describe("prepareForSave — round-trip verdict", () => {
  it("refuses a recorded UTF-16LE state before any write, naming the remedy", () => {
    expect(() =>
      prepareForSave(
        UTF16_TEXT,
        { encoding: "utf16le", hasBOM: true, lineEnding: "\n", version: undefined },
        {},
      ),
    ).toThrow(/E_ENCODING_UNWRITABLE[\s\S]*normalizeToUtf8/);
  });

  it("refuses a recorded BOM when the recorded encoding is not UTF-8", () => {
    // A legacy BOM (`utf16le` FF FE, or read({encoding}) on a UTF-8-BOM file) is a
    // byte image a UTF-8 string write cannot reproduce — even for empty content.
    expect(() =>
      prepareForSave(
        "",
        { encoding: "utf16le", hasBOM: true, lineEnding: "\n", version: undefined },
        {},
      ),
    ).toThrow(/E_ENCODING_UNWRITABLE/);
  });

  it("refuses a manual non-UTF-8 hint over a recorded BOM", () => {
    expect(() =>
      prepareForSave(
        "plain ascii\n",
        { encoding: "utf8bom", hasBOM: true, lineEnding: "\n", version: undefined },
        { encodingHint: "windows-1251" },
      ),
    ).toThrow(/E_ENCODING_UNWRITABLE/);
  });

  it("refuses a recorded windows-1251 state for non-ASCII content", () => {
    expect(() =>
      prepareForSave(
        CP1251_TEXT,
        { encoding: "windows-1251", hasBOM: false, lineEnding: "\n", version: undefined },
        {},
      ),
    ).toThrow(/E_ENCODING_UNWRITABLE/);
  });

  it("writes a byte-faithful ASCII file recorded as windows-1251 (bytes, not the name)", () => {
    const prep = prepareForSave(
      "plain ascii\n",
      { encoding: "windows-1251", hasBOM: false, lineEnding: "\n", version: undefined },
      {},
    );
    expect(prep.textToWrite).toBe("plain ascii\n");
    // The written bytes are UTF-8, so the memo must describe UTF-8 afterwards.
    expect(prep.newState?.encoding).toBe("utf8");
    expect(prep.newState?.hasBOM).toBe(false);
  });

  it("migrates to UTF-8 with normalizeToUtf8, dropping the legacy BOM", () => {
    const prep = prepareForSave(
      "первая строка\r\n",
      { encoding: "utf16le", hasBOM: true, lineEnding: "\r\n", version: undefined },
      { normalizeToUtf8: true },
    );
    expect(prep.textToWrite).toBe("первая строка\r\n");
    expect(prep.textToWrite.startsWith("\uFEFF")).toBe(false);
    expect(prep.newState?.encoding).toBe("utf8");
    expect(prep.newState?.hasBOM).toBe(false);
  });

  it("keeps the UTF-8-BOM + line-ending round-trip untouched", () => {
    const prep = prepareForSave(
      "a\r\nb\r\n",
      { encoding: "utf8bom", hasBOM: true, lineEnding: "\r\n", version: undefined },
      {},
    );
    expect(prep.textToWrite).toBe("\uFEFFa\r\nb\r\n");
  });
});

describe("edit — recorded encoding round-trip", () => {
  it("refuses a UTF-16LE-with-BOM edit untouched when normalizeToUtf8 is false", async () => {
    await withTempBytes("utf16.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const before = await readFile(path);
      const readText = getText(await readTool.execute("r1", { path: "utf16.txt" }));
      expect(readText).toContain("первая строка");
      const anchors = anchorsByContent(readText);
      expect((await memoFor(path))?.encoding).toBe("utf16le");

      await expect(
        editTool.execute("e1", {
          path: "utf16.txt",
          anchor_from: anchors.get("первая строка")!,
          anchor_to: anchors.get("первая строка")!,
          replace_with: "изменённая строка",
        }),
      ).rejects.toThrow(/\[E_ENCODING_UNWRITABLE\][\s\S]*normalizeToUtf8/);

      expect((await readFile(path)).equals(before)).toBe(true);
    });
  });

  it("migrates a UTF-16LE file to UTF-8 with normalizeToUtf8:true and flips the memo", async () => {
    await withTempBytes("utf16-migrate.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      setNormalizeToUtf8(true);
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const readText = getText(await readTool.execute("r1", { path: "utf16-migrate.txt" }));
      const anchors = anchorsByContent(readText);

      const edited = await editTool.execute("e1", {
        path: "utf16-migrate.txt",
        anchor_from: anchors.get("первая строка")!,
        anchor_to: anchors.get("первая строка")!,
        replace_with: "изменённая строка",
      });
      expect(getText(edited)).toContain("Successfully edited");

      const written = await readFile(path, "utf-8");
      expect(written).toBe("изменённая строка\nвторая строка\n");
      // BOM dropped by the migration, and the memo describes the bytes just written.
      expect((await memoFor(path))?.encoding).toBe("utf8");
      expect((await memoFor(path))?.hasBOM).toBe(false);

      const reread = getText(await readTool.execute("r2", { path: "utf16-migrate.txt" }));
      expect(reread).toContain("изменённая строка");
      expect((await memoFor(path))?.encoding).toBe("utf8");
    });
  });

  it("refuses a windows-1251 file served by read({encoding}) with the same typed refusal", async () => {
    await withTempBytes("cp1251.txt", cp1251Bytes(CP1251_TEXT), async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const before = await readFile(path);
      const readText = getText(
        await readTool.execute("r1", { path: "cp1251.txt", encoding: "windows-1251" }),
      );
      expect(readText).toContain("Привет");
      const anchors = anchorsByContent(readText);

      await expect(
        editTool.execute("e1", {
          path: "cp1251.txt",
          anchor_from: anchors.get("Привет")!,
          anchor_to: anchors.get("Привет")!,
          replace_with: "Пока",
        }),
      ).rejects.toThrow(/\[E_ENCODING_UNWRITABLE\][\s\S]*normalizeToUtf8/);

      expect((await readFile(path)).equals(before)).toBe(true);
    });
  });

  it("migrates a windows-1251 file with normalizeToUtf8:true", async () => {
    await withTempBytes("cp1251-migrate.txt", cp1251Bytes(CP1251_TEXT), async ({ cwd, path }) => {
      setNormalizeToUtf8(true);
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const readText = getText(
        await readTool.execute("r1", { path: "cp1251-migrate.txt", encoding: "windows-1251" }),
      );
      const anchors = anchorsByContent(readText);

      const edited = await editTool.execute("e1", {
        path: "cp1251-migrate.txt",
        anchor_from: anchors.get("Привет")!,
        anchor_to: anchors.get("Привет")!,
        replace_with: "Пока",
      });
      expect(getText(edited)).toContain("Successfully edited");

      expect(await readFile(path, "utf-8")).toBe("Пока\nМир\n");
      expect((await memoFor(path))?.encoding).toBe("utf8");
    });
  });

  it("keeps an ASCII-only file recorded as windows-1251 editable", async () => {
    await withTempBytes("ascii-cp1251.txt", cp1251Bytes("alpha\nbeta\n"), async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const readText = getText(
        await readTool.execute("r1", { path: "ascii-cp1251.txt", encoding: "windows-1251" }),
      );
      const anchors = anchorsByContent(readText);

      const edited = await editTool.execute("e1", {
        path: "ascii-cp1251.txt",
        anchor_from: anchors.get("alpha")!,
        anchor_to: anchors.get("alpha")!,
        replace_with: "ALPHA",
      });
      expect(getText(edited)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("ALPHA\nbeta\n");
      expect((await memoFor(path))?.encoding).toBe("utf8");
    });
  });

  it("leaves UTF-8 and UTF-8-BOM content, BOM, and line endings exactly as today", async () => {
    await withTempBytes("plain.txt", Buffer.from("a\r\nb\r\n", "utf-8"), async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const readText = getText(await readTool.execute("r1", { path: "plain.txt" }));
      const anchors = anchorsByContent(readText);
      await editTool.execute("e1", {
        path: "plain.txt",
        anchor_from: anchors.get("a")!,
        anchor_to: anchors.get("a")!,
        replace_with: "A",
      });
      expect(await readFile(path, "utf-8")).toBe("A\r\nb\r\n");
    });

    await withTempBytes(
      "bom.txt",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n", "utf-8")]),
      async ({ cwd, path }) => {
        const { readTool, editTool } = setupIntegrationTest(cwd);
        const readText = getText(await readTool.execute("r1", { path: "bom.txt" }));
        const anchors = anchorsByContent(readText);
        await editTool.execute("e1", {
          path: "bom.txt",
          anchor_from: anchors.get("a")!,
          anchor_to: anchors.get("a")!,
          replace_with: "A",
        });
        const bytes = await readFile(path);
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(bytes.subarray(3).toString("utf-8")).toBe("A\r\nb\r\n");
        expect((await memoFor(path))?.encoding).toBe("utf8bom");
        expect((await memoFor(path))?.hasBOM).toBe(true);
      },
    );
  });
});

describe("str_replace_editor — recorded encoding round-trip", () => {
  it("refuses a UTF-16LE replacement before any write", async () => {
    await withTempBytes("sre.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      const io = localIO();
      const tool = buildStrReplaceEditorTool(io, makeTestSandbox());
      const exec = makeExec(cwd);
      const before = await readFile(path);
      await setupIntegrationTest(cwd).readTool.execute("r1", { path: "sre.txt" });

      await expect(
        tool.execute(
          {
            command: "str_replace",
            path: "sre.txt",
            old_str: "вторая строка",
            new_str: "замена",
          },
          exec({}) as never,
        ),
      ).rejects.toThrow(/\[E_ENCODING_UNWRITABLE\][\s\S]*normalizeToUtf8/);

      expect((await readFile(path)).equals(before)).toBe(true);
    });
  });

  it("refuses a windows-1251 replacement served by read({encoding})", async () => {
    await withTempBytes("sre-cp.txt", cp1251Bytes(CP1251_TEXT), async ({ cwd, path }) => {
      const io = localIO();
      const tool = buildStrReplaceEditorTool(io, makeTestSandbox());
      const exec = makeExec(cwd);
      const before = await readFile(path);
      const harness = setupIntegrationTest(cwd);
      await harness.readTool.execute("r1", { path: "sre-cp.txt", encoding: "windows-1251" });

      await expect(
        tool.execute(
          { command: "str_replace", path: "sre-cp.txt", old_str: "Мир", new_str: "свет" },
          exec({}) as never,
        ),
      ).rejects.toThrow(/\[E_ENCODING_UNWRITABLE\]/);

      expect((await readFile(path)).equals(before)).toBe(true);
    });
  });
});

describe("undo_last_edit — staleness read consumes the recorded encoding", () => {
  it("does not report a bogus E_UNDO_STALE on a windows-1251 file; refusals are the same typed error", async () => {
    await withTempBytes("undo-cp.txt", cp1251Bytes(CP1251_TEXT), async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      await harness.readTool.execute("r1", { path: "undo-cp.txt", encoding: "windows-1251" });
      const before = await readFile(path);
      await withWorkspace(cwd, async () => {
        // The undo store keys by the canonical path the tools resolve to.
        const canonical = await resolveTarget(path);
        const hashes = await lineHashes(CP1251_TEXT, canonical);
        await saveUndo(canonical, {
          content: CP1251_TEXT,
          bom: "",
          originalEnding: "\n",
          hashes,
          resultContent: CP1251_TEXT,
        });
      });

      // The staleness read must decode with the recorded windows-1251 hint: the bytes are
      // unchanged since the undo record, so E_UNDO_STALE would be a false "modified". The
      // revert itself cannot be written back through the text seam, so it refuses instead.
      await expect(harness.undoTool.execute("u1", { path: "undo-cp.txt" })).rejects.toThrow(
        /\[E_ENCODING_UNWRITABLE\][\s\S]*normalizeToUtf8/,
      );
      expect((await readFile(path)).equals(before)).toBe(true);
    });
  });
});

describe("transaction — the round-trip verdict precedes every write", () => {
  it("writes nothing and persists no undo when a later file cannot round-trip", async () => {
    await withTempBytes("batch-a.txt", Buffer.from("alpha\n", "utf-8"), async ({ cwd }) => {
      const bPath = await resolveTarget(join(cwd, "batch-b.txt"));
      await writeFile(bPath, utf16leBytes(UTF16_TEXT));
      const aPath = await resolveTarget(join(cwd, "batch-a.txt"));
      const io = localIO();
      let writes = 0;
      const spied = {
        ...io,
        writeText: async (...args: Parameters<typeof io.writeText>): Promise<void> => {
          writes += 1;
          return io.writeText(...args);
        },
      };
      // Read the UTF-16LE file so the memo records its encoding for the transaction.
      await io.readText(bPath);
      expect((await memoFor(bPath))?.encoding).toBe("utf16le");

      const files = [
        {
          absolutePath: aPath,
          displayPath: "batch-a.txt",
          originalNormalized: "alpha\n",
          bom: "",
          originalEnding: "\n" as const,
          effectiveEnding: "\n" as const,
          preImageMixed: false,
          originalHashes: [] as string[],
          result: "ALPHA\n",
        },
        {
          absolutePath: bPath,
          displayPath: "batch-b.txt",
          originalNormalized: UTF16_TEXT,
          bom: "",
          originalEnding: "\n" as const,
          effectiveEnding: "\n" as const,
          preImageMixed: false,
          originalHashes: [] as string[],
          result: "изменённая строка\nвторая строка\n",
        },
      ];

      await withWorkspace(cwd, async () => {
        await expect(
          persistUndoAndWrite({
            io: spied,
            files,
            exec: makeExec(cwd)({}),
            sandbox: makeTestSandbox(),
            sandboxPolicy: undefined,
            undoUnavailableMessage: () => "[E_UNDO_UNAVAILABLE] unreachable",
          }),
        ).rejects.toThrow(/E_ENCODING_UNWRITABLE[\s\S]*normalizeToUtf8/);
      });

      // File A would have been written first; the refusal for B must land before it.
      expect(writes).toBe(0);
      expect(await readFile(aPath, "utf-8")).toBe("alpha\n");
      await withWorkspace(cwd, async () => {
        expect(await getUndo(aPath)).toBeUndefined();
      });
    });
  });
});

describe("fixture teardown — Windows-safe ordering", () => {
  it("closes the hash store before removing the temp dir, and restores the env when rm fails", async () => {
    const failure = new Error("EBUSY: simulated Windows unlink of an open hash-store.sqlite");
    const previous = {
      HOME: process.env.HOME,
      DSH_HOME: process.env.DSH_HOME,
      USERPROFILE: process.env.USERPROFILE,
    };
    teardown.failRmWith = failure;
    teardown.shutdownCalls = 0;
    teardown.shutdownCallsAtRm = -1;
    try {
      await expect(
        withTempBytes("teardown.txt", Buffer.from("a\n", "utf-8"), async () => {
          // No-op body: the pin is about teardown ordering only.
        }),
      ).rejects.toBe(failure);

      // Ordering, not luck: the store closed exactly once before rm was attempted.
      expect(teardown.shutdownCallsAtRm).toBe(1);
      expect(teardown.rmTarget).toMatch(/enc-roundtrip-/);
      // A failed rm must not leak the mutated home into later tests.
      expect(process.env.HOME).toBe(previous.HOME);
      expect(process.env.DSH_HOME).toBe(previous.DSH_HOME);
      expect(process.env.USERPROFILE).toBe(previous.USERPROFILE);
    } finally {
      teardown.failRmWith = undefined;
      if (teardown.rmTarget !== undefined) {
        await rm(teardown.rmTarget, { recursive: true, force: true });
      }
      teardown.shutdownCalls = 0;
      teardown.shutdownCallsAtRm = -1;
    }
  });
});
