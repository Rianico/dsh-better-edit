/**
 * #209 — the `edit` payload carries a per-call encoding-migration consent.
 *
 * A legacy-encoded file (utf16le, windows-1251, …) is writable only when a write may
 * abandon its codec; before #209 that decision belonged to the fleet alone
 * (`normalizeToUtf8`). The payload key `allow_encoding_migration` lets ONE call decide:
 * `"refuse"` never converts, `"utf8"` converts without a BOM, `"utf8bom"` converts and
 * writes the Windows-readable target. Precedence is one ladder — payload > the
 * `allowEncodingMigration` setting (`DSH_BETTER_EDIT_ALLOW_ENCODING_MIGRATION`) > the legacy
 * `normalizeToUtf8` spelling > `"refuse"`.
 *
 * External behaviour first: every case below drives the public `read` / `edit` /
 * `undo_last_edit` tools and pins on-disk bytes, notice text and the presence of an undo row.
 * The resolver's unit block is the one place that names the ladder directly; the config-file
 * block writes the YAML a real install carries, so the persisted rungs (and the absence that
 * makes the legacy spelling reachable) are pinned against the file, not against a mock.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import iconv from "iconv-lite";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { clearEncodingState } from "../../src/file-encoding-state.js";
import { _resetConfigCache, loadConfig } from "../../src/store-config.js";
import { assertEditRequest, editRequestFrom, normalizeRequest } from "../../src/contract.js";
import {
  ENCODING_MIGRATION_CONSENTS,
  ENCODING_MIGRATION_DEFAULT,
  ENCODING_MIGRATION_ENV_VAR,
  isEncodingMigrationConsent,
  parseEnvEncodingMigrationConsent,
  resolveEncodingMigrationConsent,
} from "../../src/encoding-consent.js";
import { localIO } from "../../src/fs-bridge.js";
import type { FileIO } from "../../src/fs-bridge.js";
import { extractHash, getText, setupIntegrationTest, withTempBytes } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

/** Every env rung a case here can lean on; cleared around each test so cases stay independent. */
const MANAGED_ENV_VARS = [
  "DSH_BETTER_EDIT_NORMALIZE_TO_UTF8",
  "DSH_BETTER_EDIT_ALLOW_ENCODING_MIGRATION",
  "DSH_BETTER_EDIT_AUTO_GUESS_ENCODING",
  "DSH_BETTER_EDIT_EOL",
  "DSH_BETTER_EDIT_SPAN_MODE",
] as const;

function resetEnv(): void {
  for (const name of MANAGED_ENV_VARS) delete process.env[name];
  clearEncodingState();
  _resetConfigCache();
}

beforeEach(resetEnv);
afterEach(resetEnv);

/** Write the plugin's config.yaml into the isolated temp home (`withTempBytes` points HOME there). */
async function writeConfigFile(cwd: string, yaml: string): Promise<string> {
  const dir = join(cwd, ".dsh", "plugins", "dsh-better-edit");
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, "config.yaml");
  await writeFile(configPath, yaml, "utf-8");
  // The env/cache layer reads once; drop it so the file just written is what the next load sees.
  _resetConfigCache();
  return configPath;
}

function setEnvSetting(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  _resetConfigCache();
}

type ToolResult = { content: Array<{ text?: string }> };

const NOTICE_MARK = "[W_ENCODING_MIGRATED]";

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The served anchors of a read result, keyed by the row's content. */
function anchorsByContent(text: string): Map<string, string> {
  const rows = text.split("\n").filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
  return new Map(rows.map((row) => [row.split("│")[1]!, extractHash(row)]));
}

interface EditCaseOptions {
  read?: Record<string, unknown>;
  edit?: Record<string, unknown>;
  io?: FileIO;
}

