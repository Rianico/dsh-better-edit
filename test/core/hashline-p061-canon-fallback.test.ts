import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hasher.js";

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
 *   (c) `edit` with the OLD line-9 anchor → `replace_with = "\tif (x > 999) {"`.
 *   (d) Re-pinned contract (post #62 Fix 2): the interleave no longer reshuffles
 *       anchors of the unchanged file (read-and-serve.ts alignment gate + the
 *       content-addressed snapshot route), so the line-9 anchor is still the one
 *       served at line 9. The edit MUST resolve through the SERVED path and APPLY
 *       AT LINE 9. The issue's miswrite at line 2 is structurally impossible on the
 *       current validation: `verifyServedRange`'s exact-boundary rule (ADR-0018)
 *       allows no look-alike candidate search, and the position check forbids any
 *       landing off the served line. The earlier re-pin here asserted
 *       `E_STALE_RANGE`-rejection — that rejection was downstream of the #62 drift
 *       itself, not a canon-fallback pass; with drift removed, pinning rejection
 *       would pin the defect.
 *   (e) control: the same interleave, editing the globally-unique-canon anchor on
 *       line 8 (`int f2(int x) {`) MUST apply at line 8 — specificity, not mere
 *       "something works".
 *
 * The verdict instrument is the file BYTES (via `readFile`) plus the SUCCESS
 * RESPONSE DIFF (each `-` line carries the pre-edit file hash at the resolved
 * position — `genDiff(old, new, 1, newHashes, oldHashes)`), driven through the real
 * `readTool`/`editTool` seam — not a `verifyServedRange`/`verifyRebasedSpan` probe.
 */

// Issue's generator, verbatim: six groups of seven lines, each group's last line blank.
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
// Canon-repeated content: appears on lines 2, 9, 16, 23, 30, 37 (each group's line 2).
const IF_LINE = "\tif (x > 0) {";
// Line 8 content — globally unique canon (each `int fN` header occurs once).
const F2_HEADER = "int f2(int x) {";
// The miswrite the issue reports: line 2 (f1 group) silently rewritten with this text.
const MISWRITE = "\tif (x > 999) {";

describe("P0-61 — canon fallback must not pass a position-misaligned edit (issue #61)", () => {
  it("resolves the old line-9 anchor via the served path and applies AT line 9 after an interleaved windowed read (steps a–d, re-pinned)", async () => {
    await withTempFile("small.cpp", SOURCE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);

      // (a) Windowed read serves lines 8–14; the old anchor lands on line 9.
      const w1 = getText(
        await readTool.execute("read-w1", { path: "small.cpp", offset: 8, limit: 7 }),
      );
      // Pin: `offset` is the tool's 1-based START line (issue step a shows offset=8 →
      // "lines 8-14"). Assert the served span numerically, not by assumed convention.
      const span = w1.match(/\[Showing lines (\d+)-(\d+) of/);
      expect(span, "window 1 must report a served span").not.toBeNull();
      expect(Number(span![1])).toBe(8); // served START line
      expect(Number(span![2])).toBe(14); // served END line

      const w1rows = w1.split("\n");
      const line9Row = w1rows.find((l) => l.endsWith(`│${IF_LINE}`));
      expect(line9Row, "line 9 (`\\tif (x > 0) {`) served in window 1").toBeDefined();
      const oldLine9Anchor = extractHash(line9Row!);
      // The line-8 row is present too; its anchor is the unique-canon control (step e).
      expect(
        w1rows.find((l) => l.endsWith(`│${F2_HEADER}`)),
        "line 8 (`int f2(int x) {`) served in window 1",
      ).toBeDefined();

      // (b) Interleave a SECOND windowed read (f3 group, lines 15–21), no re-read of 8–14.
      const w2 = getText(
        await readTool.execute("read-w2", { path: "small.cpp", offset: 15, limit: 7 }),
      );
      const span2 = w2.match(/\[Showing lines (\d+)-(\d+) of/);
      expect(span2, "window 2 must report a served span").not.toBeNull();
      expect(Number(span2![1])).toBe(15);
      expect(Number(span2![2])).toBe(21);

      // (c) Edit with the OLD line-9 anchor. With the #62 drift gated out (Fix 2),
      //     the anchor is still the one served at line 9: it resolves through the
      //     served mirror and APPLIES — no rejection, no miswrite.
      const result = (await editTool.execute("edit-line9", {
        path: "small.cpp",
        anchor_from: oldLine9Anchor,
        anchor_to: oldLine9Anchor,
        replace_with: MISWRITE,
      })) as { content: Array<{ text?: string }> };

      // (d) VERDICT — assert on WHERE THE BYTES LANDED.
      // Positive contract: the whole-file bytes show exactly one line changed — the
      // edit applied AT line 9 (0-based index 8), nowhere else.
      const expected = SOURCE.split("\n");
      expected[8] = MISWRITE;
      const after = await readFile(path, "utf-8");
      expect(after).toBe(expected.join("\n"));
      const afterLines = after.split("\n");
      // Carrier #3: line 2 (f1 group) untouched — the exact line the issue says the
      // miswrite corrupts. Under the bug this becomes MISWRITE.
      expect(afterLines[1], "line 2 (f1 group) must be untouched — the miswrite target").toBe(
        IF_LINE,
      );
      expect(afterLines[1]).not.toBe(MISWRITE);
      // Carrier #4: the write landed AT line 9 (f2 group).
      expect(afterLines[8], "edit applied AT line 9 (f2 group)").toBe(MISWRITE);
      // Resolution PATH, not just the outcome: the success diff renders each removed
      // line prefixed with the pre-edit file hash at the RESOLVED position
      // (`genDiff(old, new, 1, newHashes, oldHashes)`), so a `-<hash>│` row for line 9
      // carrying the window-1 served anchor pins served@8 == resolved@8 — the
      // exact-boundary served route (ADR-0018), which admits no look-alike fallback.
      const text = getText(result);
      expect(
        text,
        "success diff must show the removed line 9 under the anchor served at line 9",
      ).toContain(`-${oldLine9Anchor}│${IF_LINE}`);
      // No fallback/warning marker surfaces in the response (warnBlock is empty:
      // no `W_*` code appears in the rendered payload).
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

      // Same interleave as the treatment.
      getText(await readTool.execute("read-w2", { path: "small.cpp", offset: 15, limit: 7 }));

      // Pin (under-specified by the issue): the control's replacement text is a unique
      // marker so "applied at line 8" is byte-assertable.
      const EDITED_HEADER = "int f2_EDITED(int x) {";
      await editTool.execute("edit-line8", {
        path: "small.cpp",
        anchor_from: line8Anchor,
        anchor_to: line8Anchor,
        replace_with: EDITED_HEADER,
      });

      const lines = SOURCE.split("\n");
      lines[7] = EDITED_HEADER; // line 8 is 0-based index 7
      const expected = lines.join("\n");
      const after = await readFile(path, "utf-8");
      // The unique-canon edit APPLIES, and lands exactly at line 8 — nowhere else.
      expect(after).toBe(expected);
      const afterLines = after.split("\n");
      expect(afterLines[7], "edit applied AT line 8").toBe(EDITED_HEADER);
      expect(afterLines[1], "line 2 untouched").toBe(IF_LINE);
      expect(afterLines[8], "line 9 untouched").toBe(IF_LINE);
    });
  });
});
