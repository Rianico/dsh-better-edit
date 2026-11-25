/**
 * #169 — one effective EOL decides the write, and an EOL-changing write says so.
 *
 * The pre-image terminator counts are taken ONCE, where the file is decoded, and
 * they decide three things together: the terminator the write uses (`env` >
 * `config` > the file's dominant one > the OS), whether the pre-image was mixed,
 * and how many terminators the write actually rewrites. A rewrite is lossless but
 * not invisible: the applied result carries one `W_EOL_REWRITTEN` line, pushed
 * only after the write landed, and never for an all-noop call.
 *
 * `write` and `str_replace_editor` never pass the new option, so their bytes are
 * unchanged; this spec measures the `edit` path byte-for-byte in both directions
 * (what landed, and what the model was told).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { prepareForSave } from "../../src/file-encoding-state.js";
import { persistUndoAndWrite } from "../../src/mutation.js";
import * as undoMod from "../../src/undo-edit.js";
import { localIO } from "../../src/fs-bridge.js";
import { runFileEdits } from "../../src/mutation/engine.js";
import { resolveTarget } from "../../src/paths.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { withWorkspace } from "../../src/workspace-context.js";
import { setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/** The terminator a file with no terminator of its own gets on this platform. */
const SYSTEM_ENDING = process.platform === "win32" ? "\r\n" : "\n";

const WARNING_MARK = "[W_EOL_REWRITTEN]";

beforeAll(async () => {
  await initHasher();
});

afterEach(() => {
  _resetConfigCache();
  delete process.env.DSH_BETTER_EDIT_EOL;
});

type ToolResult = { content: Array<{ text?: string }> };

/** Every text block of a tool result — the warning can ride a block after the diff. */
function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

/** Occurrences of a literal substring: an applied warning must appear exactly once. */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const ANCHOR_ROW = /^([A-Za-z0-9]{3})│(.*)$/;

/** The served anchors of a read result, keyed by the row's content. */
function anchorsByContent(text: string): Map<string, string> {
  const rows: RegExpExecArray[] = [];
  for (const line of text.split("\n")) {
    const match = ANCHOR_ROW.exec(line);
    if (match !== null) rows.push(match);
  }
  return new Map(rows.map((match) => [match[2]!, match[1]!]));
}

/** Seed the plugin YAML config with one `eol` setting, before any read (cache large). */
async function seedEol(cwd: string, setting: "AUTO" | "LF" | "CRLF" | "CR"): Promise<void> {
  const dir = join(cwd, ".dsh", "plugins", "dsh-better-edit");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.yaml"), `eol: ${setting}\n`, "utf-8");
  _resetConfigCache();
}

/** Read then edit one single-line range, returning the edit result text. */
async function readAndEditLine(
  cwd: string,
  name: string,
  line: string,
  replacement: string,
): Promise<string> {
  const { readTool, editTool } = setupIntegrationTest(cwd);
  const anchors = anchorsByContent(textOf(await readTool.execute("r1", { path: name })));
  const anchor = anchors.get(line);
  expect(anchor, `read did not serve a row for ${JSON.stringify(line)}`).toBeDefined();
  const edited = await editTool.execute("e1", {
    path: name,
    anchor_from: anchor!,
    anchor_to: anchor!,
    replace_with: replacement,
  });
  return textOf(edited);
}

describe("mixed pre-image — the write lands on one ending and says so", () => {
  it("first separator differs from the majority: CRLF wins and exactly one terminator changes", async () => {
    await withTempFile("t.txt", "a\nb\r\nc\r\nd\r\n", async ({ cwd, path }) => {
      const text = await readAndEditLine(cwd, "t.txt", "a", "A");

      expect(await readFile(path, "utf-8")).toBe("A\r\nb\r\nc\r\nd\r\n");
      expect(text).toContain(
        "[MODEL] [W_EOL_REWRITTEN] EOL normalized to CRLF (file): 1 terminators changed. Undo restores normalized content.",
      );
      expect(countOf(text, WARNING_MARK)).toBe(1);
    });
  });

  it("the opposite order: LF majority wins and the warning names LF (file): 1", async () => {
    await withTempFile("t.txt", "a\r\nb\nc\nd\n", async ({ cwd, path }) => {
      const text = await readAndEditLine(cwd, "t.txt", "a", "A");

      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\nd\n");
      expect(text).toContain(
        "[MODEL] [W_EOL_REWRITTEN] EOL normalized to LF (file): 1 terminators",
      );
      expect(countOf(text, WARNING_MARK)).toBe(1);
    });
  });
});

