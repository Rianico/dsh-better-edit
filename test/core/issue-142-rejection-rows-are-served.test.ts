import { readFile, writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { loadServed } from "../../src/session-view.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { sessionKeyFor, withWorkspace } from "../../src/workspace-context.js";
import { getText, makeTag, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * Issue #142 — a rejection's echoed rows are a real serve.
 *
 * Repro (issue steps 3-4): `read` serves `left|middle|right`, an external write makes
 * `middle` stale, and an edit spanning `left`→`right` rejects with `[E_STALE_RANGE]` whose
 * echo shows the CURRENT file's rows (`left|external|right`). Before this change those rows
 * were rendered and recorded nothing, so retrying with the echoed `external` anchor failed
 * `[E_UNKNOWN_ANCHOR]` — the one-turn recover-and-serve promise was false for the common
 * case. ADR-0043 makes the row-carrying rejection record its rows (rows + canons + snapshot
 * + leases) exactly like a windowed `read` of those lines, and says so in the message.
 *
 * The cells, and which arm each pins:
 *   a. the 5-step repro: the echoed anchor applies after the rejection (no `read`);
 *   b. control: a `read` before retrying still works;
 *   c. a changed-buffer refusal (ADR-0042's served-or-absent arm, i150 geometry) is rowless
 *      and records nothing — served rows and grants stay byte-identical;
 *   d. the rowless rejection that resolves no rows (`E_UNKNOWN_ANCHOR` against a
 *      windowed-served file) renders no preview and records nothing — the envelope
 *      never invents a serve (ADR-0043);
 *   e. a rolled-back serve write makes no claim: the message says the rows could NOT be
 *      recorded and the echoed anchor is unusable.
 */

beforeAll(async () => {
  await initHasher();
});

type Harness = ReturnType<typeof setupIntegrationTest>;

type LeaseRow = {
  snapshotHash: string;
  lineId: number;
  lineNumber: number;
  canonHash: string;
  retiredAt: number | null;
};
type LeaseDump = Record<string, LeaseRow | null>;

/** `[anchor, text]` pairs of the `HASH│content` rows in `text`, in order. */
function rowPairs(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z0-9]{3})│(.*)$/.exec(line);
    if (m) out.push([m[1]!, m[2]!]);
  }
  return out;
}