/** Read, then edit one line by its content; returns the FULL edit result text. */
async function readAndEdit(
  cwd: string,
  name: string,
  from: string,
  to: string,
  options: EditCaseOptions = {},
): Promise<{ harness: ReturnType<typeof setupIntegrationTest>; editText: string }> {
  const harness = setupIntegrationTest(cwd, options.io);
  const anchors = anchorsByContent(
    getText(await harness.readTool.execute("r1", { path: name, ...options.read })),
  );
  const anchor = anchors.get(from);
  expect(anchor, `read served no row for ${JSON.stringify(from)}`).toBeDefined();
  const editText = getText(
    await harness.editTool.execute("e1", {
      file: name,
      edits: [{ anchor_from: anchor!, anchor_to: anchor!, replace_with: to }],
      ...options.edit,
    }),
  );
  return { harness, editText };
}

/** The multi-item payload form: one real item, one bogus anchor. */
async function readAndBatch(
  cwd: string,
  name: string,
  from: string,
  to: string,
  edit: Record<string, unknown>,
  io?: FileIO,
): Promise<{ harness: ReturnType<typeof setupIntegrationTest>; attempt: Promise<ToolResult> }> {
  const harness = setupIntegrationTest(cwd, io);
  const anchors = anchorsByContent(getText(await harness.readTool.execute("r1", { path: name })));
  const anchor = anchors.get(from);
  expect(anchor, `read served no row for ${JSON.stringify(from)}`).toBeDefined();
  const attempt = harness.editTool.execute("e1", {
    file: name,
    edits: [
      { anchor_from: anchor!, anchor_to: anchor!, replace_with: to },
      { anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "bogus" },
    ],
    ...edit,
  }) as Promise<ToolResult>;
  return { harness, attempt };
}

async function expectNoUndoRow(
  harness: ReturnType<typeof setupIntegrationTest>,
  name: string,
): Promise<void> {
  expect(getText(await harness.undoTool.execute("u1", { path: name }))).toContain(
    "No undo history",
  );
}

function utf16leBytes(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

function cp1251Bytes(text: string): Uint8Array {
  return new Uint8Array(iconv.encode(text, "windows-1251"));
}

const UTF16_TEXT = "первая\r\nвторая\r\n";
const UTF16_EDITED = "первая\r\nдругая\r\n";

describe("no consent anywhere — the legacy refusal stands", () => {
  it("default config refuses utf16le+BOM: E_ENCODING_UNWRITABLE, bytes unchanged, no undo row", async () => {
    await withTempBytes("u16-default.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      const before = await readFile(path);
      const harness = setupIntegrationTest(cwd);
      const anchors = anchorsByContent(
        getText(await harness.readTool.execute("r1", { path: "u16-default.txt" })),
      );
      const anchor = anchors.get("вторая");
      expect(anchor).toBeDefined();

      const attempt = harness.editTool.execute("e1", {
        file: "u16-default.txt",
        edits: [{ anchor_from: anchor!, anchor_to: anchor!, replace_with: "другая" }],
      });
      await expect(attempt).rejects.toMatchObject({ code: "E_ENCODING_UNWRITABLE" });
      expect((await readFile(path)).equals(before)).toBe(true);
      await expectNoUndoRow(harness, "u16-default.txt");
    });
  });
});

