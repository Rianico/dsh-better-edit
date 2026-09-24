import { describe, expect, it, beforeAll } from "vitest";
import { join } from "node:path";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { execPipeline } from "../../src/mutation.js";
import { loadHashStore, shutdownHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";
import { loadServed, markDriftReported, driftReported } from "../../src/session-view.js";
import { sessionKeyFor } from "../../src/workspace-context.js";
import { withTempFile, withHome, getWritableTempRoot } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { mkdtemp } from "fs/promises";
import { rm } from "fs/promises";

beforeAll(async () => {
  await initHasher();
});
async function internalStore(): Promise<InternalHashStore> {
  return (await loadHashStore()) as InternalHashStore;
}
describe("epoch lifecycle belongs to full reads (#69)", () => {
  it("partial read merges window rows but preserves drift-reported", async () => {
    await withTempFile("p.txt", "one\ntwo\nthree\nfour\n", async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("t4-partial");
      await markDriftReported(sessionKey, path, ["abc"]);

      await readAndServe(localIO(), "p.txt", cwd, {
        sessionKey,
        offset: 2,
        limit: 2,
      });

      expect(await driftReported(sessionKey, path)).toEqual(new Set(["abc"]));
    });
  });

  it("full read clears drift-reported", async () => {
    await withTempFile("f.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("t4-full");
      await markDriftReported(sessionKey, path, ["abc"]);

      await readAndServe(localIO(), "f.txt", cwd, { sessionKey });

      expect(await driftReported(sessionKey, path)).toEqual(new Set());
    });
  });

  it("serve leases stamp the served snapshot hash and a windowed read does not re-stamp it", async () => {
    await withTempFile("e.txt", "one\ntwo\nthree\nfour", async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("t4-epoch-successor");
      const content = "one\ntwo\nthree\nfour";

      // Full read: the serve path grants a lease per served anchor, stamped with the
      // served snapshot's content hash.
      const full = await readAndServe(localIO(), "e.txt", cwd, { sessionKey });
      expect(full.served).toHaveLength(4);
      const anchor = full.served[1]!.hash;

      const store = await internalStore();
      const lease = store.leaseFor(sessionKey, path, anchor);
      expect(lease).toBeDefined();
      expect(lease?.snapshotHash).toBe(snapshotHashFor(content));
      expect(lease?.lineNumber).toBe(2);

      // A WINDOWED read serves part of the file. The lease it re-grants must keep the
      // served snapshot's hash — not a window-scoped one — and the served line number.
      const windowed = await readAndServe(localIO(), "e.txt", cwd, {
        sessionKey,
        offset: 1,
        limit: 2,
      });
      expect(windowed.served.map((row) => row.hash)).toContain(anchor);

      const after = store.leaseFor(sessionKey, path, anchor);
      expect(after).toBeDefined();
      expect(after?.snapshotHash).toBe(snapshotHashFor(content));
      expect(after?.lineNumber).toBe(2);
    });
  });

  it("malformed-anchor edit throws before any serve write", async () => {
    const home = await mkdtemp(join(await getWritableTempRoot(), "t4-preload-"));
    const restore = withHome(home);
    try {
      const sessionKey = sessionKeyFor("t4-preload");
      await expect(
        execPipeline(
          localIO(),
          {
            path: "nope.txt",
            anchor_from: "MQX│const x = 1;",
            anchor_to: "MQX",
            replace_with: "y",
          } as any,
          home,
          { sessionKey },
        ),
      ).rejects.toThrow(/\[E_MALFORMED_ANCHOR\]/);
      expect(await loadServed(sessionKey, join(home, "nope.txt"))).toEqual([]);
    } finally {
      shutdownHashStore();
      await rm(home, { recursive: true, force: true });
      restore();
    }
  });
});
