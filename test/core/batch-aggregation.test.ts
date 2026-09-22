import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * Batch aggregation (C): every rejection writes zero bytes; one resubmission
 * fixes every failure.
 *
 * C2 pin — written BEFORE the pre-pass, locking today's single-failure
 * envelope: exactly one `edits[i] (…) failed:` part, the atomicity trailer,
 * and the singular fix sentence. The aggregation must keep this envelope
 * byte-identical for the single-failure case.
 */
describe("batch aggregation", () => {
  it("C2 pin: single failure envelope is one part plus trailer plus fix sentence", async () => {
    const initial = "one\ntwo\nthree\n";
    await withTempFile("batch-single.txt", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "batch-single.txt" });
      const anchor = extractHash(
        getText(read)
          .split("\n")
          .find((line) => line.endsWith("│one"))!,
      );

      let message = "";
      try {
        await editTool.execute("batch-single", {
          file: "batch-single.txt",
          edits: [
            { anchor_from: anchor, anchor_to: anchor, replace_with: "ONE" },
            { anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "NEVER" },
          ],
        });
        expect.unreachable();
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).toMatch(/\[MODEL\] \[E_BATCH_ABORT\]/);
      expect(message.match(/edits\[\d+\] \(batch-single\.txt\) failed:/g)).toHaveLength(1);
      expect(message).toContain("edits[1] (batch-single.txt) failed:");
      expect(message).toContain("[E_STALE_ANCHOR]");
      expect(message).toContain(
        "The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied.",
      );
      expect(message).toContain(
        "Fix the failing edit (and any later edit that depends on it), then resubmit the batch.",
      );
      // Atomicity: the first (valid) item was not written either.
      expect(await readFile(path, "utf-8")).toBe(initial);
    });
  });

  it("two stale items are reported together in item order", async () => {
    const initial = "one\ntwo\nthree\n";
    await withTempFile("batch-multi.txt", initial, async ({ cwd, path }) => {
      const { editTool } = setupIntegrationTest(cwd);
      let message = "";
      try {
        await editTool.execute("batch-multi", {
          file: "batch-multi.txt",
          edits: [
            { anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "NEVER" },
            { anchor_from: "YYY", anchor_to: "YYY", replace_with: "NEVER" },
          ],
        });
        expect.unreachable();
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).toMatch(/\[MODEL\] \[E_BATCH_ABORT\]/);
      expect(message).toContain("edits[0] (batch-multi.txt) failed:");
      expect(message).toContain("edits[1] (batch-multi.txt) failed:");
      expect(message.indexOf("edits[0]")).toBeLessThan(message.indexOf("edits[1]"));
      expect(message).toContain(
        "The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied.",
      );
      expect(message).toContain(
        "Fix the failing edits (and any later edits that depend on them), then resubmit the batch.",
      );
      expect(await readFile(path, "utf-8")).toBe(initial);
    });
  });

  it("malformed and stale items are reported together with their own codes", async () => {
    const initial = "one\ntwo\nthree\n";
    await withTempFile("batch-mixed.txt", initial, async ({ cwd, path }) => {
      const { editTool } = setupIntegrationTest(cwd);
      let message = "";
      try {
        await editTool.execute("batch-mixed", {
          file: "batch-mixed.txt",
          edits: [
            { anchor_from: "not a hash!!", anchor_to: "ok1", replace_with: "NEVER" },
            { anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "NEVER" },
          ],
        });
        expect.unreachable();
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).toContain("edits[0] (batch-mixed.txt) failed:");
      expect(message).toContain("edits[1] (batch-mixed.txt) failed:");
      expect(message).toContain("[E_MALFORMED_ANCHOR]");
      expect(message).toContain("[E_STALE_ANCHOR]");
      expect(await readFile(path, "utf-8")).toBe(initial);
    });
  });

  it("overlapping ranges are still reported and write nothing", async () => {
    const initial = "a\nb\nc\nd\n";
    await withTempFile("batch-overlap.txt", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "batch-overlap.txt" });
      const rows = getText(read).split("\n");
      const h1 = extractHash(rows[0]!);
      const h2 = extractHash(rows[1]!);
      const h3 = extractHash(rows[2]!);
      let message = "";
      try {
        await editTool.execute("batch-overlap", {
          file: "batch-overlap.txt",
          edits: [
            { anchor_from: h1, anchor_to: h2, replace_with: "X" },
            { anchor_from: h2, anchor_to: h3, replace_with: "Y" },
          ],
        });
        expect.unreachable();
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).toMatch(/\[MODEL\] \[E_BATCH_ABORT\]/);
      expect(await readFile(path, "utf-8")).toBe(initial);
    });
  });
});