function rowAnchors(text: string): string[] {
  return rowPairs(text).map(([anchor]) => anchor);
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

async function servedAt(
  cwd: string,
  sessionKey: string,
  absolutePath: string,
): Promise<(string | null)[]> {
  return withWorkspace(cwd, () => loadServed(sessionKey, absolutePath));
}

async function leasesAt(
  cwd: string,
  sessionKey: string,
  absolutePath: string,
  anchors: string[],
): Promise<LeaseDump> {
  return withWorkspace(cwd, async () => {
    const store = (await loadHashStore()) as InternalHashStore;
    const dump: LeaseDump = {};
    for (const anchor of [...new Set(anchors)].sort()) {
      const lease = store.leaseFor(sessionKey, absolutePath, anchor);
      dump[anchor] = lease
        ? {
            snapshotHash: lease.snapshotHash,
            lineId: lease.lineId,
            lineNumber: lease.lineNumber,
            canonHash: lease.canonHash,
            retiredAt: lease.retiredAt,
          }
        : null;
    }
    return dump;
  });
}

/** The row of `text` whose content is exactly `content`, as `[anchor, content]`. */
function rowOf(text: string, content: string): [string, string] {
  const row = rowPairs(text).find(([, line]) => line === content);
  if (row === undefined) throw new Error(`no row for ${JSON.stringify(content)}`);
  return row;
}

describe("issue #142 — a rejection's echoed rows are recorded as served", () => {
  it("5-step repro: retry with the echoed anchor applies without a read", async () => {
    await withTempFile("i142-repro.txt", "left\nmiddle\nright\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const first = getText(await harness.readTool.execute("read", { path: "i142-repro.txt" }));
      const served = rowPairs(first);
      expect(served.map(([, text]) => text)).toEqual(["left", "middle", "right"]);
      const start = rowOf(first, "left")[0];
      const end = rowOf(first, "right")[0];

      // Step 3: the external write that makes the interior row stale.
      await writeFile(path, "left\nexternal\nright\n", "utf-8");

      // Step 4: a range spanning the served bounds rejects and echoes the current file.
      const rejection = await attemptEdit(harness, {
        path: "i142-repro.txt",
        edits: [[start, end, "R"]],
      });
      expect(rejection.applied).toBe(false);
      expect(rejection.message).toContain("[E_STALE_RANGE]");
      expect(rejection.message).toMatch(/- edits\[0\] \(i142-repro\.txt\) \[E_STALE_RANGE\]:/);
      expect(rejection.message).toContain("recorded as served");
      expect(await readFile(path, "utf-8")).toBe("left\nexternal\nright\n");

      // Step 5: the echoed `external` anchor is now spendable — no read in between.
      const echoed = rowOf(rejection.message, "external")[0];
      const retry = await attemptEdit(harness, {
        path: "i142-repro.txt",
        edits: [[echoed, echoed, "EXTERNAL"]],
      });
      expect(retry.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("left\nEXTERNAL\nright\n");
    });
  });

  it("control: a read before retrying still applies", async () => {
    await withTempFile("i142-control.txt", "left\nmiddle\nright\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const first = getText(await harness.readTool.execute("read", { path: "i142-control.txt" }));
      const start = rowOf(first, "left")[0];
      const end = rowOf(first, "right")[0];

      await writeFile(path, "left\nexternal\nright\n", "utf-8");
      const rejection = await attemptEdit(harness, {
        path: "i142-control.txt",
        edits: [[start, end, "R"]],
      });
      expect(rejection.applied).toBe(false);

      const reread = getText(await harness.readTool.execute("read", { path: "i142-control.txt" }));
      const anchor = rowOf(reread, "external")[0];
      const retry = await attemptEdit(harness, {
        path: "i142-control.txt",
        edits: [[anchor, anchor, "EXTERNAL"]],
      });
      expect(retry.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("left\nEXTERNAL\nright\n");
    });
  });

  it("a changed-buffer refusal is rowless and records nothing", async () => {
    const source = "one\ntwo\nthree\nfour\n";
    await withTempFile("i142-buffer.txt", source, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const fullKey = sessionKeyFor(harness.sessionKey);
      const read1 = getText(await harness.readTool.execute("read", { path: "i142-buffer.txt" }));
      const anchors = rowAnchors(read1);
      expect(anchors).toHaveLength(4);
      const start = rowOf(read1, "one")[0];
      const grown = rowOf(read1, "two")[0];
      const end = rowOf(read1, "three")[0];

      const servedBefore = await servedAt(cwd, fullKey, path);
      const leasesBefore = await leasesAt(cwd, fullKey, path, anchors);

      // ONE batch: item 0 grows the buffer, item 1's span no longer fits the staged buffer.
      const attempt = await attemptEdit(harness, {
        path: "i142-buffer.txt",
        edits: [
          [grown, grown, "TWO-A\nTWO-B"],
          [start, end, "REPLACED"],
        ],
      });
      expect(attempt.applied).toBe(false);
      expect(attempt.message).toContain("[E_BATCH_ABORT]");
      expect(attempt.message).toContain("[E_STALE_RANGE]");
      // Served-or-absent (ADR-0042): no rows at all, and the message says so.
      expect(attempt.message).not.toContain("│");
      expect(attempt.message).toContain("none were recorded as served");
      expect(await readFile(path, "utf-8")).toBe(source);

      // ADR-0043: the changed-buffer arm records nothing — rows and grants are untouched.
      expect(await servedAt(cwd, fullKey, path)).toEqual(servedBefore);
      expect(await leasesAt(cwd, fullKey, path, anchors)).toEqual(leasesBefore);
    });
  });

  it("the zero-row fallback renders no preview and records nothing", async () => {
    const content = "alpha\nbeta\ngamma\ndelta\n";
    await withTempFile("i142-preview.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const fullKey = sessionKeyFor(harness.sessionKey);
      // Serve lines 3-4 only: `alpha` is a real anchor of the current file that this
      // session never served, so the rejection carries no rows. The envelope renders
      // no preview for a rowless rejection (the inner message names the read).
      const window = getText(
        await harness.readTool.execute("read", { path: "i142-preview.txt", offset: 3, limit: 2 }),
      );
      expect(rowPairs(window).map(([, text]) => text)).toEqual(["gamma", "delta"]);
      const neverServed = (await makeTag(content, 1, path)).hash;
      const end = rowOf(window, "delta")[0];

      const servedBefore = await servedAt(cwd, fullKey, path);
      const attempt = await attemptEdit(harness, {
        path: "i142-preview.txt",
        edits: [[neverServed, end, "R"]],
      });
      expect(attempt.applied).toBe(false);
      expect(attempt.message).toContain("[E_BATCH_ABORT]");
      expect(attempt.message).toContain("[E_UNKNOWN_ANCHOR]");
      // A rowless rejection renders no preview rows at all.
      expect(attempt.message).not.toContain("Current range:");
      expect(attempt.message).not.toContain("Current on-disk range");
      expect(rowPairs(attempt.message)).toEqual([]);
      // A rowless rejection is never a serve (ADR-0043).
      expect(attempt.message).not.toContain("recorded as served");
      expect(await servedAt(cwd, fullKey, path)).toEqual(servedBefore);
    });
  });

  it("a rolled-back serve write makes no claim", async () => {
    await withTempFile("i142-rollback.txt", "left\nmiddle\nright\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const fullKey = sessionKeyFor(harness.sessionKey);
      const read1 = getText(await harness.readTool.execute("read", { path: "i142-rollback.txt" }));
      const start = rowOf(read1, "left")[0];
      const end = rowOf(read1, "right")[0];
      const servedBefore = await servedAt(cwd, fullKey, path);
      await writeFile(path, "left\nexternal\nright\n", "utf-8");

      const store = (await loadHashStore(cwd)) as InternalHashStore;
      const upsert = vi.spyOn(store, "upsertServed").mockImplementation(() => {
        throw new Error("injected: rejection serve fault");
      });
      let rejection: { applied: boolean; message: string };
      try {
        rejection = await attemptEdit(harness, {
          path: "i142-rollback.txt",
          edits: [[start, end, "R"]],
        });
      } finally {
        upsert.mockRestore();
      }

      expect(rejection.applied).toBe(false);
      expect(rejection.message).toContain("were NOT recorded as served");
      expect(rejection.message).toContain("re-read");
      // The rolled-back unit left nothing behind.
      expect(await servedAt(cwd, fullKey, path)).toEqual(servedBefore);

      // The echoed anchor is therefore NOT spendable: the notice told the truth.
      const echoed = rowOf(rejection.message, "external")[0];
      const retry = await attemptEdit(harness, {
        path: "i142-rollback.txt",
        edits: [[echoed, echoed, "EXTERNAL"]],
      });
      expect(retry.applied).toBe(false);
      expect(retry.message).toContain("[E_UNKNOWN_ANCHOR]");
      expect(await readFile(path, "utf-8")).toBe("left\nexternal\nright\n");
    });
  });

  it("a window that would duplicate an already-served anchor is declined", async () => {
    // The conservative arm: the echo's anchors come from the edit path's content-addressed
    // assignment, the mirror from the read path's served-stable one. When the two disagree
    // for one line (here an external insert duplicates a served line, so the inserted `beta`
    // gets the anchor the older `beta` already holds), recording the echo would put one
    // anchor at two positions — ADR-0018's duplicate state. The window is declined whole and
    // the mirror stays byte-identical, so the recovery is one bounded read.
    const source = "alpha\nbeta\ngamma\ndelta\n";
    const changed = "beta\nalpha\nbeta\ngamma\ndelta\n";

    // Control (no intervening rejection): what the fresh read serves after the external write.
    let controlAnchors: string[] = [];
    await withTempFile("i142-dup-control.txt", source, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      await harness.readTool.execute("read", { path: "i142-dup-control.txt" });
      await writeFile(path, changed, "utf-8");
      controlAnchors = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "i142-dup-control.txt" })),
      );
      expect(controlAnchors).toHaveLength(5);
    });

    await withTempFile("i142-dup.txt", source, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const fullKey = sessionKeyFor(harness.sessionKey);
      const read1 = getText(await harness.readTool.execute("read", { path: "i142-dup.txt" }));
      const anchors = rowAnchors(read1);
      const beta = rowOf(read1, "beta")[0];

      await writeFile(path, changed, "utf-8");
      const servedBefore = await servedAt(cwd, fullKey, path);
      const leasesBefore = await leasesAt(cwd, fullKey, path, anchors);

      const rejection = await attemptEdit(harness, {
        path: "i142-dup.txt",
        edits: [[beta, beta, "BETA"]],
      });
      expect(rejection.applied).toBe(false);
      expect(rejection.message).toMatch(/- edits\[0\] \(i142-dup\.txt\) \[E_STALE_RANGE\]:/);
      expect(rejection.message).toContain("were NOT recorded as served");
      expect(rejection.message).not.toContain("were recorded as served");
      expect(rejection.message).toContain("re-read");

      // Declined whole: nothing in the mirror moved, no lease was granted.
      expect(await servedAt(cwd, fullKey, path)).toEqual(servedBefore);
      expect(await leasesAt(cwd, fullKey, path, anchors)).toEqual(leasesBefore);

      // The next fresh read has no duplicate and is the control's anchor list.
      const fresh = rowAnchors(
        getText(await harness.readTool.execute("read", { path: "i142-dup.txt" })),
      );
      expect([...new Set(fresh)]).toHaveLength(fresh.length);
      expect(fresh).toEqual(controlAnchors);

      // The named recovery works: a bounded read, then the edit applies.
      const firstRow = rowOf(
        getText(await harness.readTool.execute("read", { path: "i142-dup.txt" })),
        "beta",
      )[0];
      const fixed = await attemptEdit(harness, {
        path: "i142-dup.txt",
        edits: [[firstRow, firstRow, "BETA"]],
      });
      expect(fixed.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("BETA\nalpha\nbeta\ngamma\ndelta\n");
    });
  });
});
