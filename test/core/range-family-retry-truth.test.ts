import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { ERROR_REGISTRY } from "../../src/domain-errors.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * Range-family retry truth (T4 CP1-r2, C1–C4).
 *
 * Each cell drives the REAL `read`/`edit` tools (setupIntegrationTest) over the CP0
 * geometry it names, and asserts on the `E_BATCH_ABORT` envelope — `batchAbortFormat`
 * embeds the inner message verbatim, so the envelope is the tool output the model sees.
 * The invariant under test: no message may promise a retry the served state cannot honour.
 *
 * - C1 = CP0 G3 (`evidence/CP1-sweep-G1-G10-HEAD.txt`): interior insert, span-length arm.
 * - C2 = CP0 H1 (`evidence/CP1-sweep-H1-H2-HEAD.txt`): disjoint windowed reads, interior arm.
 * - C3 = CP0 G7: full external rewrite, `E_STALE_ANCHOR` recovery is a re-read.
 * - C4 = CP0 G4: end-anchor deleted, context rows DO apply — the truth is arm-dependent,
 *   so the prose must not generalize it.
 */

type Harness = ReturnType<typeof setupIntegrationTest>;

/** Anchors of the `HASH│content` rows in `text` (read output or a rejection block). */
function rowAnchors(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9]{3})│/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Anchors of the rows inside the first `Current range:` block of a rejection message. */
/**
 * Anchors of the rows inside the first `Current range:` block of a rejection message.
 * The batch-abort envelope concatenates its own on-disk range block onto the inner
 * message, so cut there first — otherwise the last inner row and the outer rows merge
 * into one list. The split key has no leading space: the renderer normalizes the
 * engine's `" Current on-disk range…"` separator (T4 CP1-r4 F12), and a
 * separator-agnostic key survives both sides of that fix.
 */
function rangeBlockAnchors(message: string): string[] {
  const inner = message.split("Current on-disk range for edits[")[0]!;
  const lines = inner.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Current range:");
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^([A-Za-z0-9]{3})│/.exec(lines[i]!);
    if (!m) break;
    out.push(m[1]!);
  }
  return out;
}

/** Anchors of the rows inside the first `Current context around resolved anchor` block. */
function contextBlockAnchors(message: string): string[] {
  const lines = message.split("\n");
  const start = lines.findIndex((line) => line.includes("Current context around resolved anchor"));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^\s+\d+:\s+([A-Za-z0-9]{3})│/.exec(lines[i]!);
    if (!m) break;
    out.push(m[1]!);
  }
  return out;
}

async function attemptEdit(
  harness: Harness,
  params: Record<string, unknown>,
): Promise<{ applied: boolean; message: string }> {
  try {
    const text = getText(await harness.editTool.execute("attempt", params));
    return { applied: true, message: text };
  } catch (error) {
    return { applied: false, message: String((error as Error).message) };
  }
}

