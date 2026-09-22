import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * W_NOOP tier lock: the identical no-op submitted twice warns (applied,
 * [USER] [W_NOOP]) instead of erroring; the third submission is E_NOOP_LOOP
 * and writes nothing. The count === 2 arm is a notice, NOT a refusal —
 * only NOOP_LOOP_THRESHOLD (3) refuses.
 */
describe("noop warning tier (W_NOOP vs E_NOOP_LOOP)", () => {
  it("second identical no-op warns applied, third rejects E_NOOP_LOOP, file untouched", async () => {
    const initial = "one\ntwo\n";
    await withTempFile("noop-tier.txt", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "noop-tier.txt" });
      const anchor = extractHash(
        getText(read)
          .split("\n")
          .find((line) => line.endsWith("│one"))!,
      );

      const noop = {
        path: "noop-tier.txt",
        remove_from: anchor,
        remove_to: anchor,
        replacement_text: "one",
      };

      const first = await editTool.execute("noop-1", noop);
      expect(getText(first)).not.toContain("[W_NOOP]");

      const second = await editTool.execute("noop-2", noop);
      const secondText = getText(second);
      expect(secondText).toMatch(/\[USER\] \[W_NOOP\]/);
      expect(secondText).toMatch(/no-op'd twice/);

      await expect(editTool.execute("noop-3", noop)).rejects.toThrow(/E_NOOP_LOOP/);
      expect(await readFile(path, "utf-8")).toBe(initial);
    });
  });
});
