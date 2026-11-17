import { writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { readAndServe, type ReadAndServeOptions } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";
import { sessionKeyFor } from "../../src/workspace-context.js";
import { withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hasher.js";

beforeAll(async () => {
  await initHasher();
});

/**
 * arch-T3 — one full-read authority at the store seam.
 *
 * The defect these cells pin: `readAndServe` classifies a read as full from the *request shape*
 * (`offset`/`limit`/`windows` absent and no truncation), while `recordServed` classifies it from
 * the *served rows* (`rows.length === hashes.length` and dense). A request that pages over the
 * whole file is therefore "not full" for `driftReported` and "full" for everything else it owns —
 * retired anchors, hazard cards, and the served canon array — so a paged read silently throws
 * away hazard state that only a full read is entitled to clear.
 *
 * Measured on this tree (see `tmp/arch-t3-probe.md`): `{limit: 1_000_000}`,
 * `{offset: 1, limit: 4}` and `windows: [{offset: 1, limit: 4}]` on a 4-line file all clear
 * retired + cards and overwrite the canon array while `driftReported` survives.
 */

const FILE = "full-read.txt";
/** Four addressable lines; the smallest file where "paged" and "whole file" can disagree. */
const CONTENT = "one\ntwo\nthree\nfour\n";

/**
 * Ten sentinel canons for a 4-line file. The length is the discriminator: the full branch
 * overwrites the array with the dense 4-entry one, the preserve branch merges into place and
 * keeps the length, so an overwrite is distinguishable from a merge.
 */
const JUNK_CANONS = Array.from({ length: 10 }, () => "JUNK");

async function internalStore(): Promise<InternalHashStore> {
  return (await loadHashStore()) as InternalHashStore;
}

/**
 * Seed the three things a full read owns, so a read that clears them is observable:
 * - a retired anchor at an unknown death position (`deathPos: null` — the shape no partial sweep
 *   is allowed to drain),
 * - a hazard card,
 * - a canon array longer than the file (a full read replaces it wholesale).
 */
async function seedFullReadOwned(sessionKey: string, path: string): Promise<void> {
  const store = await internalStore();
  store.clearRetiredAnchors(sessionKey, path);
  store.upsertRetiredAnchors(sessionKey, path, JSON.stringify([{ hash: "ZZZ", deathPos: null }]));
  store.clearCards(sessionKey, path);
  store.upsertCards(sessionKey, path, JSON.stringify([999]));
  store.upsertServedCanons(sessionKey, path, JSON.stringify(JUNK_CANONS));
}

async function fullReadOwnedState(
  sessionKey: string,
  path: string,
): Promise<{ retired: string[]; cards: number[]; canons: (string | null)[] }> {
  const store = await internalStore();
  return {
    retired: store.getRetiredEntries(sessionKey, path).map((entry) => entry.hash),
    cards: [...store.getCards(sessionKey, path)].sort((a, b) => a - b),
    canons: store.getServedCanons(sessionKey, path),
  };
}

describe("full-read authority — only a plain whole-file read owns the clearing", () => {
  it("a paged read that serves the whole file clears nothing a full read owns", async () => {
    await withTempFile(FILE, CONTENT, async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("arch-t3-paged-whole-file");
      const store = await internalStore();
      // Baseline: a plain full read, so the served record and the leases exist before seeding.
      await readAndServe(localIO(), FILE, cwd, { sessionKey });

      // Every shape below serves all four lines — the whole file — but is not a plain read.
      const shapes: { label: string; options: Omit<ReadAndServeOptions, "sessionKey"> }[] = [
        { label: "{limit: 1_000_000}", options: { limit: 1_000_000 } },
        { label: "{offset: 1, limit: 4}", options: { offset: 1, limit: 4 } },
        {
          label: "{windows: [{offset: 1, limit: 4}]}",
          options: { windows: [{ offset: 1, limit: 4 }] },
        },
      ];

      for (const { label, options } of shapes) {
        await seedFullReadOwned(sessionKey, path);
        const view = await readAndServe(localIO(), FILE, cwd, { sessionKey, ...options });
        // The premise of every assertion below: this shape really did serve the whole file.
        expect(view.served.length, label).toBe(4);

        const state = await fullReadOwnedState(sessionKey, path);
        // (i) the retired anchor at an unknown death position survives.
        expect(state.retired, label).toContain("ZZZ");
        // (ii) the hazard card survives.
        expect(state.cards, label).toContain(999);
        // (iii) the canon array is merged into, not replaced: the 10-entry sentinel array keeps
        // its length, and the slots past the served window are still JUNK. (An exact
        // `=== JUNK_CANONS` compare would be wrong even after the fix — the preserve branch
        // legitimately refreshes the canons of the positions it served.)
        expect(state.canons.length, label).toBe(JUNK_CANONS.length);
        expect(state.canons.slice(4), label).toEqual(JUNK_CANONS.slice(4));
        // (iv) the epoch pin must not move for content that did not change.
        const anchor = view.served[1]!.hash;
        expect(store.leaseFor(sessionKey, path, anchor)?.snapshotHash, label).toBe(
          snapshotHashFor(CONTENT),
        );
      }
    });
  });

  it("a full read still owns those effects (positive control)", async () => {
    // This cell passes BOTH before and after the fix: it is the control that keeps the fix
    // honest — the clearing must not be removed from the path that is entitled to it.
    await withTempFile(FILE, CONTENT, async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("arch-t3-plain-full");
      await readAndServe(localIO(), FILE, cwd, { sessionKey });

      await seedFullReadOwned(sessionKey, path);
      const view = await readAndServe(localIO(), FILE, cwd, { sessionKey });
      expect(view.served).toHaveLength(4);

      const state = await fullReadOwnedState(sessionKey, path);
      expect(state.retired).toEqual([]);
      expect(state.cards).toEqual([]);
      expect(state.canons).toEqual(["one", "two", "three", "four"]);
    });
  });

  it("a genuinely partial page preserves hazard state through the partial branch", async () => {
    // Also passes BOTH before and after (`{offset: 1, limit: 2}` never served the whole file, so
    // it already takes the preserve branch): this is the pin on the path the fix must reuse.
    await withTempFile(FILE, CONTENT, async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("arch-t3-partial-page");
      await readAndServe(localIO(), FILE, cwd, { sessionKey });

      await seedFullReadOwned(sessionKey, path);
      const view = await readAndServe(localIO(), FILE, cwd, {
        sessionKey,
        offset: 1,
        limit: 2,
      });
      expect(view.served.map((row) => row.position)).toEqual([0, 1]);

      const state = await fullReadOwnedState(sessionKey, path);
      expect(state.retired).toContain("ZZZ");
      // The page's own positions join the card set — that is the sweep doing its job, so the
      // assertion is survival of the seeded card, not exact set equality.
      expect(state.cards).toContain(999);
      expect(state.canons.length).toBe(JUNK_CANONS.length);
    });
  });

  it("a page of changed content keeps its anchors leasable", async () => {
    // Passes BOTH before and after: this cell pins the decision NOT to gate the lease grant /
    // epoch pin. A paged read of content that changed on disk advances the pin to what it
    // served — that is load-bearing, because an unleased row cannot be edited back
    // (`E_STALE_RANGE`). Gating the grant is explicitly out of scope for this fix.
    const changed = "one\ntwo\nthree\nFOUR-CHANGED\n";
    await withTempFile(FILE, CONTENT, async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("arch-t3-paged-changed");
      const store = await internalStore();
      const baseline = await readAndServe(localIO(), FILE, cwd, { sessionKey });
      const previousAnchor = baseline.served[3]!.hash;

      await writeFile(path, changed, "utf-8");
      const view = await readAndServe(localIO(), FILE, cwd, { sessionKey, limit: 1_000_000 });
      expect(view.served).toHaveLength(4);

      // Every served row is leasable — otherwise the edit path cannot resolve it.
      for (const row of view.served) {
        expect(store.leaseFor(sessionKey, path, row.hash), row.hash).toBeDefined();
      }

      // The changed line's own anchor (line 4 was `four`) leases against the changed content and
      // resolves through that snapshot's lineage.
      const changedRow = view.served.find((row) => row.position === 3)!;
      expect(changedRow.hash).not.toBe(previousAnchor);
      const lease = store.leaseFor(sessionKey, path, changedRow.hash)!;
      expect(lease).toBeDefined();
      expect(lease.lineNumber).toBe(4);
      expect(lease.snapshotHash).toBe(snapshotHashFor(changed));
      expect(
        store.lineageFor(path, lease.snapshotHash).some((row) => row.anchor === changedRow.hash),
      ).toBe(true);
    });
  });
});