describe("range-family retry truth (T4)", () => {
  it("span-length rejection offers no dead retry (C1)", async () => {
    await withTempFile("t4-g3.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "t4-g3.txt" })),
      );
      expect(served).toHaveLength(4);

      // The G3 geometry: a new line inserted strictly INSIDE the served span.
      await writeFile(path, "alpha\nbeta\ninserted\ngamma\ndelta\n", "utf-8");

      const first = await attemptEdit(harness, {
        path: "t4-g3.txt",
        edits: [[served[0], served[3], "R"]],
      });
      expect({
        applied: first.applied,
        envelope: first.message.startsWith("[MODEL] [E_BATCH_ABORT]"),
        code: first.message.includes("[E_STALE_RANGE]"),
        arm: first.message.includes(
          "served span (4 lines) no longer matches current range (5 lines)",
        ),
        instruction: first.message.includes("Re-read."),
        deadHint: first.message.includes("Retry with these anchors"),
        deadNoRead: first.message.includes("no read needed"),
      }).toEqual({
        applied: false,
        envelope: true,
        code: true,
        arm: true,
        instruction: true,
        deadHint: false,
        deadNoRead: false,
      });

      // A retry with the anchors the envelope echoes back rejects at the same arm.
      const echoed = rangeBlockAnchors(first.message);
      expect(echoed).toHaveLength(5);
      const retry = await attemptEdit(harness, {
        path: "t4-g3.txt",
        edits: [[echoed[0], echoed[echoed.length - 1], "R"]],
      });
      expect(retry.applied).toBe(false);
      expect(retry.message).toContain("[E_STALE_RANGE]");
      expect(retry.message).toContain(
        "served span (4 lines) no longer matches current range (5 lines)",
      );
      expect(retry.message).not.toContain("Retry with these anchors");

      // Control: after a real re-read the same edit applies.
      const reread = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "t4-g3.txt" })),
      );
      expect(reread).toHaveLength(5);
      const control = await attemptEdit(harness, {
        path: "t4-g3.txt",
        edits: [[reread[0], reread[reread.length - 1], "R"]],
      });
      expect(control.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("R\n");
    });
  });

  it("unserved-interior rejection offers no dead retry (C2)", async () => {
    await withTempFile("t4-h1.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      // The H1 geometry: two disjoint windowed reads, so line 2 is never served.
      const window1 = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "t4-h1.txt", offset: 1, limit: 1 })),
      );
      const window3 = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "t4-h1.txt", offset: 3, limit: 1 })),
      );
      expect(window1).toHaveLength(1);
      expect(window3).toHaveLength(1);

      const first = await attemptEdit(harness, {
        path: "t4-h1.txt",
        edits: [[window1[0], window3[0], "R"]],
      });
      expect({
        applied: first.applied,
        envelope: first.message.startsWith("[MODEL] [E_BATCH_ABORT]"),
        code: first.message.includes("[E_UNSERVED_RANGE]"),
        arm: first.message.includes("line 2 in t4-h1.txt was never served"),
        deadHint: first.message.includes("Retry with these anchors"),
        deadNoRead: first.message.includes("no read needed"),
      }).toEqual({
        applied: false,
        envelope: true,
        code: true,
        arm: true,
        deadHint: false,
        deadNoRead: false,
      });

      const echoed = rangeBlockAnchors(first.message);
      expect(echoed).toHaveLength(3);
      const retry = await attemptEdit(harness, {
        path: "t4-h1.txt",
        edits: [[echoed[0], echoed[echoed.length - 1], "R"]],
      });
      expect(retry.applied).toBe(false);
      expect(retry.message).toContain("[E_UNSERVED_RANGE]");
      expect(retry.message).toContain("line 2 in t4-h1.txt was never served");
      expect(retry.message).not.toContain("Retry with these anchors");

      const reread = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "t4-h1.txt" })),
      );
      expect(reread).toHaveLength(3);
      const control = await attemptEdit(harness, {
        path: "t4-h1.txt",
        edits: [[reread[0], reread[reread.length - 1], "R"]],
      });
      expect(control.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("R\n");
    });
  });

  it("stale-anchor rejection recovers only by re-read (C3)", async () => {
    await withTempFile("t4-g7.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "t4-g7.txt" })),
      );
      expect(served).toHaveLength(4);

      // The G7 geometry: the whole file is rewritten out of band.
      await writeFile(path, "TOTALLY\nDIFFERENT\n", "utf-8");

      const first = await attemptEdit(harness, {
        path: "t4-g7.txt",
        edits: [[served[0], served[3], "R"]],
      });
      expect({
        applied: first.applied,
        envelope: first.message.startsWith("[MODEL] [E_BATCH_ABORT]"),
        code: first.message.includes("[E_STALE_ANCHOR]"),
        headlineInstruction: first.message.includes("Re-read for fresh anchors."),
        envelopeInstruction: first.message.includes("Call read() to get fresh anchors."),
        deadHint: first.message.includes("Retry with these anchors"),
        // The declaration the message never renders — asserted here because M4 flips it.
        remedyIsReadRequired: /read/i.test(ERROR_REGISTRY.E_STALE_ANCHOR.remedy ?? ""),
        remedyPromisesNoRead: /no read is needed/i.test(ERROR_REGISTRY.E_STALE_ANCHOR.remedy ?? ""),
      }).toEqual({
        applied: false,
        envelope: true,
        code: true,
        headlineInstruction: true,
        envelopeInstruction: true,
        deadHint: false,
        remedyIsReadRequired: true,
        remedyPromisesNoRead: false,
      });

      // The recovery is the re-read: the same anchors reject again, a re-read applies.
      const retry = await attemptEdit(harness, {
        path: "t4-g7.txt",
        edits: [[served[0], served[3], "R"]],
      });
      expect(retry.applied).toBe(false);
      expect(retry.message).toContain("[E_STALE_ANCHOR]");

      const reread = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "t4-g7.txt" })),
      );
      expect(reread).toHaveLength(2);
      const control = await attemptEdit(harness, {
        path: "t4-g7.txt",
        edits: [[reread[0], reread[reread.length - 1], "R"]],
      });
      expect(control.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("R\n");
    });
  });

  it("stale-anchor with context rows states the arm-dependent truth (C4)", async () => {
    await withTempFile("t4-g4.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "t4-g4.txt" })),
      );
      expect(served).toHaveLength(4);

      // The G4 geometry: the end-anchor line is deleted; the other anchor still resolves,
      // so the mismatch carries a context block of CURRENT rows.
      await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");

      const first = await attemptEdit(harness, {
        path: "t4-g4.txt",
        edits: [[served[0], served[3], "R"]],
      });
      expect({
        applied: first.applied,
        code: first.message.includes("[E_STALE_ANCHOR]"),
        headlineInstruction: first.message.includes("Re-read for fresh anchors."),
        hasContextBlock: first.message.includes("Current context around resolved anchor"),
        // The prose must not generalize "those rows work" into a retry promise.
        deadHint: first.message.includes("Retry with these anchors"),
        deadNoRead: first.message.includes("no read is needed"),
        universalRetryPromise: /retry with (the|these|those) (served|shown|echoed)/i.test(
          first.message,
        ),
      }).toEqual({
        applied: false,
        code: true,
        headlineInstruction: true,
        hasContextBlock: true,
        deadHint: false,
        deadNoRead: false,
        universalRetryPromise: false,
      });

      // The truth is arm-dependent: the rows the message itself shows DO apply here.
      const shown = contextBlockAnchors(first.message);
      expect(shown.length).toBeGreaterThanOrEqual(2);
      const retry = await attemptEdit(harness, {
        path: "t4-g4.txt",
        edits: [[shown[0], shown[shown.length - 1], "R"]],
      });
      expect(retry.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("R\ngamma\n");
    });
  });

  // C11a/C11b (T4 CP1-r4 F12): the envelope's separator is a RENDER concern, so
  // these cells assert on the whole message the model receives — line by line —
  // not on `formatError(...)` or a helper's return. The glue they catch was
  // invisible to every helper-level test that existed before, which is how it
  // survived four tickets.
  it("the rendered envelope never glues a row to the on-disk heading (C11a)", async () => {
    await withTempFile("t4-c11a.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      // The H1 geometry: two disjoint windowed reads leave line 2 unserved.
      const window1 = rowAnchors(
        getText(
          await harness.readTool.execute("read", { path: "t4-c11a.txt", offset: 1, limit: 1 }),
        ),
      );
      const window3 = rowAnchors(
        getText(
          await harness.readTool.execute("read", { path: "t4-c11a.txt", offset: 3, limit: 1 }),
        ),
      );
      const attempt = await attemptEdit(harness, {
        path: "t4-c11a.txt",
        edits: [[window1[0], window3[0], "R"]],
      });
      expect(attempt.applied).toBe(false);
      // (ii) The heading begins its own line (the engine's leading space is normalized).
      expect(attempt.message).toMatch(/\n *Current on-disk range/);
      // (i) No rendered line carries a row separator followed by the next fragment —
      // a row that runs into following prose is an unparseable anchor for a row
      // consumer. The joint pattern covers BOTH engine variants.
      const glued = attempt.message
        .split("\n")
        .filter((line) => /│.*(Current on-disk range|Call read\(\))/.test(line));
      expect(glued, `row glued to the next fragment: ${glued.join(" | ")}`).toEqual([]);
      // Non-vacuity: this geometry really does render rows.
      expect(attempt.message).toContain("│");
    });
  });

  it("the contextless fallback starts its own line in the rendered envelope (C11b)", async () => {
    await withTempFile("t4-c11b.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      // The G7 geometry: whole-file rewrite → contextless E_STALE_ANCHOR → the
      // engine's `Call read()…` fallback (no rows at all in this envelope).
      const served = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "t4-c11b.txt" })),
      );
      await writeFile(path, "TOTALLY\nDIFFERENT\n", "utf-8");
      const attempt = await attemptEdit(harness, {
        path: "t4-c11b.txt",
        edits: [[served[0], served[3], "R"]],
      });
      expect(attempt.applied).toBe(false);
      expect(attempt.message).toContain("[E_STALE_ANCHOR]");
      // (ii) The fallback fragment begins its own line.
      expect(attempt.message).toMatch(/\n *Call read\(\) to get fresh anchors\./);
      // (i) The same joint rule. Measured: the geometry that selects the fallback is
      // exactly the geometry with no rows (G4 has rows and therefore renders the
      // `Current on-disk range` block instead — see C4), so this half cannot be
      // non-vacuous here. C11a carries the row-bearing half, and the assertion
      // below pins that premise so a change to it cannot pass silently.
      const glued = attempt.message
        .split("\n")
        .filter((line) => /│.*(Current on-disk range|Call read\(\))/.test(line));
      expect(glued, `row glued to the next fragment: ${glued.join(" | ")}`).toEqual([]);
      expect(attempt.message).not.toContain("│");
    });
  });
});