describe("uniform pre-image under AUTO — byte-for-byte, no warning", () => {
  const cases: Array<{ ending: string; name: string; original: string; expected: string }> = [
    { ending: "LF", name: "lf.txt", original: "a\nb\n", expected: "A\nb\n" },
    { ending: "CRLF", name: "crlf.txt", original: "a\r\nb\r\n", expected: "A\r\nb\r\n" },
    { ending: "CR", name: "cr.txt", original: "a\rb\r", expected: "A\rb\r" },
  ];

  for (const { ending, name, original, expected } of cases) {
    it(`keeps every ${ending} terminator as it was`, async () => {
      await withTempFile(name, original, async ({ cwd, path }) => {
        const text = await readAndEditLine(cwd, name, "a", "A");

        expect(await readFile(path, "utf-8")).toBe(expected);
        expect(countOf(text, WARNING_MARK)).toBe(0);
      });
    });
  }
});

describe("no terminator in the pre-image", () => {
  it("writes the new terminator at the platform ending and warns about nothing", async () => {
    await withTempFile("t.txt", "a", async ({ cwd, path }) => {
      const text = await readAndEditLine(cwd, "t.txt", "a", "A\nB");

      // The new terminator is not a pre-image terminator, so nothing was rewritten.
      expect(await readFile(path, "utf-8")).toBe(`A${SYSTEM_ENDING}B`);
      expect(countOf(text, WARNING_MARK)).toBe(0);
    });
  });
});

describe("forced config setting names its rung", () => {
  it("eol: LF rewrites every CRLF and reports the config rung", async () => {
    await withTempFile("t.txt", "a\r\nb\r\n", async ({ cwd, path }) => {
      await seedEol(cwd, "LF");
      const text = await readAndEditLine(cwd, "t.txt", "a", "A");

      expect(await readFile(path, "utf-8")).toBe("A\nb\n");
      expect(text).toContain(
        "[MODEL] [W_EOL_REWRITTEN] EOL normalized to LF (config): 2 terminators changed.",
      );
      expect(countOf(text, WARNING_MARK)).toBe(1);
    });
  });

  it("counts only the terminators the write changes: 2 CRLF + 1 LF is 1 for CRLF, 2 for LF", async () => {
    await withTempFile("t.txt", "a\r\nb\r\nc\n", async ({ cwd, path }) => {
      await seedEol(cwd, "CRLF");
      const crlfText = await readAndEditLine(cwd, "t.txt", "a", "A");
      expect(await readFile(path, "utf-8")).toBe("A\r\nb\r\nc\r\n");
      expect(crlfText).toContain(
        "[MODEL] [W_EOL_REWRITTEN] EOL normalized to CRLF (config): 1 terminators changed.",
      );
    });

    await withTempFile("t.txt", "a\r\nb\r\nc\n", async ({ cwd, path }) => {
      await seedEol(cwd, "LF");
      const lfText = await readAndEditLine(cwd, "t.txt", "a", "A");
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\n");
      expect(lfText).toContain(
        "[MODEL] [W_EOL_REWRITTEN] EOL normalized to LF (config): 2 terminators changed.",
      );
    });
  });
});

describe("no write, no warning", () => {
  it("an all-noop call on a mixed file leaves the bytes and the warning alone", async () => {
    await withTempFile("t.txt", "a\r\nb\nc\n", async ({ cwd, path }) => {
      const before = await readFile(path);
      const text = await readAndEditLine(cwd, "t.txt", "a", "a");

      expect((await readFile(path)).equals(before)).toBe(true);
      expect(countOf(text, WARNING_MARK)).toBe(0);
    });
  });

  it("an all-noop BATCH on a mixed file writes nothing and says nothing", async () => {
    await withTempFile("t.txt", "a\r\nb\nc\n", async ({ cwd, path }) => {
      const before = await readFile(path);
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const anchors = anchorsByContent(textOf(await readTool.execute("r1", { path: "t.txt" })));

      const text = textOf(
        await editTool.execute("e1", {
          path: "t.txt",
          edits: [
            [anchors.get("a")!, anchors.get("a")!, "a"],
            [anchors.get("b")!, anchors.get("b")!, "b"],
          ],
        }),
      );

      expect((await readFile(path)).equals(before)).toBe(true);
      expect(countOf(text, WARNING_MARK)).toBe(0);
    });
  });
});
describe("batch and identity", () => {
  it("a batch over one mixed file carries the warning exactly once", async () => {
    await withTempFile("t.txt", "a\nb\r\nc\r\nd\r\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const anchors = anchorsByContent(textOf(await readTool.execute("r1", { path: "t.txt" })));
      const text = textOf(
        await editTool.execute("e1", {
          path: "t.txt",
          edits: [
            [anchors.get("a")!, anchors.get("a")!, "A"],
            [anchors.get("c")!, anchors.get("c")!, "C"],
          ],
        }),
      );

      expect(await readFile(path, "utf-8")).toBe("A\r\nb\r\nC\r\nd\r\n");
      expect(countOf(text, WARNING_MARK)).toBe(1);
    });
  });

  it("a rewritten EOL does not move an untouched line's anchor", async () => {
    await withTempFile("t.txt", "a\nb\r\nc\r\nd\r\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      // ONE read: both edits resolve against the anchors it served (no re-read in between).
      const anchors = anchorsByContent(textOf(await readTool.execute("r1", { path: "t.txt" })));

      await editTool.execute("e1", {
        path: "t.txt",
        anchor_from: anchors.get("a")!,
        anchor_to: anchors.get("a")!,
        replace_with: "A",
      });
      await editTool.execute("e2", {
        path: "t.txt",
        anchor_from: anchors.get("b")!,
        anchor_to: anchors.get("b")!,
        replace_with: "B",
      });

      // The second write's pre-image is uniform CRLF, so the resolved target is the file's own.
      expect(await readFile(path, "utf-8")).toBe("A\r\nB\r\nc\r\nd\r\n");
    });
  });
});

