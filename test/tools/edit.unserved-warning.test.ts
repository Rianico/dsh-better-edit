/**
 * #144 T3 — hint mode discloses a replaced unserved interior through the applied tier.
 *
 * Falsifier: the end-to-end disclosure. Two window reads leave holes in the served mirror
 * (lines 3-4 of six were never shown), and a later edit replaces the whole span. The diff must
 * blank those removed rows' gutters — their anchors were never served — and the response must
 * carry exactly one `[MODEL] [W_UNSERVED_INTERIOR]` naming the replaced file-line count, the
 * unserved count, and the compressed absolute file lines (#223). A fully served replacement is
 * silent; strict mode refuses the same span before any diff; a noop branch has no applied section,
 * so it can carry no disclosure.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { ANCHOR_LEN, HASH_SEP, initHasher, lineHashesPure } from "../../src/hashline/index.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { buildBatchResult } from "../../src/edit-response.js";
import type { BatchSection } from "../../src/edit-response.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

const SIX = "a\nb\nc\nd\ne\nf\n";
const EIGHT = "a\nb\nc\nd\ne\nf\ng\nh\ni\n";
const DISCLOSURE =
  "[MODEL] [W_UNSERVED_INTERIOR] Span replaced 6 file lines, 2 of which were never served; " +
  "the edit applied.\nUnserved file lines: 3-4\n" +
  "Edits should only modify lines previously read and served (enforced under strict mode); " +
  "verify this uninspected replacement was intended.";
/** A removed row with no anchor: the gutter the diff must render for an unread old line. */
const BLANK = `-${" ".repeat(ANCHOR_LEN)}${HASH_SEP}`;

type Harness = ReturnType<typeof setupIntegrationTest>;

/** Parse `hash│line` rows out of a read rendering into line text → anchor. */
function parseRows(text: string): Map<string, string> {
  const rows = text.split("\n").filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
  return new Map(rows.map((row) => [row.split("│")[1]!, extractHash(row)]));
}

/** Serve lines 1-2 and 5-6, so old lines 3-4 stay holes in the served mirror. */
async function serveHoleyWindows(harness: Harness): Promise<Map<string, string>> {
  const head = getText(
    await harness.readTool.execute("read", {
      path: "t.txt",
      windows: [{ offset: 1, limit: 2 }],
    }),
  );
  const tail = getText(
    await harness.readTool.execute("read", {
      path: "t.txt",
      windows: [{ offset: 5, limit: 2 }],
    }),
  );
  return new Map([...parseRows(head), ...parseRows(tail)]);
}

/** Serve lines 1-2, 5 and 9, so old lines 3-4 and 6-8 stay holes in the served mirror. */
async function serveGapWindows(harness: Harness): Promise<Map<string, string>> {
  const head = getText(
    await harness.readTool.execute("read", {
      path: "t.txt",
      windows: [{ offset: 1, limit: 2 }],
    }),
  );
  const middle = getText(
    await harness.readTool.execute("read", {
      path: "t.txt",
      windows: [{ offset: 5, limit: 1 }],
    }),
  );
  const tail = getText(
    await harness.readTool.execute("read", {
      path: "t.txt",
      windows: [{ offset: 9, limit: 1 }],
    }),
  );
  return new Map([...parseRows(head), ...parseRows(middle), ...parseRows(tail)]);
}

/** A section mirroring the whole-span replacement, with an explicit served mirror. */
function spanSection(result: string, served: readonly (string | null)[]): BatchSection {
  const originalHashes = lineHashesPure(SIX);
  return {
    path: "t.txt",
    originalNormalized: SIX,
    result,
    originalHashes,
    resultHashes: lineHashesPure(result),
    warnings: [],
    driftNotice: undefined,
    appliedCount: 1,
    noopCount: 0,
    totalAddedLines: 1,
    totalRemovedLines: 6,
    served,
  };
}