describe("payload consent converts one file without changing fleet policy", () => {
  it('"utf8" lands UTF-8 without a BOM and announces exactly one migration naming the codec', async () => {
    await withTempBytes("u16-utf8.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      const { editText } = await readAndEdit(cwd, "u16-utf8.txt", "вторая", "другая", {
        edit: { allow_encoding_migration: "utf8" },
      });

      expect(editText).toContain(
        "[MODEL] [W_ENCODING_MIGRATED] Migrated u16-utf8.txt from utf16le (with BOM) to UTF-8. " +
          "Undo restores the text, not the encoding.",
      );
      expect(countOf(editText, NOTICE_MARK)).toBe(1);

      const edited = await readFile(path);
      expect(edited.equals(Buffer.from(UTF16_EDITED, "utf-8"))).toBe(true);
      expect(edited[0]).not.toBe(0xef);
    });
  });

  it('"utf8bom" writes EF BB BF and the next read is a plain, notice-free read', async () => {
    await withTempBytes("u16-bom.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      const { harness, editText } = await readAndEdit(cwd, "u16-bom.txt", "вторая", "другая", {
        edit: { allow_encoding_migration: "utf8bom" },
      });

      expect(countOf(editText, NOTICE_MARK)).toBe(1);
      expect(editText).toContain("Migrated u16-bom.txt from utf16le (with BOM)");

      const edited = await readFile(path);
      expect([...edited.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      // Exactly one BOM: the seam prepares this write twice (transaction + IO bridge).
      expect(edited.subarray(3).toString("utf-8")).toBe(UTF16_EDITED);

      const reRead = getText(await harness.readTool.execute("r2", { path: "u16-bom.txt" }));
      expect(reRead).toContain("другая");
      expect(reRead).not.toContain(NOTICE_MARK);
    });
  });

  it('payload "refuse" vetoes a fleet "utf8": nothing is converted and no undo row appears', async () => {
    await withTempBytes("u16-veto.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      const before = await readFile(path);
      setEnvSetting(ENCODING_MIGRATION_ENV_VAR, "utf8");

      const harness = setupIntegrationTest(cwd);
      const anchors = anchorsByContent(
        getText(await harness.readTool.execute("r1", { path: "u16-veto.txt" })),
      );
      const anchor = anchors.get("вторая");
      expect(anchor).toBeDefined();

      const attempt = harness.editTool.execute("e1", {
        file: "u16-veto.txt",
        edits: [{ anchor_from: anchor!, anchor_to: anchor!, replace_with: "другая" }],
        allow_encoding_migration: "refuse",
      });
      await expect(attempt).rejects.toMatchObject({ code: "E_ENCODING_UNWRITABLE" });
      expect((await readFile(path)).equals(before)).toBe(true);
      await expectNoUndoRow(harness, "u16-veto.txt");
    });
  });
});

describe("config ladder — the payload-less rungs", () => {
  it("fleet allowEncodingMigration=utf8 converts a windows-1251 file with no payload key", async () => {
    await withTempBytes("cp-fleet.txt", cp1251Bytes("Привет\nМир\n"), async ({ cwd, path }) => {
      setEnvSetting(ENCODING_MIGRATION_ENV_VAR, "utf8");
      const { editText } = await readAndEdit(cwd, "cp-fleet.txt", "Привет", "Пока", {
        read: { encoding: "windows-1251" },
      });

      expect(countOf(editText, NOTICE_MARK)).toBe(1);
      expect(editText).toContain("Migrated cp-fleet.txt from windows-1251 (no BOM) to UTF-8");
      expect(await readFile(path, "utf-8")).toBe("Пока\nМир\n");
    });
  });

  it("explicit allowEncodingMigration=refuse outranks the legacy normalizeToUtf8 spelling", async () => {
    await withTempBytes(
      "u16-explicit-refuse.txt",
      utf16leBytes(UTF16_TEXT),
      async ({ cwd, path }) => {
        const before = await readFile(path);
        setEnvSetting(ENCODING_MIGRATION_ENV_VAR, "refuse");
        setEnvSetting("DSH_BETTER_EDIT_NORMALIZE_TO_UTF8", "true");

        const harness = setupIntegrationTest(cwd);
        const anchors = anchorsByContent(
          getText(await harness.readTool.execute("r1", { path: "u16-explicit-refuse.txt" })),
        );
        const anchor = anchors.get("вторая");
        expect(anchor).toBeDefined();

        const attempt = harness.editTool.execute("e1", {
          file: "u16-explicit-refuse.txt",
          edits: [{ anchor_from: anchor!, anchor_to: anchor!, replace_with: "другая" }],
        });
        await expect(attempt).rejects.toMatchObject({ code: "E_ENCODING_UNWRITABLE" });
        expect((await readFile(path)).equals(before)).toBe(true);
        await expectNoUndoRow(harness, "u16-explicit-refuse.txt");
      },
    );
  });

  it("control: the legacy normalizeToUtf8=true spelling alone still converts to UTF-8", async () => {
    await withTempBytes("u16-legacy.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      setEnvSetting("DSH_BETTER_EDIT_NORMALIZE_TO_UTF8", "true");
      const { editText } = await readAndEdit(cwd, "u16-legacy.txt", "вторая", "другая");

      expect(countOf(editText, NOTICE_MARK)).toBe(1);
      const edited = await readFile(path);
      expect(edited.equals(Buffer.from(UTF16_EDITED, "utf-8"))).toBe(true);
    });
  });
});

