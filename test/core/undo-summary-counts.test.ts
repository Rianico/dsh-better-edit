import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { initHasher } from "../../src/hashline/hasher.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * Port of pi-better-edit@665a05d (#173 downstream: issue #96): the undo summary counts must
 * derive from the source line multisets, never from the rendered context-0 projection — a
 * deleted run longer than `DIFF_REMOVED_CAP` collapses behind a marker row, so counting `-`
 * rows underreports the restored lines.
 *
 * Collapsed and expanded projections must report identical source-input counts.
 */

const TWENTY_LINES = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";

beforeAll(async () => {
  await initHasher();
});

/** The served `HASH│content` rows of a read result, header lines excluded. */
function servedRows(result: { content: Array<{ text?: string }> }): string[] {
  return getText(result)
    .split("\n")
    .filter((line) => line.includes("│"));
}

async function undoAfterEdit(
  file: string,
  original: string,
  edits: (rows: string[]) => unknown[],
  assert: (text: string, restored: string) => void,
): Promise<void> {
  await withTempFile(file, original, async ({ cwd, path }) => {
    const { readTool, editTool, undoTool } = setupIntegrationTest(cwd);
    const read = await readTool.execute("r1", { path: file });
    await editTool.execute("e1", { path: file, edits: edits(servedRows(read)) });
    const undone = await undoTool.execute("u1", { path: file });
    assert(getText(undone), await readFile(path, "utf-8"));
  });
}

describe("undo_last_edit summary counts (#96)", () => {
  it("counts a large deleted run exactly even though the rendered diff collapses it", async () => {
    await undoAfterEdit(
      "undo_counts_bigdelete.txt",
      TWENTY_LINES,
      (rows) => [
        // Delete lines 3..16 (14 lines, beyond the 6-line removal cap) and add one line.
        [extractHash(rows[2]!), extractHash(rows[15]!), "REPLACED"],
      ],
      (text, restored) => {
        expect(restored).toBe(TWENTY_LINES);
        expect(text).toContain(
          "Removed 1 line(s) that were added and restored 14 line(s) that were removed.",
        );
      },
    );
  });

  it("keeps exact counts for a small (non-collapsed) deleted run beside added lines", async () => {
    await undoAfterEdit(
      "undo_counts_smalldelete.txt",
      TWENTY_LINES,
      (rows) => [[extractHash(rows[2]!), extractHash(rows[4]!), "A\nB"]],
      (text, restored) => {
        expect(restored).toBe(TWENTY_LINES);
        expect(text).toContain(
          "Removed 2 line(s) that were added and restored 3 line(s) that were removed.",
        );
      },
    );
  });
});