describe("edit unserved-interior disclosure (#144 T3)", () => {
  it("hint mode names the replaced interior and blanks its anchors", async () => {
    await withTempFile("t.txt", SIX, async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await serveHoleyWindows(harness);

      const out = await harness.editTool.execute("edit", {
        path: "t.txt",
        edits: [[anchors.get("a")!, anchors.get("f")!, "X"]],
      });
      const text = getText(out);

      expect(text).toContain(DISCLOSURE);
      expect((text.match(/W_UNSERVED_INTERIOR/g) ?? []).length).toBe(1);

      const removed = text.split("\n").filter((line) => line.startsWith("-"));
      expect(removed.find((line) => line.endsWith(`${HASH_SEP}c`))).toBe(`${BLANK}c`);
      expect(removed.find((line) => line.endsWith(`${HASH_SEP}d`))).toBe(`${BLANK}d`);

      const hashes = lineHashesPure(SIX);
      const built = buildBatchResult([
        spanSection("X\n", [hashes[0]!, hashes[1]!, null, null, hashes[4]!, hashes[5]!]),
      ]);
      expect(built.details.warnings).toEqual([DISCLOSURE]);
      expect(built.details.metrics!.warnings).toBe(built.details.warnings!.length);
      expect(built.details.metrics!.warnings).toBeGreaterThanOrEqual(1);
    });
  });

  it("names a single unserved interior line as one line, never a collapsed range", async () => {
    await withTempFile("t.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const head = getText(
        await harness.readTool.execute("read", {
          path: "t.txt",
          windows: [{ offset: 1, limit: 1 }],
        }),
      );
      const tail = getText(
        await harness.readTool.execute("read", {
          path: "t.txt",
          windows: [{ offset: 3, limit: 2 }],
        }),
      );
      const anchors = new Map([...parseRows(head), ...parseRows(tail)]);

      const out = await harness.editTool.execute("edit", {
        path: "t.txt",
        edits: [[anchors.get("a")!, anchors.get("c")!, "X"]],
      });
      const text = getText(out);

      expect(text).toContain(
        "[MODEL] [W_UNSERVED_INTERIOR] Span replaced 3 file lines, 1 of which was never served; " +
          "the edit applied.\nUnserved file line: 2\n" +
          "Edits should only modify lines previously read and served (enforced under strict mode); " +
          "verify this uninspected replacement was intended.",
      );
      expect(text).not.toContain("Unserved file line: 2-2");
    });
  });

  it("lists non-contiguous unserved runs instead of a min..max envelope", async () => {
    await withTempFile("t.txt", EIGHT, async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await serveGapWindows(harness);

      const out = await harness.editTool.execute("edit", {
        path: "t.txt",
        edits: [[anchors.get("b")!, anchors.get("i")!, "X"]],
      });
      const text = getText(out);

      expect(text).toContain(
        "[MODEL] [W_UNSERVED_INTERIOR] Span replaced 8 file lines, 5 of which were never served; " +
          "the edit applied.\nUnserved file lines: 3-4, 6-8\n" +
          "Edits should only modify lines previously read and served (enforced under strict mode); " +
          "verify this uninspected replacement was intended.",
      );
      expect((text.match(/W_UNSERVED_INTERIOR/g) ?? []).length).toBe(1);
    });
  });

  it("stays silent when every replaced line was served", async () => {
    await withTempFile("t.txt", SIX, async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = parseRows(getText(await harness.readTool.execute("read", { path: "t.txt" })));

      const hC = anchors.get("c")!;
      const out = await harness.editTool.execute("edit", {
        path: "t.txt",
        edits: [[hC, hC, "C"]],
      });
      expect(getText(out)).not.toContain("W_UNSERVED_INTERIOR");

      const built = buildBatchResult([spanSection("X\n", lineHashesPure(SIX))]);
      expect(built.details.warnings).toBeUndefined();
      expect(built.details.metrics!.warnings).toBe(0);
    });
  });

  it("strict mode refuses the same span and emits no applied-tier warning", async () => {
    await withTempFile("t.txt", SIX, async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await serveHoleyWindows(harness);

      process.env.DSH_BETTER_EDIT_SPAN_MODE = "strict";
      _resetConfigCache();
      try {
        const attempt = harness.editTool.execute("edit", {
          path: "t.txt",
          edits: [[anchors.get("a")!, anchors.get("f")!, "X"]],
        });
        await expect(attempt).rejects.toMatchObject({ code: "E_UNSERVED_RANGE" });
        const error = await attempt.catch((e: unknown) => e);
        expect((error as Error).message).toContain("[E_UNSERVED_RANGE]");
        expect((error as Error).message).toContain("never served");
        expect((error as Error).message).not.toContain("W_UNSERVED_INTERIOR");
      } finally {
        delete process.env.DSH_BETTER_EDIT_SPAN_MODE;
        _resetConfigCache();
      }
    });
  });

  it("a noop replacement carries no disclosure", async () => {
    await withTempFile("t.txt", SIX, async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await serveHoleyWindows(harness);

      const out = await harness.editTool.execute("edit", {
        path: "t.txt",
        edits: [[anchors.get("a")!, anchors.get("f")!, "a\nb\nc\nd\ne\nf"]],
      });
      const text = getText(out);

      expect(text).toContain("Classification: noop");
      expect(text).not.toContain("W_UNSERVED_INTERIOR");
    });
  });
});
