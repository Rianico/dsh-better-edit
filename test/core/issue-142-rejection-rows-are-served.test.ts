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

      await writeFile(path, "left\nexternal\nright\n", "utf-8");

      const rejection = await attemptEdit(harness, {
        path: "i142-repro.txt",
        edits: [[start, end, "R"]],
      });
      expect(rejection.applied).toBe(false);
      expect(rejection.message).toContain("[E_STALE_RANGE]");
      expect(rejection.message).toMatch(/^\[TO MODEL\] \[E_STALE_RANGE\] /m);
      expect(rejection.message).not.toContain("Batch rejected:");
      expect(rejection.message).not.toContain("- edits[");
      expect(await readFile(path, "utf-8")).toBe("left\nexternal\nright\n");

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
      expect(attempt.message).not.toContain("│");
      expect(attempt.message).toContain("none were recorded as served");
      expect(await readFile(path, "utf-8")).toBe(source);

      expect(await servedAt(cwd, fullKey, path)).toEqual(servedBefore);
      expect(await leasesAt(cwd, fullKey, path, anchors)).toEqual(leasesBefore);
    });
  });

  it("the zero-row fallback renders no preview and records nothing", async () => {
    const content = "alpha\nbeta\ngamma\ndelta\n";
    await withTempFile("i142-preview.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const fullKey = sessionKeyFor(harness.sessionKey);
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
      expect(attempt.message).toContain("[E_UNKNOWN_ANCHOR]");
      expect(attempt.message).not.toContain("Current range:");
      expect(attempt.message).not.toContain("Current on-disk range");
      expect(rowPairs(attempt.message)).toEqual([]);
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
      expect(await servedAt(cwd, fullKey, path)).toEqual(servedBefore);

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

  it("an exterior duplicate insert no longer collides with a served anchor (T3)", async () => {
    const source = "alpha\nbeta\ngamma\ndelta\n";
    const changed = "beta\nalpha\nbeta\ngamma\ndelta\n";

    await withTempFile("i142-dup.txt", source, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read1 = getText(await harness.readTool.execute("read", { path: "i142-dup.txt" }));
      const beta = rowOf(read1, "beta")[0];

      await writeFile(path, changed, "utf-8");
      const applied = await attemptEdit(harness, {
        path: "i142-dup.txt",
        edits: [[beta, beta, "BETA"]],
      });
      expect(applied.applied).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("beta\nalpha\nBETA\ngamma\ndelta\n");

      const freshRead = getText(await harness.readTool.execute("read", { path: "i142-dup.txt" }));
      const fresh = rowAnchors(freshRead);
      expect([...new Set(fresh)]).toHaveLength(fresh.length);
      expect(rowOf(freshRead, "beta")[0]).not.toBe(beta);
      expect(fresh).not.toContain(beta);
    });
  });
});
