import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * P0 probe → regression lock for the position-restricted concurrency guard.
 *
 * Two byte-identical lines in different functions get different anchors
 * (position/context derived). Externally deleting the FIRST occurrence and
 * then editing the deleted line's anchor must reject with E_STALE_RANGE and
 * write nothing — the edit must never silently re-bind onto the surviving
 * twin.
 *
 * Refutability: removing the `strictPos` branch in `verifyServedRange`
 * (src/hashline/anchor-pipeline.ts — `if (strictPos && from !== startLine - 1)`)
 * lets the edit apply to the surviving twin (no rejection, file changes), so
 * this test goes red. The surviving twin keeps the deleted line's hash
 * (fresh allocation hands the only remaining occurrence the base slot), the
 * served canon still matches (identical bytes), and only the served POSITION
 * disagrees — exactly what `strictPos` pins.
 */
describe("deleted twin anchor (strictPos lock)", () => {
  it("rejects E_STALE_RANGE and writes nothing when the anchored line was deleted externally", async () => {
    const initial =
      "export function alpha() {\n" +
      "  return compute(value);\n" +
      "}\n" +
      "\n" +
      "export function beta() {\n" +
      "  return compute(value);\n" +
      "}\n";

    await withTempFile("twins.ts", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "twins.ts" });
      const rows = getText(read).split("\n");
      const twinRows = rows.filter((line) => line.endsWith("│  return compute(value);"));
      expect(twinRows).toHaveLength(2);
      const firstAnchor = extractHash(twinRows[0]!);
      const secondAnchor = extractHash(twinRows[1]!);
      // Position/context derived: identical bytes, different anchors.
      expect(firstAnchor).not.toBe(secondAnchor);

      // Externally delete the FIRST occurrence (out-of-band; no serve recording).
      const external = initial.replace("  return compute(value);\n", "");
      expect(external).not.toBe(initial);
      await writeFile(path, external, "utf-8");

      let error: unknown;
      try {
        await editTool.execute("stale-twin", {
          path: "twins.ts",
          remove_from: firstAnchor,
          remove_to: firstAnchor,
          replacement_text: "  return changed;",
        });
      } catch (e) {
        error = e;
      }
      // The call rejects …
      expect(error).toBeDefined();
      // … with E_STALE_RANGE (surfaced inside the batch wrapper) …
      expect(String((error as Error).message)).toMatch(/E_STALE_RANGE/);
      // … and the file on disk is byte-identical to the externally-written
      // content: the edit never re-bound onto the surviving twin.
      expect(await readFile(path, "utf-8")).toBe(external);
    });
  });
});
