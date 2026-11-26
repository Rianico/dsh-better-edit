import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hash-assign.js";

beforeAll(async () => {
  await initHasher();
});

/**
 * Deciding cell for GitHub issue #62 — "Partial reads reshuffle anchors of
 * unchanged files (pseudo `previous` drops `position`)".
 *
 * The issue's acceptance criterion: when file content is UNCHANGED, anchors on the
 * same line numbers must be INVARIANT across any read sequence. The repro is a
 * read-only 5-step table on the 42-line `small.cpp` (six `int fN(int x) {` groups),
 * watching lines 8–14:
 *
 *   1. read(offset=8, limit=7)   → record anchors for lines 8–14
 *   2. read(offset=15, limit=7)  (f3 group interleave)
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

/** Parse one windowed read into (startLine, anchorsByRealLine). */
async function readWindow(
  readTool: { execute: (id: string, args: unknown) => Promise<unknown> },
  callId: string,
  offset: number,
  limit: number,
): Promise<{ start: number; end: number; anchors: Map<number, string> }> {
  const text = getText(
    (await readTool.execute(callId, { path: "small.cpp", offset, limit })) as {
      content: Array<{ text?: string }>;
    },
  );
  const span = text.match(/\[Showing lines (\d+)-(\d+) of/);
  expect(span, `${callId}: footer must report the served span`).not.toBeNull();
  const start = Number(span![1]);
  const end = Number(span![2]);
  expect(start, `${callId}: served start must equal the requested offset`).toBe(offset);
  expect(end, `${callId}: served end must equal offset + limit - 1`).toBe(offset + limit - 1);

  const anchors = new Map<number, string>();
  for (const [i, row] of text.split("\n").entries()) {
    const bar = row.indexOf("│");
    if (bar < 0) continue;
    const lineNo = start + i;
    if (lineNo > end) break;
    anchors.set(lineNo, row.slice(0, bar));
  }
  expect(anchors.size, `${callId}: every served line 8–14 must carry an anchor`).toBe(limit);
  return { start, end, anchors };
}

function sameWindow(first: Map<number, string>, second: Map<number, string>): string[] {
  const drifted: string[] = [];
  for (const [line, anchor] of first) {
    if (second.get(line) !== anchor) {
      drifted.push(`line ${line}: ${anchor} → ${second.get(line)}`);
    }
  }
  return drifted;
}

describe("P0-62 — anchors of an unchanged file must be invariant across read sequences (issue #62)", () => {
  it("keeps every line-8–14 anchor stable across interleaved partial reads, file byte-identical (steps 1–5)", async () => {
    await withTempFile("small.cpp", SOURCE, async ({ cwd, path }) => {
      const { readTool } = setupIntegrationTest(cwd);

      const w1 = await readWindow(readTool, "read-1", 8, 7);

      await readWindow(readTool, "interleave-f3", 15, 7);

      const r1 = await readWindow(readTool, "rerun-1", 8, 7);
      expect(sameWindow(w1.anchors, r1.anchors), "anchors drifted after step 3").toEqual([]);

      await readWindow(readTool, "interleave-f5", 29, 7);

      const r2 = await readWindow(readTool, "rerun-2", 8, 7);
      expect(sameWindow(w1.anchors, r2.anchors), "anchors drifted after step 5").toEqual([]);

      expect(await readFile(path, "utf-8")).toBe(SOURCE);
    });
  });

  it("non-regression: after the 5-step sequence, freshest anchors still edit (repeated-canon line) and stale anchors still reject (issue #62 acceptance)", async () => {
    await withTempFile("small.cpp", SOURCE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);

      await readWindow(readTool, "read-1", 8, 7);
      await readWindow(readTool, "interleave-f3", 15, 7);
      await readWindow(readTool, "rerun-1", 8, 7);
      await readWindow(readTool, "interleave-f5", 29, 7);
      const r2 = await readWindow(readTool, "rerun-2", 8, 7);

      const freshLine9Anchor = r2.anchors.get(9);
      expect(freshLine9Anchor, "step-5 window serves line 9").toBeDefined();
      const freshCount = [...r2.anchors.values()].filter((h) => h === freshLine9Anchor).length;
      expect(freshCount, `freshest line-9 anchor must be unambiguous in its window`).toBe(1);
      const EDITED = "\tif (x > 999) {";
      await editTool.execute("edit-fresh", {
        path: "small.cpp",
        anchor_from: freshLine9Anchor!,
        anchor_to: freshLine9Anchor!,
        replace_with: EDITED,
      });
      const lines = SOURCE.split("\n");
      lines[8] = EDITED;
      const afterEdit = lines.join("\n");
      const edited = await readFile(path, "utf-8");
      expect(edited, "freshest line-9 anchor must apply the edit").toBe(afterEdit);
      expect(edited.split("\n")[8], "edit applied AT line 9, nowhere else").toBe(EDITED);

      let error: unknown;
      try {
        await editTool.execute("edit-stale", {
          path: "small.cpp",
          anchor_from: freshLine9Anchor!,
          anchor_to: freshLine9Anchor!,
          replace_with: "\tif (x > 111) {",
        });
      } catch (e) {
        error = e;
      }
      expect(error, "the pre-(i) anchor is stale after (i) applied").toBeDefined();
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/E_STALE_ANCHOR|E_STALE_RANGE/);
      expect(await readFile(path, "utf-8"), "stale rejection wrote nothing").toBe(afterEdit);
    });
  });

  it("control: a whole-file serve before the same sequence keeps every anchor invariant (issue step (f))", async () => {
    await withTempFile("small.cpp", SOURCE, async ({ cwd, path }) => {
      const { readTool } = setupIntegrationTest(cwd);

      const full = getText(
        (await readTool.execute("full-serve", { path: "small.cpp" })) as {
          content: Array<{ text?: string }>;
        },
      );
      expect(full).toContain("int f6(int x) {");

      const w1 = await readWindow(readTool, "read-1", 8, 7);
      await readWindow(readTool, "interleave-f3", 15, 7);
      const r1 = await readWindow(readTool, "rerun-1", 8, 7);
      expect(sameWindow(w1.anchors, r1.anchors), "control drifted after step 3").toEqual([]);
      await readWindow(readTool, "interleave-f5", 29, 7);
      const r2 = await readWindow(readTool, "rerun-2", 8, 7);
      expect(sameWindow(w1.anchors, r2.anchors), "control drifted after step 5").toEqual([]);

      expect(await readFile(path, "utf-8")).toBe(SOURCE);
    });
  });
});