describe("config ladder — the persisted config-file rungs", () => {
  it("allowEncodingMigration: utf8bom in config.yaml writes EF BB BF and pushes one notice", async () => {
    await withTempBytes("u16-cfg-bom.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      await writeConfigFile(cwd, "allowEncodingMigration: utf8bom\n");
      expect(loadConfig().allowEncodingMigration).toBe("utf8bom");

      const { editText } = await readAndEdit(cwd, "u16-cfg-bom.txt", "вторая", "другая");

      expect(countOf(editText, NOTICE_MARK)).toBe(1);
      expect(editText).toContain("Migrated u16-cfg-bom.txt from utf16le (with BOM) to UTF-8.");
      const edited = await readFile(path);
      expect([...edited.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(edited.subarray(3).toString("utf-8")).toBe(UTF16_EDITED);
    });
  });

  it("normalizeToUtf8: true alone keeps allowEncodingMigration absent through load and complement", async () => {
    await withTempBytes("u16-cfg-legacy.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      const configPath = await writeConfigFile(cwd, "normalizeToUtf8: true\n");

      // The absence is what makes the legacy spelling reachable (ADR-0052 §4): loading must
      // neither default the key nor materialize it into the file via the complement pass.
      const cfg = loadConfig();
      expect(cfg.normalizeToUtf8).toBe(true);
      expect(cfg.allowEncodingMigration).toBeUndefined();
      expect(await readFile(configPath, "utf-8")).not.toMatch(/^allowEncodingMigration:/m);

      // …and the resulting consent is the legacy `"utf8"` rung: no BOM.
      const { editText } = await readAndEdit(cwd, "u16-cfg-legacy.txt", "вторая", "другая");
      expect(countOf(editText, NOTICE_MARK)).toBe(1);
      const edited = await readFile(path);
      expect(edited.equals(Buffer.from(UTF16_EDITED, "utf-8"))).toBe(true);
    });
  });
});

