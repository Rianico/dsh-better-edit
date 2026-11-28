import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { NOOP_LOOP_THRESHOLD } from "../../src/constants.js";
import { loadServed } from "../../src/session-view.js";
import { sessionKeyFor, withWorkspace } from "../../src/workspace-context.js";
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
      const fullKey = sessionKeyFor(harness.sessionKey);
      const served = rowPairs(
        getText(await harness.readTool.execute("read", { path: "i150-noop.txt" })),
      );
      expect(served.map(([, text]) => text)).toEqual(["aaa", "bbb", "ccc", "ddd"]);
      const first = served[0]![0];
      const noopAnchor = served[2]![0];
      const batch = {
        path: "i150-noop.txt",
        edits: [
          [first, first, "AAA\nBBB"],
          [noopAnchor, noopAnchor, "ccc"],
          [noopAnchor, noopAnchor, "ccc"],
          [noopAnchor, noopAnchor, "ccc"],
        ],
      };

      const servedBefore = await withWorkspace(cwd, () => loadServed(fullKey, path));
      let last = { applied: true, message: "" };
      for (let round = 1; round <= NOOP_LOOP_THRESHOLD; round += 1) {
        last = await attemptEdit(harness, batch);
        expect(last.applied).toBe(false);
        expect(await readFile(path, "utf-8")).toBe(source);
      }

      expect(last.message).toMatch(
        /^\[TO MODEL\] \[E_BATCH_ABORT\] Batch rejected: 1 of 4 edits failed; nothing was written\.$/m,
      );
      expect(last.message.match(/- edits\[3\] \(i150-noop\.txt\) \[E_NOOP_LOOP\]:/g)).toHaveLength(
        1,
      );
      expect(last.message).not.toContain("edits[3] (i150-noop.txt):");
      expect(last.message).toContain("[E_NOOP_LOOP]");
      expect(last.message).not.toContain("│");
      expect(last.message).not.toContain("Current on-disk range");
      expect(last.message).toContain("shows no rows and none were recorded as served");
      expect(last.message).toContain(
        "An anchored read of current-file lines 3-3 would serve that range.",
      );
      expect(await withWorkspace(cwd, () => loadServed(fullKey, path))).toEqual(servedBefore);

      const fix = await attemptEdit(harness, {
        path: "i150-noop.txt",
        edits: [[first, noopAnchor, "REPLACED"]],
      });
      expect(fix.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("REPLACED\nddd\n");
    });
  });
});
