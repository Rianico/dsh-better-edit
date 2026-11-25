import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { lineHashesPure } from "../../src/hashline/index.js";
import { loadServed } from "../../src/session-view.js";
import { sessionKeyFor, withWorkspace } from "../../src/workspace-context.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * #216 (spec #214, part 3/5): the noop-loop refusal joins the batch grammar and leases its rows.
 *
 * Geometry: the session serves only the span's two BOUNDS (lines 1 and 4 of a 4-line file), so
 * the span's interior lines (2, 3) carry no serve and no lease. The noop payload replaces the
 * whole span with its own text — a valid noop in the default `hint` span mode — and its echoed
 * range covers all four rows. Recording that echo is therefore observable: the interior anchors
 * become spendable without a read.
 */

type Harness = ReturnType<typeof setupIntegrationTest>;

const FILE = "alpha\nbeta\ngamma\ndelta\n";
const NOOP_REPLACEMENT = "alpha\nbeta\ngamma\ndelta";

function rowAnchors(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│")[0]!);
}

async function attempt(
  harness: Harness,
  params: Record<string, unknown>,
): Promise<{ applied: boolean; message: string }> {
  try {
    return { applied: true, message: getText(await harness.editTool.execute("attempt", params)) };
  } catch (error) {
    return { applied: false, message: String((error as Error).message) };
  }
}

/** Serve lines 1 and 4 only; the span's interior stays unserved. */
async function serveBounds(harness: Harness, path: string): Promise<{ from: string; to: string }> {
  const first = getText(await harness.readTool.execute("r1", { path, offset: 1, limit: 1 }));
  const last = getText(await harness.readTool.execute("r2", { path, offset: 4, limit: 1 }));
  return { from: rowAnchors(first)[0]!, to: rowAnchors(last)[0]! };
}

beforeAll(async () => {
  await initHasher();
});

describe("noop-loop refusal joins the batch grammar (#216)", () => {
  it("a two-item loop renders one verdict and one bullet, and its echoed interior rows resolve", async () => {
    await withTempFile("noop-two.txt", FILE, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const fullKey = sessionKeyFor(harness.sessionKey);
      const { from, to } = await serveBounds(harness, "noop-two.txt");
      const full = lineHashesPure(FILE.trimEnd());

      const before = await withWorkspace(cwd, () => loadServed(fullKey, path));
      expect(before.slice(0, 4)).toEqual([full[0], null, null, full[3]]);

      const call = {
        file: "noop-two.txt",
        edits: [
          { anchor_from: from, anchor_to: to, replace_with: NOOP_REPLACEMENT },
          { anchor_from: from, anchor_to: to, replace_with: NOOP_REPLACEMENT },
        ],
      };

      // First submission: both items are noops (the second arms the warn tier); no refusal.
      const first = await attempt(harness, call);
      expect(first.applied).toBe(true);

      for (const round of [2, 3, 4]) {
        const outcome = await attempt(harness, call);
        expect(outcome.applied, `round ${round} must reject`).toBe(false);
        expect(outcome.message, `round ${round}`).toMatch(
          /^\[TO MODEL\] \[E_BATCH_ABORT\] Batch rejected: 1 of 2 edits failed; nothing was written\.$/m,
        );
        expect(
          outcome.message.match(/- edits\[0\] \(noop-two\.txt\) \[E_NOOP_LOOP\]:/g),
        ).toHaveLength(1);
        // The body must not repeat the item prefix the bullet already names.
        expect(outcome.message).not.toContain("edits[0] (noop-two.txt):");
        expect(outcome.message.match(/edits\[0\] \(noop-two\.txt\)/g)).toHaveLength(1);
      }

      // The refusal recorded the rows it shows: the never-served interior anchors are now leased.
      const after = await withWorkspace(cwd, () => loadServed(fullKey, path));
      expect(after.slice(0, 4)).toEqual(full);

      // ... so the interior anchor applies with no intervening read.
      const retry = await attempt(harness, {
        path: "noop-two.txt",
        anchor_from: full[1]!,
        anchor_to: full[1]!,
        replace_with: "BETA",
      });
      expect(retry.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\ndelta\n");
    });
  });

  it("a one-item loop renders the bare diagnosis, and its rows still resolve next call", async () => {
    await withTempFile("noop-one.txt", FILE, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const fullKey = sessionKeyFor(harness.sessionKey);
      const { from, to } = await serveBounds(harness, "noop-one.txt");
      const full = lineHashesPure(FILE.trimEnd());
      const call = {
        file: "noop-one.txt",
        edits: [{ anchor_from: from, anchor_to: to, replace_with: NOOP_REPLACEMENT }],
      };

      expect((await attempt(harness, call)).applied).toBe(true); // count 1
      expect((await attempt(harness, call)).applied).toBe(true); // count 2: warn tier only
      const third = await attempt(harness, call); // count 3: reject
      expect(third.applied).toBe(false);
      expect(third.message).toMatch(/^\[TO MODEL\] \[E_NOOP_LOOP\] /m);
      expect(third.message).not.toContain("Batch rejected:");
      expect(third.message).not.toContain("- edits[");
      expect(third.message).toContain("Current on-disk range:");

      const after = await withWorkspace(cwd, () => loadServed(fullKey, path));
      expect(after.slice(0, 4)).toEqual(full);
      const retry = await attempt(harness, {
        path: "noop-one.txt",
        anchor_from: full[2]!,
        anchor_to: full[2]!,
        replace_with: "GAMMA",
      });
      expect(retry.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nGAMMA\ndelta\n");
    });
  });
});
