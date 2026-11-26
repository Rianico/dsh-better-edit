import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { ERROR_REGISTRY } from "../../src/domain-errors.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * Range-family retry truth (T4 CP1-r2, C1–C4).
 *
 * Each cell drives the REAL `read`/`edit` tools (setupIntegrationTest) over the CP0
 * geometry it names, and asserts on the tool output the model sees: a one-item call renders the
 * item's bare diagnosis, and a multi-item call renders the `E_BATCH_ABORT` envelope whose
 * `batchAbortFormat` embeds each inner message verbatim.
 * The invariant under test: no message may promise a retry the served state cannot honour.
 *
 * - C1 = CP0 G3 (`evidence/CP1-sweep-G1-G10-HEAD.txt`): interior insert, span-length arm.
 * - C2 = CP0 H1 (`evidence/CP1-sweep-H1-H2-HEAD.txt`): disjoint windowed reads — an accept on the
 *   leased route since FU-3 (upstream ADR-0024 decision 1), so it pins the acceptance instead.
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

/**
 * Anchors of the rows inside the first `Current range:` block of a rejection message.
 * The structural envelope indents the inner block under its bullet, so every scan here
 * tolerates leading whitespace; the block appears exactly once (the envelope never
 * re-renders rows).
 */
function rangeBlockAnchors(message: string): string[] {
  const lines = message.split("\n");
  const start = lines.findIndex((line) => /^\s*Current range(?: \(fresh read\))?:$/.test(line));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^\s*([A-Za-z0-9]{3})│/.exec(lines[i]!);
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
        bareDiagnosis: first.message.startsWith("[TO MODEL] [E_STALE_RANGE] "),
        noVerdict: !first.message.includes("Batch rejected:"),
        noBullet: !first.message.includes("- edits["),
        code: first.message.includes("[E_STALE_RANGE]"),
        arm: first.message.includes(
          "served span (4 lines) no longer matches current range (5 lines)",
        ),
        instruction: first.message.includes("Re-read."),
        deadHint: first.message.includes("Retry with these anchors"),
        deadNoRead: first.message.includes("no read needed"),
      }).toEqual({
        applied: false,
        bareDiagnosis: true,
        noVerdict: true,
        noBullet: true,
        code: true,
        arm: true,
        instruction: true,
        deadHint: false,
        deadNoRead: false,
      });

      // ADR-0043: the echoed rows are recorded as a serve, so a retry with them now APPLIES
      // at the current coordinates instead of rejecting at the same arm.
      const echoed = rangeBlockAnchors(first.message);
      expect(echoed).toHaveLength(5);
      const retry = await attemptEdit(harness, {
        path: "t4-g3.txt",
        edits: [[echoed[0], echoed[echoed.length - 1], "R"]],
      });
      expect(retry.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("R\n");
      expect(first.message).not.toContain("Retry with these anchors");
    });

    // Control (fresh file, same geometry): a real re-read still applies.
    await withTempFile(
      "t4-g3-control.txt",
      "alpha\nbeta\ngamma\ndelta\n",
      async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
        const served = rowAnchors(
          getText(await harness.readTool.execute("read", { path: "t4-g3-control.txt" })),
        );
        expect(served).toHaveLength(4);
        await writeFile(path, "alpha\nbeta\ninserted\ngamma\ndelta\n", "utf-8");
        const first = await attemptEdit(harness, {
          path: "t4-g3-control.txt",
          edits: [[served[0], served[3], "R"]],
        });
        expect(first.applied).toBe(false);

        const reread = rowAnchors(
          getText(await harness.readTool.execute("read", { path: "t4-g3-control.txt" })),
        );
        expect(reread).toHaveLength(5);
        const control = await attemptEdit(harness, {
          path: "t4-g3-control.txt",
          edits: [[reread[0], reread[reread.length - 1], "R"]],
        });
        expect(control.applied).toBe(true);
        expect(await readFile(path, "utf-8")).toBe("R\n");
      },
    );
  });

  // FU-3 adopted upstream ADR-0024 decision 1: on the leased route the identity gate owns span
  // verification and its two boundary leases pin the extent, so an interior hole — a row that never
  // carried an identity — is ACCEPTED, not rejected. C2's dead-retry claim was about a rejection
  // that no longer fires; the non-leased interior rejection (where the mirror is the only evidence,
  // decision 2) stays pinned in error-codes.test.ts ("interior hole carries E_UNSERVED_RANGE with kind").
  it("never-served interior edit applies on the leased route (C2, flipped by FU-3)", async () => {
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
      expect(first.applied).toBe(true);
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
        bareDiagnosis: first.message.startsWith("[TO MODEL] [E_STALE_ANCHOR]"),
        noVerdict: !first.message.includes("Batch rejected:"),
        noBullet: !first.message.includes("- edits["),
        code: first.message.includes("[E_STALE_ANCHOR]"),
        headlineInstruction: first.message.includes("Re-read for fresh anchors."),
        noReadFallback: !first.message.includes("Call read() to get fresh anchors."),
        deadHint: first.message.includes("Retry with these anchors"),
        // The declaration the message never renders — asserted here because M4 flips it.
        remedyIsReadRequired: /read/i.test(ERROR_REGISTRY.E_STALE_ANCHOR.remedy ?? ""),
        remedyPromisesNoRead: /no read is needed/i.test(ERROR_REGISTRY.E_STALE_ANCHOR.remedy ?? ""),
      }).toEqual({
        applied: false,
        bareDiagnosis: true,
        noVerdict: true,
        noBullet: true,
        code: true,
        headlineInstruction: true,
        noReadFallback: true,
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

  // C11a/C11b (T4 CP1-r4 F12, reshaped by the one-item bare-diagnosis grammar): the model-facing
  // message is the item's own diagnosis, so a one-item call renders no verdict line and no bullet.
  // Rows are echoed exactly once, inside the inner error, and no fallback is rendered.
  it("a one-item call renders the bare diagnosis, rows echoed once (C11a)", async () => {
    await withTempFile("t4-c11a.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      // FU-3 made the old H1 interior-hole geometry an ACCEPT, so this render contract is
      // rebased onto the span-length arm (C1/G3 shape at 3-line scale): a full read, then an
      // interior insert out of band, then the stale anchor pair — a rejection that echoes rows.
      const served = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "t4-c11a.txt" })),
      );
      expect(served).toHaveLength(3);
      await writeFile(path, "alpha\ninserted\nbeta\ngamma\n", "utf-8");
      const attempt = await attemptEdit(harness, {
        path: "t4-c11a.txt",
        edits: [[served[0], served[2], "R"]],
      });
      expect(attempt.applied).toBe(false);
      expect(attempt.message).toMatch(/^\[TO MODEL\] \[E_STALE_RANGE\] /m);
      expect(attempt.message).not.toContain("Batch rejected:");
      expect(attempt.message).not.toContain("- edits[");
      // No second block: the inner rows are the only echo.
      expect(attempt.message).not.toContain("Current on-disk range");
      expect(attempt.message.match(/^\s*Current range:$/gm)).toHaveLength(1);
      const rowLines = attempt.message
        .split("\n")
        .filter((line) => /^\s*[A-Za-z0-9]{3}│/.test(line));
      expect(rowLines).toHaveLength(4);
      // No rendered line carries a row separator followed by the next fragment.
      const glued = attempt.message
        .split("\n")
        .filter((line) => /│.*(Current on-disk range|Call read\(\))/.test(line));
      expect(glued, `row glued to the next fragment: ${glued.join(" | ")}`).toEqual([]);
      expect(attempt.message).toContain("│");
    });
  });

  it("a contextless refusal renders the bare diagnosis, with no fallback line (C11b)", async () => {
    await withTempFile("t4-c11b.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      // The G7 geometry: whole-file rewrite → contextless E_STALE_ANCHOR → a rowless
      // inner message; the bare diagnosis adds no fallback.
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
      expect(attempt.message).not.toContain("- edits[");
      expect(attempt.message).not.toContain("Call read() to get fresh anchors.");
      expect(attempt.message).not.toContain("Current on-disk range");
      expect(attempt.message).not.toContain("│");
    });
  });
});
