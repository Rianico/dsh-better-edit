import { describe, expect, it, beforeAll } from "vitest";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";
import { markDriftReported, driftReported } from "../../src/session-view.js";
import { sessionKeyFor } from "../../src/workspace-context.js";
import { withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hasher.js";

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
  it("a windowed-shaped read is never a full read: huge limit and exact-count limit (T3a/T3c)", async () => {
    await withTempFile("w.txt", "one\ntwo\nthree\nfour\n", async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("t6-window-shapes");
      // A full read first: it pins the epoch on the served snapshot.
      const full = await readAndServe(localIO(), "w.txt", cwd, { sessionKey });
      const anchor = full.served[1]!.hash;
      const pin = (await internalStore()).leaseFor(sessionKey, path, anchor)?.snapshotHash;
      expect(pin).toBe(snapshotHashFor("one\ntwo\nthree\nfour\n"));

      // A limit that covers the whole file is still a window, not a full read.
      for (const shape of [{ limit: 1_000_000 }, { limit: 4 }] as const) {
        await markDriftReported(sessionKey, path, ["abc"]);
        const view = await readAndServe(localIO(), "w.txt", cwd, { sessionKey, ...shape });
        expect(view.served.length, JSON.stringify(shape)).toBe(4);
        expect(view.truncation, JSON.stringify(shape)).toBeUndefined();
        // Not a full read: drift-reported survives and the epoch pin is not re-stamped.
        expect(await driftReported(sessionKey, path), JSON.stringify(shape)).toEqual(
          new Set(["abc"]),
        );
        expect(
          (await internalStore()).leaseFor(sessionKey, path, anchor)?.snapshotHash,
          JSON.stringify(shape),
        ).toBe(pin);
      }
    });
  });

  it("a paginated read is not a full read (T3a/T3c)", async () => {
    // The preview paginates at DEFAULT_MAX_LINES (2000); `readAndServe`'s result does not
    // expose the `truncation` object, so the observable is the served row count plus the
    // pagination hint — and the drift guard must not fire on it.
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    await withTempFile("big.txt", `${lines.join("\n")}\n`, async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("t6-truncated");
      await markDriftReported(sessionKey, path, ["abc"]);
      const view = await readAndServe(localIO(), "big.txt", cwd, { sessionKey });
      expect(view.served).toHaveLength(2000);
      expect(view.text).toContain("Use offset=2001 to continue.");
      expect(await driftReported(sessionKey, path)).toEqual(new Set(["abc"]));
    });
  });

  it("the window fields are 1-indexed positive integers: offset 0 and limit 0 fail loudly (T3a/T3c)", async () => {
    await withTempFile("z.txt", "one\ntwo\n", async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("t6-zero-window");
      for (const shape of [
        { offset: 0, limit: 1 },
        { offset: 1, limit: 0 },
      ]) {
        let caught: unknown;
        try {
          await readAndServe(localIO(), "z.txt", cwd, { sessionKey, ...shape });
        } catch (error) {
          caught = error;
        }
        expect((caught as { code?: string }).code, JSON.stringify(shape)).toBe("E_BAD_PAYLOAD");
      }
      // The control: a valid window is served and preserves drift-reported.
      await markDriftReported(sessionKey, path, ["abc"]);
      const view = await readAndServe(localIO(), "z.txt", cwd, { sessionKey, offset: 1, limit: 1 });
      expect(view.served).toHaveLength(1);
      expect(await driftReported(sessionKey, path)).toEqual(new Set(["abc"]));
    });
  });
});
