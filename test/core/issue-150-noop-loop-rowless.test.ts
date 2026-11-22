import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { NOOP_LOOP_THRESHOLD } from "../../src/constants.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * Issue #150 — the noop-loop rejection is served-or-absent too.
 *
 * Same rule as the shifted-buffer rejections (`issue-150-abort-echo-mixed-snapshot.test.ts`):
 * once an earlier item of the call already changed the working buffer, the noop's rows come
 * from an uncommitted buffer. They are not guaranteed current-file rows, so the refusal shows
 * NO rows, records none, and names the current-file lines an anchored read would serve.
 *
 * Shape: a 4-line file; ONE batch = [ grow line 1, the same noop on line 3 three times ].
 * The grow changes the buffer, then each identical noop ticks the counter — an applied item
 * clears the file's counters (`clearNoopLoop`), so the threshold is reachable inside one call
 * only. The third noop trips the guard with the grow already in the buffer; nothing is written.
 * The batch is resubmitted `NOOP_LOOP_THRESHOLD` times to prove the story does not decay.
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

describe("issue #150 — noop-loop rejection is rowless in a changed buffer", () => {
  it("shows no rows and names the current-file lines a read would serve", async () => {
    const source = "aaa\nbbb\nccc\nddd\n";
    await withTempFile("i150-noop.txt", source, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = rowPairs(
        getText(await harness.readTool.execute("read", { path: "i150-noop.txt" })),
      );
      expect(served.map(([, text]) => text)).toEqual(["aaa", "bbb", "ccc", "ddd"]);
      const first = served[0]![0];
      const noopAnchor = served[2]![0];
      const batch = {
        path: "i150-noop.txt",
        edits: [
          [first, first, "AAA\nBBB"], // grows the buffer: every line below shifts
          [noopAnchor, noopAnchor, "ccc"], // noop: the range already holds this text
          [noopAnchor, noopAnchor, "ccc"], // noop again
          [noopAnchor, noopAnchor, "ccc"], // NOOP_LOOP_THRESHOLD: the guard rejects
        ],
      };

      let last = { applied: true, message: "" };
      for (let round = 1; round <= NOOP_LOOP_THRESHOLD; round += 1) {
        last = await attemptEdit(harness, batch);
        // Every round aborts and writes nothing.
        expect(last.applied).toBe(false);
        expect(await readFile(path, "utf-8")).toBe(source);
      }

      // Round `NOOP_LOOP_THRESHOLD` trips the loop guard, and that round's grow had already
      // changed the buffer: the refusal is served-or-absent.
      expect(last.message).toContain("[E_NOOP_LOOP]");
      expect(last.message).not.toContain("│");
      expect(last.message).not.toContain("Current on-disk range");
      expect(last.message).toContain("shows no rows and none were recorded as served");
      expect(last.message).toContain(
        "An anchored read of current-file lines 3-3 would serve that range.",
      );

      // The withheld rows were not recorded as served: the original serve still applies a
      // standalone edit of the same span, which proves the real served record was not displaced.
      const fix = await attemptEdit(harness, {
        path: "i150-noop.txt",
        edits: [[first, noopAnchor, "REPLACED"]],
      });
      expect(fix.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("REPLACED\nddd\n");
    });
  });
});