describe("save seam — the requested ending outranks the memo", () => {
  it("honours opts.lineEnding over the recorded one and records what it wrote", () => {
    const prep = prepareForSave(
      "a\nb\n",
      { encoding: "utf8", hasBOM: false, lineEnding: "\r\n", version: undefined },
      { lineEnding: "\n" },
    );

    expect(prep.textToWrite).toBe("a\nb\n");
    expect(prep.newState?.lineEnding).toBe("\n");
  });

  it("hint and override agree: the memo names the ending the bytes carry", () => {
    const prep = prepareForSave("a\nb\n", undefined, { encodingHint: "utf8", lineEnding: "\r\n" });

    expect(prep.textToWrite).toBe("a\r\nb\r\n");
    expect(prep.newState?.lineEnding).toBe("\r\n");
  });

  it("re-spells a pass-through (no memo) write when an ending is named", () => {
    const prep = prepareForSave("a\nb\n", undefined, { lineEnding: "\r\n" });

    expect(prep.textToWrite).toBe("a\r\nb\r\n");
    expect(prep.newState?.lineEnding).toBe("\r\n");
  });
});

describe("engine contract — the resolved ending and the mixed flag ride the result", () => {
  it("reports the file rung and the mixed pre-image without touching the bytes", async () => {
    await withTempFile("t.txt", "a\nb\r\nc\r\n", async ({ cwd, path }) => {
      const { readTool } = setupIntegrationTest(cwd);
      const anchors = anchorsByContent(textOf(await readTool.execute("r1", { path: "t.txt" })));
      const absolutePath = await resolveTarget(path);

      // The tools materialize a workspace-scoped store; the served rows this edit resolves
      // against live there, so the direct engine call reads it inside the same workspace.
      const result = await withWorkspace(cwd, async () =>
        runFileEdits(
          localIO(),
          [
            {
              index: 0,
              file: "t.txt",
              absolutePath,
              anchor_from: anchors.get("a")!,
              anchor_to: anchors.get("a")!,
              replace_with: "A",
            },
          ],
          { sessionKey: "test-session" },
        ),
      );

      expect(result.effectiveEnding).toBe("\r\n");
      expect(result.preImageMixed).toBe(true);
      expect(result.eolRewriteWarning).toContain("1 terminators changed");
      // The engine plans the write; the Transaction performs it, so nothing moved yet.
      expect(result.result).toBe("A\nb\nc\n");
      expect(await readFile(path, "utf-8")).toBe("a\nb\r\nc\r\n");
    });
  });
});

describe("transaction — the rollback names the pre-image ending", () => {
  it("retargets the restored bytes at originalEnding after a failed forward write", async () => {
    const saveSpy = vi
      .spyOn(undoMod, "saveUndo")
      .mockResolvedValue({ persisted: true, restore: async () => {} } as never);
    const file = (n: number): Record<string, unknown> => ({
      absolutePath: `/tmp/eol-rollback-${n}.txt`,
      displayPath: `rollback-${n}.txt`,
      originalNormalized: "a\r\n",
      bom: "",
      originalEnding: "\r\n",
      effectiveEnding: "\n",
      originalHashes: [],
      result: "b\r\n",
    });
    const io = {
      writeText: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce(undefined),
    };
    const sandbox = { mapError: (e: unknown) => e as Error };

    try {
      await expect(
        persistUndoAndWrite({
          io: io as never,
          files: [file(1), file(2)] as never,
          exec: {} as never,
          sandbox: sandbox as never,
          sandboxPolicy: undefined,
          undoUnavailableMessage: () => "unreachable",
        }),
      ).rejects.toThrow(/disk full/);

      const calls = (io.writeText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      // Two forward writes name the resolved effective ending (and the consent they were decided
      // under, #209 — the default `refuse` here) …
      expect(calls[0]!.at(-1)).toEqual({ lineEnding: "\n", migrationConsent: "refuse" });
      expect(calls[1]!.at(-1)).toEqual({ lineEnding: "\n", migrationConsent: "refuse" });
      // … and the rollback (third call) retargets file 1 at its OWN pre-image ending, naming no
      // consent at all (a rollback restores bytes; it never converts).
      expect(calls[2]![0]).toBe("/tmp/eol-rollback-1.txt");
      expect(calls[2]!.at(-1)).toEqual({ lineEnding: "\r\n" });
    } finally {
      saveSpy.mockRestore();
    }
  });
});
