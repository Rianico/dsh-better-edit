import { readFile, writeFile } from "node:fs/promises";
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
      expect(message).toMatch(/\[TO MODEL\] \[E_BATCH_ABORT\]/);
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
      expect(message).toMatch(/\[TO MODEL\] \[E_BATCH_ABORT\]/);
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
      expect(message).toMatch(/\[TO MODEL\] \[E_BATCH_ABORT\]/);
      expect(await readFile(path, "utf-8")).toBe(initial);
    });
  });

  // FU-7 envelope field semantics (upstream b92e0ec:src/mutation-engine/pipeline.ts): the batch
  // envelope carries `details.cause` only on a unanimous diagnosis — `batchAbortFor` (:531-560)
  // forwards the one item's cause untouched, `batchAbortForMany` (:579-622) promotes it exactly
  // when every failing item agrees. These cells pin the three stages through the deleted-twin
  // geometry (see test/core/deleted-twin-anchor.test.ts): the boundary interception's
  // `E_TARGET_LOST` (`cause: "retirement"`, src/hashline/anchor-pipeline.ts:713-718) is the
  // diagnosis this route surfaces; the position-check arms are cause-free by design.
  // The envelope's `.code` stays `E_BATCH_ABORT`: the local batch family keeps the header-code
  // coupling that upstream's plain-Error wrapper has no analogue for (retained deviation,
  // ADR-0014 dsh-family).
  describe("envelope cause semantics", () => {
    // Two look-alike pairs: identical bodies, different anchors (position/context derived).
    const PAIRS =
      "function alpha() {\n" +
      "  return compute(value);\n" +
      "}\n" +
      "\n" +
      "function beta() {\n" +
      "  return compute(value);\n" +
      "}\n" +
      "\n" +
      "function gamma() {\n" +
      "  return compute(other);\n" +
      "}\n" +
      "\n" +
      "function delta() {\n" +
      "  return compute(other);\n" +
      "}\n";
    // Out-of-band deletion of each pair's FIRST occurrence: the surviving twin shifts up and
    // takes the deleted line's context hash, so the named anchor resolves to a look-alike —
    // the identity is gone and the interception refuses with `E_TARGET_LOST`.
    const PAIRS_AFTER = PAIRS.replace("  return compute(value);\n", "").replace(
      "  return compute(other);\n",
      "",
    );

    type EnvelopeFields = { cause?: string; details?: { cause?: string } };

    async function rejectEnvelope(
      editTool: ReturnType<typeof setupIntegrationTest>["editTool"],
      callId: string,
      params: Record<string, unknown>,
    ): Promise<EnvelopeFields & { message: string }> {
      try {
        await editTool.execute(callId, params);
      } catch (error) {
        const envelope = error as EnvelopeFields & Error;
        return {
          cause: envelope.cause,
          details: envelope.details,
          message: String(envelope.message),
        };
      }
      throw new Error("expected the batch to reject");
    }

    async function twinSetup(cwd: string, path: string) {
      const harness = setupIntegrationTest(cwd);
      const rows = getText(await harness.readTool.execute("read", { path })).split("\n");
      const anchors = rows.filter((line) => /│.*compute/.test(line)).map(extractHash);
      expect(anchors).toHaveLength(4);
      await writeFile(path, PAIRS_AFTER, "utf-8");
      return { editTool: harness.editTool, firstValue: anchors[0]!, firstOther: anchors[2]! };
    }

    it("a single failing item with a diagnosis forwards its cause onto the envelope", async () => {
      await withTempFile("cause-single.ts", PAIRS, async ({ cwd, path }) => {
        const { editTool, firstValue } = await twinSetup(cwd, path);
        const envelope = await rejectEnvelope(editTool, "cause-single", {
          file: "cause-single.ts",
          edits: [{ anchor_from: firstValue, anchor_to: firstValue, replace_with: "X" }],
        });
        expect(envelope.message).toContain("[E_TARGET_LOST]");
        expect(envelope.cause).toBe("retirement");
        expect(envelope.details?.cause).toBe(envelope.cause);
        expect(await readFile(path, "utf-8")).toBe(PAIRS_AFTER);
      });
    });

    it("unanimous diagnoses promote one cause onto the aggregated envelope", async () => {
      await withTempFile("cause-unanimous.ts", PAIRS, async ({ cwd, path }) => {
        const { editTool, firstValue, firstOther } = await twinSetup(cwd, path);
        const envelope = await rejectEnvelope(editTool, "cause-unanimous", {
          file: "cause-unanimous.ts",
          edits: [
            { anchor_from: firstValue, anchor_to: firstValue, replace_with: "X" },
            { anchor_from: firstOther, anchor_to: firstOther, replace_with: "Y" },
          ],
        });
        expect(envelope.message).toContain("edits[0] (cause-unanimous.ts) failed:");
        expect(envelope.message).toContain("edits[1] (cause-unanimous.ts) failed:");
        expect(envelope.cause).toBe("retirement");
        expect(envelope.details?.cause).toBe(envelope.cause);
        expect(await readFile(path, "utf-8")).toBe(PAIRS_AFTER);
      });
    });

    it("mixed diagnoses stay inline — the aggregated envelope carries no single cause", async () => {
      await withTempFile("cause-mixed.ts", PAIRS, async ({ cwd, path }) => {
        const { editTool, firstValue } = await twinSetup(cwd, path);
        const envelope = await rejectEnvelope(editTool, "cause-mixed", {
          file: "cause-mixed.ts",
          edits: [
            { anchor_from: firstValue, anchor_to: firstValue, replace_with: "X" },
            { anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "NEVER" },
          ],
        });
        expect(envelope.message).toContain("[E_TARGET_LOST]");
        expect(envelope.message).toContain("[E_STALE_ANCHOR]");
        // The two items keep their own diagnoses inline; none is promoted over the other.
        expect(envelope.cause).toBeUndefined();
        expect(envelope.details?.cause).toBeUndefined();
        expect(await readFile(path, "utf-8")).toBe(PAIRS_AFTER);
      });
    });
  });
});