describe("a wrong payload value is refused by name", () => {
  it("an out-of-enum value is answered before the contract runs, and nothing converts", async () => {
    await withTempBytes("cp-bad-wire.txt", cp1251Bytes("Привет\nМир\n"), async ({ cwd, path }) => {
      const before = await readFile(path);
      // A fleet consent is set so a silently DROPPED bad value would migrate instead of refusing.
      setEnvSetting(ENCODING_MIGRATION_ENV_VAR, "utf8");
      const harness = setupIntegrationTest(cwd);
      const anchors = anchorsByContent(
        getText(
          await harness.readTool.execute("r1", {
            path: "cp-bad-wire.txt",
            encoding: "windows-1251",
          }),
        ),
      );
      const anchor = anchors.get("Привет");
      expect(anchor).toBeDefined();

      // `null` is an out-of-enum value here, not a spelling of absent: the wire enum is closed.
      for (const bad of [null, "utf8BOM", "migrate", true, 1]) {
        const attempt = harness.editTool.execute("e1", {
          file: "cp-bad-wire.txt",
          edits: [{ anchor_from: anchor!, anchor_to: anchor!, replace_with: "Пока" }],
          allow_encoding_migration: bad,
        });
        // The declared wire schema is the first gate (dsh refuses a value outside the string enum
        // exactly as it does for a non-boolean `dry_run`), so the value never reaches the contract.
        // The enum-naming refusal is the contract's own boundary, pinned in the next case.
        await expect(attempt).rejects.toMatchObject({ code: "INVALID_ARGS" });
        expect((await readFile(path)).equals(before)).toBe(true);
      }
      await expectNoUndoRow(harness, "cp-bad-wire.txt");
    });
  });

  it("the contract boundary refuses every wrong value with a message naming refuse/utf8/utf8bom", () => {
    for (const bad of [null, "utf8BOM", "migrate", true, 1, {}]) {
      const request = {
        file: "sample.ts",
        edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
        allow_encoding_migration: bad,
      };
      expect(editRequestFrom(request)).toBeUndefined();
      let message = "";
      try {
        assertEditRequest(normalizeRequest(request));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("E_BAD_PAYLOAD");
      expect(message).toContain("allow_encoding_migration");
      for (const consent of ENCODING_MIGRATION_CONSENTS) {
        expect(message).toContain(`"${consent}"`);
      }
    }
  });

  it("a valid consent survives the fold and an absent one stays absent", () => {
    const payload = {
      file: "sample.ts",
      edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
    };
    expect(editRequestFrom({ ...payload, allow_encoding_migration: "utf8bom" })).toMatchObject({
      allow_encoding_migration: "utf8bom",
    });
    expect(editRequestFrom(payload)).not.toHaveProperty("allow_encoding_migration");
  });
});

describe("a byte-faithful body is never converted", () => {
  it('ASCII recorded as windows-1251 + payload "utf8bom": no BOM, no notice, bytes are the edit result', async () => {
    await withTempBytes("cp-ascii.txt", cp1251Bytes("alpha\nbeta\n"), async ({ cwd, path }) => {
      const { editText } = await readAndEdit(cwd, "cp-ascii.txt", "alpha", "ALPHA", {
        read: { encoding: "windows-1251" },
        edit: { allow_encoding_migration: "utf8bom" },
      });

      expect(editText).not.toContain(NOTICE_MARK);
      const edited = await readFile(path);
      expect(edited.equals(Buffer.from("ALPHA\nbeta\n", "utf-8"))).toBe(true);
      expect(edited[0]).not.toBe(0xef);
    });
  });
});

describe("calls that write nothing convert nothing", () => {
  it('dry_run + payload "utf8": [DRY RUN], no notice, no undo row, bytes unchanged', async () => {
    await withTempBytes("u16-dry.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      const before = await readFile(path);
      const { harness, editText } = await readAndEdit(cwd, "u16-dry.txt", "вторая", "другая", {
        edit: { dry_run: true, allow_encoding_migration: "utf8" },
      });

      expect(editText.split("\n")[0]).toMatch(/^\[DRY RUN\] /);
      expect(editText).not.toContain(NOTICE_MARK);
      expect((await readFile(path)).equals(before)).toBe(true);
      await expectNoUndoRow(harness, "u16-dry.txt");
    });
  });

  it("multi-item call whose second item is bogus: E_BATCH_ABORT, bytes unchanged, no undo row", async () => {
    await withTempBytes("u16-abort.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      const before = await readFile(path);
      const { harness, attempt } = await readAndBatch(cwd, "u16-abort.txt", "вторая", "другая", {
        allow_encoding_migration: "utf8",
      });

      await expect(attempt).rejects.toMatchObject({ code: "E_BATCH_ABORT" });
      expect((await readFile(path)).equals(before)).toBe(true);
      await expectNoUndoRow(harness, "u16-abort.txt");
    });
  });
});

