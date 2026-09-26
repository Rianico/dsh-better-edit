import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hasher.js";

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
 *   3. re-read(offset=8, limit=7) → 0.7.1 bug: the six repeated-canon anchors
 *      fully reshuffle (only unique-canon line 8 held `9JT`)
 *   4. read(offset=29, limit=7)  (f5 group)
 *   5. re-read(offset=8, limit=7) → 0.7.1: reshuffled AGAIN
 *
 * No edits are performed; the file must stay byte-identical throughout (any byte
 * change in a read-only sequence is itself a finding).
 *
 * Control (issue step 3, (f)): the same sequence but with the file's full content
 * served FIRST — the only stability condition the issue names, because
 * `isFullRead`/`row.position === index` aligns compressed indices with real line
 * numbers. The harness has no plugin `write` tool, so the in-harness equivalent of
 * the write auto-read (the whole file served) is a bare full read — pinned in the
 * report, not a variant of the geometry.
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
  // Pin (numeric, not assumed): the footer names the served span; `offset` is the
  // tool's 1-based start line. Assert it matches the requested window.
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

      // Step 1 — the baseline window.
      const w1 = await readWindow(readTool, "read-1", 8, 7);

      // Step 2 — interleave the f3 group (no re-read of the first window).
      await readWindow(readTool, "interleave-f3", 15, 7);

      // Step 3 — re-read the same window: EVERY anchor must be unchanged,
      // including the six repeated-canon lines (the issue says these fully
      // reshuffled on 0.7.1; unique-canon line 8 holding is only the easy part).
      const r1 = await readWindow(readTool, "rerun-1", 8, 7);
      expect(sameWindow(w1.anchors, r1.anchors), "anchors drifted after step 3").toEqual([]);

      // Step 4 — interleave the f5 group.
      await readWindow(readTool, "interleave-f5", 29, 7);

      // Step 5 — re-read again: still invariant.
      const r2 = await readWindow(readTool, "rerun-2", 8, 7);
      expect(sameWindow(w1.anchors, r2.anchors), "anchors drifted after step 5").toEqual([]);

      // Byte-identity: the sequence performed NO edits.
      expect(await readFile(path, "utf-8")).toBe(SOURCE);
    });
  });

  it("non-regression: after the 5-step sequence, freshest anchors still edit (repeated-canon line) and stale anchors still reject (issue #62 acceptance)", async () => {
    // These two arms pin the issue's explicit non-regression criteria, which the
    // anchor-invariance carrier above alone cannot: a fix that stabilises anchors by
    // DISABLING reuse would keep the carrier honest while breaking normal editing.
    // They live in their own test (not appended inside the treatment) because the
    // step-3 carrier throws first — inside that test these assertions would never
    // execute pre-fix. Here they replay the same read sequence (drift is NOT
    // asserted — the carrier owns it) and must pass in BOTH worlds, pre- and post-fix:
    // fresh anchors resolve to their served positions on an unchanged file, and the
    // file changes under the (i) anchor, so (ii) is stale in both worlds.
    await withTempFile("small.cpp", SOURCE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);

      // Replay the exact 5-step sequence; capture the step-5 window's anchors.
      await readWindow(readTool, "read-1", 8, 7);
      await readWindow(readTool, "interleave-f3", 15, 7);
      await readWindow(readTool, "rerun-1", 8, 7);
      await readWindow(readTool, "interleave-f5", 29, 7);
      const r2 = await readWindow(readTool, "rerun-2", 8, 7);

      // (i) POSITIVE edit-after-sequence: line 9 is a repeated-canon line
      // (`\tif (x > 0) {`, six occurrences); its FRESHEST (post-step-5) anchor must
      // APPLY at the served line — reuse disabled, or anchors stabilized off-position,
      // reddens this arm instead of silently passing.
      const freshLine9Anchor = r2.anchors.get(9);
      expect(freshLine9Anchor, "step-5 window serves line 9").toBeDefined();
      // Guard: a fresh anchor that appears twice in its own served window is not
      // usable for editing (`verifyServedRange` demands exactly one served position,
      // E_UNSERVED_RANGE). Pre-fix the drift can manufacture exactly that — reddening
      // this guard IS the finding (ticket: a pre-fix red arm is reported, not forced).
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
      lines[8] = EDITED; // line 9 is 0-based index 8
      const afterEdit = lines.join("\n");
      const edited = await readFile(path, "utf-8");
      expect(edited, "freshest line-9 anchor must apply the edit").toBe(afterEdit);
      expect(edited.split("\n")[8], "edit applied AT line 9, nowhere else").toBe(EDITED);

      // (ii) STALE rejection: reuse the PRE-(i) anchor of the line (i) just edited —
      // the file changed under it in both worlds, so it must reject and write nothing.
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

      // The only stability condition the issue names: the whole file served first
      // (in-harness equivalent of the plugin `write` auto-read — see file header).
      const full = getText(
        (await readTool.execute("full-serve", { path: "small.cpp" })) as {
          content: Array<{ text?: string }>;
        },
      );
      expect(full).toContain("int f6(int x) {"); // whole file served, not a window

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
