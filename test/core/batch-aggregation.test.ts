import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * Batch aggregation (C): every rejection writes zero bytes; one resubmission
 * fixes every failure.
 *
 * C2 pin — the single-failure envelope is one verdict line plus one bullet per
 * failing item. The atomicity fact frames the payload; rows are never re-rendered
 * at the envelope level (the inner error owns the single echo).
 */
describe("batch aggregation", () => {
  it("C2 pin: single failure renders one verdict line and one bullet", async () => {
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
      expect(message).toMatch(
        /^\[TO MODEL\] \[E_BATCH_ABORT\] Batch rejected: 1 of 2 edits failed; nothing was written\.$/m,
      );
      expect(message.match(/- edits\[\d+\] \(batch-single\.txt\) \[E_[A-Z_]+\]:/g)).toHaveLength(1);
      expect(message).toContain("- edits[1] (batch-single.txt) [E_STALE_ANCHOR]:");
      expect(message.match(/\[TO MODEL\]/g)).toHaveLength(1);
      expect(message).not.toContain("The whole batch was rejected");
      expect(message).not.toContain("Fix the failing");
      expect(message).not.toContain("Call read() to get fresh anchors.");
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
      expect(message).toMatch(
        /^\[TO MODEL\] \[E_BATCH_ABORT\] Batch rejected: 2 of 2 edits failed; nothing was written\.$/m,
      );
      expect(message).toContain("- edits[0] (batch-multi.txt) [E_STALE_ANCHOR]:");
      expect(message).toContain("- edits[1] (batch-multi.txt) [E_STALE_ANCHOR]:");
      expect(message.indexOf("- edits[0]")).toBeLessThan(message.indexOf("- edits[1]"));
      expect(message).not.toContain("The whole batch was rejected");
      expect(message).not.toContain("Fix the failing");
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
      expect(message).toMatch(
        /^\[TO MODEL\] \[E_BATCH_ABORT\] Batch rejected: 2 of 2 edits failed; nothing was written\.$/m,
      );
      expect(message).toContain("- edits[0] (batch-mixed.txt) [E_MALFORMED_ANCHOR]:");
      expect(message).toContain("- edits[1] (batch-mixed.txt) [E_STALE_ANCHOR]:");
      expect(message.indexOf("- edits[0]")).toBeLessThan(message.indexOf("- edits[1]"));
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
  // geometry (see test/core/deleted-twin-anchor.test.ts): T3's aligned edit load leaves the
  // deleted twin's anchor ABSENT from the buffer, so the refusal is the stale-anchor arm —
  // `E_STALE_ANCHOR`, which mints `cause: "anchor staleness"`, so forwarding (single) and
  // promotion (unanimous) stay exercised from this route. The lease-identity interception
  // (`E_TARGET_LOST`, `cause: "retirement"`) is pinned at arm level by
  // `test/core/lease-resolve-seam.test.ts`.
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
    // Out-of-band deletion of each pair's FIRST occurrence. T3's read path aligns on the checksum
    // miss, so the deleted line's spelling never returns: the named anchor is absent from the
    // buffer and the refusal is `E_STALE_ANCHOR` at resolution — the stale-anchor arm, not a
    // look-alike rebind (which the pre-T3 allocation allowed).
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
      const anchorOf = (content: string, from = 0): string => {
        const index = rows.findIndex((line, i) => i >= from && line.endsWith(`│${content}`));
        if (index < 0) {
          throw new Error(`envelope cause: no served row for ${JSON.stringify(content)}`);
        }
        return extractHash(rows[index]!);
      };
      // A torn served span for the mixed cell: the first function head through its closing
      // brace. Both bounds resolve after the deletion while an interior line is gone, so the
      // span verification refuses with a range-family code — a DIFFERENT diagnosis from the
      // deleted twin's stale anchor.
      const alphaHead = anchorOf("function alpha() {");
      const alphaBrace = anchorOf(
        "}",
        rows.findIndex((line) => line.endsWith("│function alpha() {")),
      );
      await writeFile(path, PAIRS_AFTER, "utf-8");
      return {
        editTool: harness.editTool,
        firstValue: anchors[0]!,
        firstOther: anchors[2]!,
        alphaHead,
        alphaBrace,
      };
    }

    it("a single failing item with a diagnosis forwards its cause onto the envelope", async () => {
      await withTempFile("cause-single.ts", PAIRS, async ({ cwd, path }) => {
        const { editTool, firstValue } = await twinSetup(cwd, path);
        const envelope = await rejectEnvelope(editTool, "cause-single", {
          file: "cause-single.ts",
          edits: [{ anchor_from: firstValue, anchor_to: firstValue, replace_with: "X" }],
        });
        // WHY (T3): the aligned load leaves the deleted twin's anchor ABSENT from the buffer, so
        // the refusal is `E_STALE_ANCHOR` at resolution — and that arm mints
        // `cause: "anchor staleness"`, which the single item's envelope must forward untouched.
        expect(envelope.message).toContain("[E_STALE_ANCHOR]");
        expect(envelope.cause).toBe("anchor staleness");
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
        // WHY (T3): both twins are absent from the aligned buffer, so both items report
        // `E_STALE_ANCHOR` with `cause: "anchor staleness"`; unanimity promotes that one cause.
        expect(envelope.message).toContain("- edits[0] (cause-unanimous.ts) [E_STALE_ANCHOR]:");
        expect(envelope.message).toContain("- edits[1] (cause-unanimous.ts) [E_STALE_ANCHOR]:");
        expect(envelope.cause).toBe("anchor staleness");
        expect(envelope.details?.cause).toBe(envelope.cause);
        expect(await readFile(path, "utf-8")).toBe(PAIRS_AFTER);
      });
    });

    it("mixed diagnoses stay inline — the aggregated envelope carries no single cause", async () => {
      await withTempFile("cause-mixed.ts", PAIRS, async ({ cwd, path }) => {
        const { editTool, firstValue, alphaHead, alphaBrace } = await twinSetup(cwd, path);
        const envelope = await rejectEnvelope(editTool, "cause-mixed", {
          file: "cause-mixed.ts",
          edits: [
            { anchor_from: firstValue, anchor_to: firstValue, replace_with: "X" },
            // A torn served span: both bounds resolve after the deletion, but the deletion
            // removed a line inside the span, so the range verification must refuse it with a
            // range-family code — a DIFFERENT diagnosis from item 0's stale anchor.
            { anchor_from: alphaHead, anchor_to: alphaBrace, replace_with: "Y" },
          ],
        });
        expect(envelope.message).toContain("[E_STALE_ANCHOR]");
        expect(envelope.message).toContain("[E_STALE_RANGE]");
        // The two items keep their own diagnoses inline; none is promoted over the other.
        expect(envelope.cause).toBeUndefined();
        expect(envelope.details?.cause).toBeUndefined();
        expect(await readFile(path, "utf-8")).toBe(PAIRS_AFTER);
      });
    });
  });
});
