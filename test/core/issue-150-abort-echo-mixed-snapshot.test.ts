import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * Issue #150 — a batch-abort echo must never mix snapshots.
 *
 * Repro shape (v1.2.6): a 4-line file is read whole, then ONE `edit` call submits
 *   edits[0] = line 2 (`two`) rewritten into two lines  (grows the staged buffer),
 *   edits[1] = the 3-line span `one..three`, which resolved cleanly on the pre-batch
 *              snapshot but no longer fits once edits[0] shifted every coordinate below it.
 * edits[0] applies to the in-memory buffer, edits[1] rejects with `E_STALE_RANGE`, the
 * batch aborts, and the file stays byte-identical. That part is correct.
 */

type Harness = ReturnType<typeof setupIntegrationTest>;

/** `[anchor, text]` pairs of the `HASH│content` rows in `text`, in order. */
function rowPairs(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z0-9]{3})│(.*)$/.exec(line);
    if (m) out.push([m[1]!, m[2]!]);
  }
  return out;
}

async function attemptEdit(
  harness: Harness,
  params: Record<string, unknown>,
): Promise<{ applied: boolean; message: string }> {
  try {
    return { applied: true, message: getText(await harness.editTool.execute("attempt", params)) };
  } catch (error) {
    return { applied: false, message: String((error as Error).message) };
  }
}

describe("issue #150 — batch-abort echo is never a mixed snapshot", () => {
  it("serves no rows when an earlier item already changed the buffer", async () => {
    const source = "one\ntwo\nthree\nfour\n";
    await withTempFile("i150-sample.txt", source, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = rowPairs(
        getText(await harness.readTool.execute("read", { path: "i150-sample.txt" })),
      );
      expect(served).toHaveLength(4);
      expect(served.map(([, text]) => text)).toEqual(["one", "two", "three", "four"]);
      const start = served[0]![0];
      const grown = served[1]![0];
      const end = served[2]![0];

      const attempt = await attemptEdit(harness, {
        path: "i150-sample.txt",
        edits: [
          [grown, grown, "TWO-A\nTWO-B"],
          [start, end, "REPLACED"],
        ],
      });

      expect(attempt.applied).toBe(false);
      expect(attempt.message).toContain("[E_BATCH_ABORT]");
      expect(attempt.message).toContain("[E_STALE_RANGE]");
      expect(attempt.message).toContain("edits[1]");
      expect(attempt.message).toMatch(
        /served span \(3 lines\) no longer matches (?:the rebased range|current range) \(4 lines\)/,
      );

      expect(await readFile(path, "utf-8")).toBe(source);

      expect(attempt.message).not.toContain("│");
      expect(attempt.message).not.toContain("Current on-disk range for edits[1]");
      expect(attempt.message).toContain("none grant leases and none were recorded as served");
      expect(attempt.message).toContain(
        "An anchored read of current-file lines 1-3 would serve that range.",
      );
    });
  });

  it("stays rowless on resubmission, and the named read suffices to apply", async () => {
    const source = "one\ntwo\nthree\nfour\n";
    await withTempFile("i150-repeat.txt", source, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = rowPairs(
        getText(await harness.readTool.execute("read", { path: "i150-repeat.txt" })),
      );
      const start = served[0]![0];
      const grown = served[1]![0];
      const end = served[2]![0];
      const batch = {
        path: "i150-repeat.txt",
        edits: [
          [grown, grown, "TWO-A\nTWO-B"],
          [start, end, "REPLACED"],
        ],
      };

      await attemptEdit(harness, batch);
      const repeat = await attemptEdit(harness, batch);
      expect(repeat.applied).toBe(false);
      expect(repeat.message).toContain("[E_STALE_RANGE]");
      expect(repeat.message).not.toContain("│");
      expect(repeat.message).not.toContain("Current on-disk range");
      expect(repeat.message).toContain(
        "An anchored read of current-file lines 1-3 would serve that range.",
      );
      expect(await readFile(path, "utf-8")).toBe(source);

      const paged = rowPairs(
        getText(
          await harness.readTool.execute("read", {
            path: "i150-repeat.txt",
            offset: 1,
            limit: 3,
          }),
        ),
      );
      expect(paged.map(([, text]) => text)).toEqual(["one", "two", "three"]);
      const fix = await attemptEdit(harness, {
        path: "i150-repeat.txt",
        edits: [[paged[0]![0], paged[2]![0], "REPLACED"]],
      });
      expect(fix.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("REPLACED\nfour\n");
    });
  });
});
