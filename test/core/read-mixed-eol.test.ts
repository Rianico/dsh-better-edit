/**
 * #170 — a mixed-terminator file says so on the READ.
 *
 * A file whose raw pre-image spells more than one terminator kind (`CRLF`, `LF`, `CR`) is
 * normalized to one ending by every write, so the read is the last moment the fact is cheap to
 * act on. The read tier reports it in its OWN header shape — bare `[<CODE>]`, no audience
 * prefix — because a read warning is not an applied mutation: nothing was written, and the
 * counts describe bytes observed before any write.
 *
 * The two claims this spec measures together:
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { formatReadWarning } from "../../src/domain-errors.js";
import { localIO } from "../../src/fs-bridge.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { readAndServe } from "../../src/read-and-serve.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/** The read tier's bare header — no `[MODEL]`/`[USER]` audience prefix by contract. */
const MARK = "[W_MIXED_EOL]";

const SESSION = "read-mixed-eol-session";

/** A served row: three anchor characters, the separator, then the line's text. */
const ANCHOR_ROW = /^([A-Za-z0-9]{3})│(.*)$/;

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

/** Occurrences of a literal substring: a read warning must appear exactly once. */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The served-row lines of a read result, in render order. */
function rowLines(text: string): string[] {
  return text.split("\n").filter((line) => ANCHOR_ROW.test(line));
}

/** The served anchors of a read result, keyed by the row's content. */
function anchorsByContent(text: string): Map<string, string> {
  const rows: RegExpExecArray[] = [];
  for (const line of text.split("\n")) {
    const match = ANCHOR_ROW.exec(line);
    if (match !== null) rows.push(match);
  }
  return new Map(rows.map((match) => [match[2]!, match[1]!]));
}

type ReadExtra = {
  offset?: number;
  limit?: number;
  windows?: { offset: number; limit: number }[];
};

/** One read through the shared read-and-serve seam (the same seam the `read` tool uses). */
async function read(
  cwd: string,
  name: string,
  extra: ReadExtra = {},
): Promise<{ text: string; served: number }> {
  const result = await readAndServe(localIO(), name, cwd, { sessionKey: SESSION, ...extra });
  return { text: result.text, served: result.served.length };
}

/** Seed the plugin YAML config with one `eol` setting, before any read (the cache is large). */
async function seedEol(cwd: string, setting: "AUTO" | "LF" | "CRLF" | "CR"): Promise<void> {
  const dir = join(cwd, ".dsh", "plugins", "dsh-better-edit");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.yaml"), `eol: ${setting}\n`, "utf-8");
  _resetConfigCache();
}

describe("read tier: the bare header is the contract", () => {
  it("formatReadWarning renders counts of the kinds present, in CRLF/LF/CR order, with no audience", () => {
    expect(
      formatReadWarning("W_MIXED_EOL", { crlf: 12, lf: 3, cr: 1, target: "CRLF", source: "env" }),
    ).toBe("[W_MIXED_EOL] Mixed EOL: 12 CRLF, 3 LF, 1 CR. All edits normalize to CRLF (env).");
  });

  it("absent kinds are omitted, never rendered as 0", () => {
    expect(
      formatReadWarning("W_MIXED_EOL", { crlf: 0, lf: 2, cr: 5, target: "LF", source: "file" }),
    ).toBe("[W_MIXED_EOL] Mixed EOL: 2 LF, 5 CR. All edits normalize to LF (file).");
  });
});

describe("read warning: a mixed pre-image says so on the read", () => {
  it("2 CRLF + 1 LF: the warning ends the read text and names the dominant ending", async () => {
    await withTempFile("t.txt", "a\r\nb\r\nc\n", async ({ cwd }) => {
      const { text } = await read(cwd, "t.txt");

      expect(
        text.endsWith(`\n\n${MARK} Mixed EOL: 2 CRLF, 1 LF. All edits normalize to CRLF (file).`),
      ).toBe(true);
      expect(countOf(text, MARK)).toBe(1);
      expect(text).not.toContain(`[MODEL] ${MARK}`);
      expect(text).not.toContain(`[USER] ${MARK}`);
      expect(text).not.toMatch(/\[(?:MODEL|USER)\] \[W_MIXED_EOL\]/);
    });
  });

  it("a tie prefers LF: 1 CRLF + 1 LF reports LF (file)", async () => {
    await withTempFile("t.txt", "a\r\nb\n", async ({ cwd }) => {
      const { text } = await read(cwd, "t.txt");

      expect(
        text.endsWith(`\n\n${MARK} Mixed EOL: 1 CRLF, 1 LF. All edits normalize to LF (file).`),
      ).toBe(true);
      expect(countOf(text, MARK)).toBe(1);
    });
  });

  it("a uniform LF file carries no read warning", async () => {
    await withTempFile("t.txt", "a\nb\n", async ({ cwd }) => {
      const { text } = await read(cwd, "t.txt");
      expect(text).not.toContain(MARK);
      expect(text).not.toContain("Mixed EOL");
    });
  });

  it("a uniform CRLF file carries no read warning", async () => {
    await withTempFile("t.txt", "a\r\nb\r\n", async ({ cwd }) => {
      const { text } = await read(cwd, "t.txt");
      expect(text).not.toContain(MARK);
      expect(text).not.toContain("Mixed EOL");
    });
  });

  it("a uniform CR file carries no read warning", async () => {
    await withTempFile("t.txt", "a\rb\r", async ({ cwd }) => {
      const { text } = await read(cwd, "t.txt");
      expect(text).not.toContain(MARK);
      expect(text).not.toContain("Mixed EOL");
    });
  });

  it("a file with no terminator at all carries no read warning", async () => {
    await withTempFile("t.txt", "abc", async ({ cwd }) => {
      const { text } = await read(cwd, "t.txt");
      expect(text).not.toContain(MARK);
      expect(text).not.toContain("Mixed EOL");
    });
  });

  it("a config-forced uniform file carries no read warning — the edit warning owns that case", async () => {
    await withTempFile("t.txt", "a\r\nb\r\n", async ({ cwd }) => {
      await seedEol(cwd, "LF");
      const { text } = await read(cwd, "t.txt");

      expect(text).not.toContain(MARK);
      expect(text).not.toContain("Mixed EOL");
    });
  });
});

