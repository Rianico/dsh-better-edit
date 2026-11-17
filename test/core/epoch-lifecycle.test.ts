import { describe, expect, it, beforeAll } from "vitest";
import { readAndServe, type ReadAndServeOptions } from "../../src/read-and-serve.js";
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

/**
 * Seed the three things only a full read owns, so a read that clears them is observable: a
 * retired anchor at an unknown death position (`deathPos: null` — the shape no partial sweep may
 * drain), a hazard card, and a canon array longer than the file (a full read replaces it
 * wholesale, a preserve path merges in place and keeps the length).
 */
async function seedFullReadOwned(sessionKey: string, path: string): Promise<void> {
  const store = await internalStore();
  store.clearRetiredAnchors(sessionKey, path);
  store.upsertRetiredAnchors(sessionKey, path, JSON.stringify([{ hash: "ZZZ", deathPos: null }]));
  store.clearCards(sessionKey, path);
  store.upsertCards(sessionKey, path, JSON.stringify([999]));
  store.upsertServedCanons(
    sessionKey,
    path,
    JSON.stringify(Array.from({ length: 10 }, () => "JUNK")),
  );
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

  it("a windowed read leaves the lease identity and the hazard state alone", async () => {
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

      // Between the full read and the windowed reads, seed what only a full read owns. Without
      // these sentinels the cell could not fail: both reads derive the same `snapshotHash`
      // (content-addressed, and the file is untouched here), so nothing observable was asserted
      // about the windowed read's side effects. Three shapes, none of them a plain read: a
      // genuinely partial page (the preserve branch) and two windows that cover the whole file
      // (the shapes a read-*shape* verdict alone would call "full").
      const shapes: { label: string; options: Omit<ReadAndServeOptions, "sessionKey"> }[] = [
        { label: "{offset: 1, limit: 2}", options: { offset: 1, limit: 2 } },
        { label: "{offset: 1, limit: 4}", options: { offset: 1, limit: 4 } },
        {
          label: "{windows: [{offset: 1, limit: 4}]}",
          options: { windows: [{ offset: 1, limit: 4 }] },
        },
      ];

      for (const { label, options } of shapes) {
        await seedFullReadOwned(sessionKey, path);
        const windowed = await readAndServe(localIO(), "e.txt", cwd, { sessionKey, ...options });
        // Line 2 is inside every shape above; the read really does serve the served snapshot.
        const servedLine2 = windowed.served.find((row) => row.position === 1)!;

        // The lease identity of the row the window served: still defined, stamped with the
        // served snapshot's hash — not a window-scoped one — and still the served line number.
        // (Asserted on the row's own anchor, not on the baseline full read's: with hazard
        // reservations present the anchor assignment may move, and a baseline-anchor lookup
        // would silently read the old, untouched lease row — the over-claim this cell used to
        // make.)
        const after = store.leaseFor(sessionKey, path, servedLine2.hash);
        expect(after, label).toBeDefined();
        expect(after?.snapshotHash, label).toBe(snapshotHashFor(content));
        expect(after?.lineNumber, label).toBe(2);

        // The hazard state: no windowed read touches it.
        expect(
          store.getRetiredEntries(sessionKey, path).map((entry) => entry.hash),
          label,
        ).toContain("ZZZ");
        expect([...store.getCards(sessionKey, path)], label).toContain(999);
        expect(store.getServedCanons(sessionKey, path).length, label).toBe(10);
      }
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
