import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hash-assign.js";

beforeAll(async () => {
  await initHasher();
});

/**
 * Deciding cell for GitHub issue #61 — "verifyServedRange's canon fallback passes
 * position-misaligned edits → silent miswrite (data corruption)".
 *
 * The repro is encoded verbatim from the issue: a 42-line `small.cpp` (six
 * `int fN(int x) {` groups, each 7 lines, the 7th blank) whose `\tif (x > 0) {`,
 * `\t}`, `}` and blank lines are repeated canons. Sequence (issue steps a–e):
 *
 *   (a) `read(offset=8, limit=7)` serves lines 8–14; the old anchor lands on line 9
 *       (`\tif (x > 0) {`, f2 group).
 *   (b) interleave `read(offset=15, limit=7)` (f3 group) WITHOUT re-reading 8–14.
 */

function generateSmallCpp(): string {
  const lines: string[] = [];
  for (let n = 1; n <= 6; n++) {
    lines.push(
      `int f${n}(int x) {`,
      "\tif (x > 0) {",
      "\t\treturn x;",
      "\t}",
      "\treturn -x;",
      "}",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

const SOURCE = generateSmallCpp();
const IF_LINE = "\tif (x > 0) {";
const F2_HEADER = "int f2(int x) {";
const MISWRITE = "\tif (x > 999) {";

describe("P0-61 — canon fallback must not pass a position-misaligned edit (issue #61)", () => {
  it("resolves the old line-9 anchor via the served path and applies AT line 9 after an interleaved windowed read (steps a–d, re-pinned)", async () => {
    await withTempFile("small.cpp", SOURCE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);

      const w1 = getText(
        await readTool.execute("read-w1", { path: "small.cpp", offset: 8, limit: 7 }),
      );
      const span = w1.match(/\[Showing lines (\d+)-(\d+) of/);
      expect(span, "window 1 must report a served span").not.toBeNull();
      expect(Number(span![1])).toBe(8);
      expect(Number(span![2])).toBe(14);

      const w1rows = w1.split("\n");
      const line9Row = w1rows.find((l) => l.endsWith(`│${IF_LINE}`));
      expect(line9Row, "line 9 (`\\tif (x > 0) {`) served in window 1").toBeDefined();
      const oldLine9Anchor = extractHash(line9Row!);
      expect(
        w1rows.find((l) => l.endsWith(`│${F2_HEADER}`)),
        "line 8 (`int f2(int x) {`) served in window 1",
      ).toBeDefined();

      const w2 = getText(
        await readTool.execute("read-w2", { path: "small.cpp", offset: 15, limit: 7 }),
      );
      const span2 = w2.match(/\[Showing lines (\d+)-(\d+) of/);
      expect(span2, "window 2 must report a served span").not.toBeNull();
      expect(Number(span2![1])).toBe(15);
      expect(Number(span2![2])).toBe(21);

      const result = (await editTool.execute("edit-line9", {
        path: "small.cpp",
        anchor_from: oldLine9Anchor,
        anchor_to: oldLine9Anchor,
        replace_with: MISWRITE,
      })) as { content: Array<{ text?: string }> };

      const expected = SOURCE.split("\n");
      expected[8] = MISWRITE;
      const after = await readFile(path, "utf-8");
      expect(after).toBe(expected.join("\n"));
      const afterLines = after.split("\n");
      expect(afterLines[1], "line 2 (f1 group) must be untouched — the miswrite target").toBe(
        IF_LINE,
      );
      expect(afterLines[1]).not.toBe(MISWRITE);
      expect(afterLines[8], "edit applied AT line 9 (f2 group)").toBe(MISWRITE);
      const text = getText(result);
      expect(
        text,
        "success diff must show the removed line 9 under the anchor served at line 9",
      ).toContain(`-${oldLine9Anchor}│${IF_LINE}`);
      expect(text, "edit response must carry no warning block").not.toMatch(/W_[A-Z_]+/);
    });
  });

  it("control: the same interleave applies a globally-unique-canon edit at line 8 (step e)", async () => {
    await withTempFile("small.cpp", SOURCE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);

      const w1 = getText(
        await readTool.execute("read-w1", { path: "small.cpp", offset: 8, limit: 7 }),
      );
      const line8Row = w1.split("\n").find((l) => l.endsWith(`│${F2_HEADER}`));
      expect(line8Row, "line 8 served in window 1").toBeDefined();
      const line8Anchor = extractHash(line8Row!);

      getText(await readTool.execute("read-w2", { path: "small.cpp", offset: 15, limit: 7 }));

      const EDITED_HEADER = "int f2_EDITED(int x) {";
      await editTool.execute("edit-line8", {
        path: "small.cpp",
        anchor_from: line8Anchor,
        anchor_to: line8Anchor,
        replace_with: EDITED_HEADER,
      });

      const lines = SOURCE.split("\n");
      lines[7] = EDITED_HEADER;
      const expected = lines.join("\n");
      const after = await readFile(path, "utf-8");
      expect(after).toBe(expected);
      const afterLines = after.split("\n");
      expect(afterLines[7], "edit applied AT line 8").toBe(EDITED_HEADER);
      expect(afterLines[1], "line 2 untouched").toBe(IF_LINE);
      expect(afterLines[8], "line 9 untouched").toBe(IF_LINE);
    });
  });
});