describe("read warning: chrome, not content", () => {
  it("a page reports the whole-file counts once, after the rows, and keeps the pagination hint", async () => {
    const sixMixed = "a\r\nb\r\nc\r\nd\r\ne\nf\n";
    await withTempFile("t.txt", sixMixed, async ({ cwd }) => {
      const { text, served } = await read(cwd, "t.txt", { offset: 1, limit: 2 });

      expect(text).toContain("[Showing lines 1-2 of 6. Use offset=3 to continue.]");
      expect(countOf(text, "Use offset=3")).toBe(1);
      expect(
        text.endsWith(`\n\n${MARK} Mixed EOL: 4 CRLF, 2 LF. All edits normalize to CRLF (file).`),
      ).toBe(true);
      expect(countOf(text, MARK)).toBe(1);

      const noticeLine = text.split("\n").find((line) => line.includes(MARK));
      expect(noticeLine).toBeDefined();
      expect(ANCHOR_ROW.test(noticeLine!)).toBe(false);
      expect(noticeLine).not.toContain("│");
      const rows = rowLines(text);
      expect(rows).toHaveLength(2);
      expect(served).toBe(2);
      expect(text.indexOf(rows[1]!)).toBeLessThan(text.indexOf(MARK));
      expect(text.lastIndexOf("Use offset=3")).toBeLessThan(text.indexOf(MARK));
    });
  });

  it("a multi-window read reports the whole-file counts once", async () => {
    const sixMixed = "a\r\nb\r\nc\r\nd\r\ne\nf\n";
    await withTempFile("t.txt", sixMixed, async ({ cwd }) => {
      const { text, served } = await read(cwd, "t.txt", {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 5, limit: 1 },
        ],
      });

      expect(text).toContain("=== Lines 1-1 of 6 ===");
      expect(text).toContain("=== Lines 5-5 of 6 ===");
      expect(countOf(text, MARK)).toBe(1);
      expect(
        text.endsWith(`\n\n${MARK} Mixed EOL: 4 CRLF, 2 LF. All edits normalize to CRLF (file).`),
      ).toBe(true);
      expect(rowLines(text)).toHaveLength(2);
      expect(served).toBe(2);
    });
  });
});

describe("read warning: the next edit agrees with it", () => {
  it("a mixed file's read names CRLF (file) and the applied edit names the same rung", async () => {
    await withTempFile("t.txt", "a\r\nb\r\nc\n", async ({ cwd }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);

      const readText = textOf(await readTool.execute("r1", { path: "t.txt" }));
      expect(
        readText.endsWith(
          `\n\n${MARK} Mixed EOL: 2 CRLF, 1 LF. All edits normalize to CRLF (file).`,
        ),
      ).toBe(true);

      const anchor = anchorsByContent(readText).get("a");
      expect(anchor, "read did not serve a row for line 1").toBeDefined();

      const editText = textOf(
        await editTool.execute("e1", {
          path: "t.txt",
          anchor_from: anchor!,
          anchor_to: anchor!,
          replace_with: "A",
        }),
      );

      expect(editText).toContain("[MODEL] [W_EOL_REWRITTEN] EOL normalized to CRLF (file)");
      expect(countOf(editText, "[W_EOL_REWRITTEN]")).toBe(1);
    });
  });

  it("a config-forced target is what the read names and what the edit lands on", async () => {
    await withTempFile("t.txt", "a\r\nb\r\nc\n", async ({ cwd }) => {
      await seedEol(cwd, "LF");
      const { readTool, editTool } = setupIntegrationTest(cwd);

      const readText = textOf(await readTool.execute("r1", { path: "t.txt" }));
      expect(
        readText.endsWith(
          `\n\n${MARK} Mixed EOL: 2 CRLF, 1 LF. All edits normalize to LF (config).`,
        ),
      ).toBe(true);

      const anchor = anchorsByContent(readText).get("a");
      expect(anchor, "read did not serve a row for line 1").toBeDefined();

      const editText = textOf(
        await editTool.execute("e1", {
          path: "t.txt",
          anchor_from: anchor!,
          anchor_to: anchor!,
          replace_with: "A",
        }),
      );

      expect(editText).toContain("[MODEL] [W_EOL_REWRITTEN] EOL normalized to LF (config)");
      expect(countOf(editText, "[W_EOL_REWRITTEN]")).toBe(1);
    });
  });
});