describe('undo after a "utf8bom" migration', () => {
  it("restores the content behind one BOM and names the abandoned codec", async () => {
    await withTempBytes("u16-undo-bom.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      const { harness } = await readAndEdit(cwd, "u16-undo-bom.txt", "вторая", "другая", {
        edit: { allow_encoding_migration: "utf8bom" },
      });

      const undoText = getText(await harness.undoTool.execute("u1", { path: "u16-undo-bom.txt" }));
      expect(undoText).toContain(
        "Restored as UTF-8; the pre-edit utf16le encoding and its BOM are not restored.",
      );

      const restored = await readFile(path);
      expect([...restored.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(restored.subarray(3).toString("utf-8")).toBe(UTF16_TEXT);
    });
  });

  it("a DSH backend that restores the UTF-8 BOM on read does not read as externally modified", async () => {
    // The local backend strips a decoded BOM; `ctxFsIO` restores it (issue #23). Emulating that here
    // is what exercises the migrated-arm staleness tolerance: the undo pair's `bom` column records
    // the ABANDONED codec's BOM, so without the tolerance the tool's own target looks foreign.
    const base = localIO();
    const dshLike: FileIO = {
      ...base,
      async readText(absolutePath, signal, encoding) {
        const text = await base.readText(absolutePath, signal, encoding);
        if (encoding !== undefined || text.startsWith("\uFEFF")) return text;
        const bytes = await readFile(absolutePath);
        const hasUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
        return hasUtf8Bom ? `\uFEFF${text}` : text;
      },
    };

    await withTempBytes("u16-undo-dsh.txt", utf16leBytes(UTF16_TEXT), async ({ cwd, path }) => {
      const { harness } = await readAndEdit(cwd, "u16-undo-dsh.txt", "вторая", "другая", {
        edit: { allow_encoding_migration: "utf8bom" },
        io: dshLike,
      });

      const undoText = getText(await harness.undoTool.execute("u1", { path: "u16-undo-dsh.txt" }));
      expect(undoText).not.toContain("E_UNDO_STALE");
      expect(undoText).toContain("Restored as UTF-8; the pre-edit utf16le encoding");

      const restored = await readFile(path);
      expect([...restored.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(restored.subarray(3).toString("utf-8")).toBe(UTF16_TEXT);
    });
  });
});

describe("resolver — one ladder: payload > config > legacy > refuse", () => {
  it("the payload rung wins over every config rung", () => {
    expect(
      resolveEncodingMigrationConsent("refuse", {
        allowEncodingMigration: "utf8bom",
        normalizeToUtf8: true,
      }),
    ).toBe("refuse");
    expect(resolveEncodingMigrationConsent("utf8bom", { allowEncodingMigration: "refuse" })).toBe(
      "utf8bom",
    );
  });

  it("the config rung wins over the legacy spelling (and `false` is not a choice)", () => {
    expect(
      resolveEncodingMigrationConsent(undefined, {
        allowEncodingMigration: "refuse",
        normalizeToUtf8: true,
      }),
    ).toBe("refuse");
    expect(
      resolveEncodingMigrationConsent(undefined, {
        allowEncodingMigration: "utf8bom",
        normalizeToUtf8: false,
      }),
    ).toBe("utf8bom");
  });

  it("normalizeToUtf8:true is the utf8 rung; false or absent fall through to refuse", () => {
    expect(resolveEncodingMigrationConsent(undefined, { normalizeToUtf8: true })).toBe("utf8");
    expect(resolveEncodingMigrationConsent(undefined, { normalizeToUtf8: false })).toBe("refuse");
    expect(resolveEncodingMigrationConsent(undefined, {})).toBe("refuse");
    expect(ENCODING_MIGRATION_DEFAULT).toBe("refuse");
  });

  it("pins the leaf vocabulary and the env parser", () => {
    expect(ENCODING_MIGRATION_CONSENTS).toEqual(["refuse", "utf8", "utf8bom"]);
    expect(ENCODING_MIGRATION_ENV_VAR).toBe("DSH_BETTER_EDIT_ALLOW_ENCODING_MIGRATION");

    expect(isEncodingMigrationConsent("refuse")).toBe(true);
    expect(isEncodingMigrationConsent("utf8bom")).toBe(true);
    expect(isEncodingMigrationConsent("UTF8")).toBe(false);
    expect(isEncodingMigrationConsent("")).toBe(false);
    expect(isEncodingMigrationConsent(undefined)).toBe(false);
    expect(isEncodingMigrationConsent(null)).toBe(false);

    expect(parseEnvEncodingMigrationConsent(" utf8bom ")).toBe("utf8bom");
    expect(parseEnvEncodingMigrationConsent("REFUSE")).toBe("refuse");
    expect(parseEnvEncodingMigrationConsent("migrate")).toBeUndefined();
    expect(parseEnvEncodingMigrationConsent("")).toBeUndefined();
    expect(parseEnvEncodingMigrationConsent(undefined)).toBeUndefined();
  });
});
