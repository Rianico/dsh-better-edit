import { readFile } from "node:fs/promises";
import { describe, expect, it, beforeAll } from "vitest";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { canonDigest } from "../../src/hashline/hash-assign.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { withWorkspace } from "../../src/workspace-context.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

async function internalStore(): Promise<InternalHashStore> {
  return (await loadHashStore()) as InternalHashStore;
}

function rowAnchors(result: { content: Array<{ text?: string }> }): string[] {
  return getText(result)
    .split("\n")
    .filter((line) => line.includes("│"))
    .map((line) => extractHash(line));
}

describe("undo leases — read, edit, undo through the real tools", () => {
  it("pre-edit anchors resolve again with pre-edit ids; added lines stay retired", async () => {
    await withTempFile("undo-flow.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const readTool = harness.getTool("read");
      const editTool = harness.getTool("edit");
      const read = async () =>
        rowAnchors(await readTool.execute("read", { path: "undo-flow.txt" }));
      const leases = () => withWorkspace(cwd, () => internalStore());
      const fileText = () => readFile(path, "utf8");

      // Step 1 — read: full serve, ids 1..4 on a fresh path.
      const servedA = await read();
      expect(servedA).toHaveLength(4);
      const betaAnchor = servedA[1]!;
      const initialText = await fileText();
      const lineageA = await withWorkspace(cwd, async () =>
        (await leases()).lineageFor(path, snapshotHashFor(initialText)),
      );
      expect(lineageA.map((row) => row.lineId)).toEqual([1, 2, 3, 4]);

      // Step 2 — edit 1 removes the beta line (beta's lease must retire).
      await editTool.execute("edit", {
        path: "undo-flow.txt",
        anchor_from: betaAnchor,
        anchor_to: betaAnchor,
        replace_with: "",
      });
      const textB1 = await fileText();
      expect(textB1).not.toContain("beta");
      const storeB1 = await leases();
      const betaLease = await withWorkspace(cwd, async () =>
        storeB1.leaseFor("test-session", path, betaAnchor),
      );
      expect(betaLease).toBeDefined();
      expect(betaLease?.retiredAt).not.toBeNull();

      // Step 3 — edit 2 renames gamma to GAMMA (granted live now, gone after undo).
      const gammaAnchorB1 = await withWorkspace(cwd, async () => {
        const store = await leases();
        const rows = store.lineageFor(path, snapshotHashFor(textB1));
        const gamma = rows.find((row) => row.lineId === 3);
        return gamma!.anchor;
      });
      await editTool.execute("edit", {
        path: "undo-flow.txt",
        anchor_from: gammaAnchorB1,
        anchor_to: gammaAnchorB1,
        replace_with: "GAMMA",
      });
      const textC = await fileText();
      expect(textC).toContain("GAMMA");
      const storeC = await leases();
      const gammaAnchorNow = await withWorkspace(cwd, async () => {
        const rows = storeC.lineageFor(path, snapshotHashFor(textC));
        return rows.find((row) => row.lineId !== 1)!.anchor;
      });
      const gammaLive = await withWorkspace(cwd, async () =>
        storeC.leaseFor("test-session", path, gammaAnchorNow),
      );
      expect(gammaLive?.retiredAt).toBeNull();

      // Step 4 — undo reverts edit 2, restoring the edit-1 content.
      const undoTool = harness.getTool("undo_last_edit");
      await undoTool.execute("undo", { path: "undo-flow.txt" });
      expect(await fileText()).toBe(textB1);

      // Evidence 1: the restore revives the exact pre-edit assignments — same anchor,
      // same line id (ADR-0017 reversal). The revived anchor is live again; the
      // superseded post-edit anchor is the one that retires.
      const storeU = await leases();
      const lineageU = await withWorkspace(cwd, async () =>
        storeU.lineageFor(path, snapshotHashFor(textB1)),
      );
      const gammaRowU = lineageU.find((row) => row.canonHash === canonDigest("gamma"));
      expect(gammaRowU).toBeDefined();
      expect(gammaRowU?.lineId).toBe(3);
      const restoredGammaAnchor = gammaRowU!.anchor;
      expect(restoredGammaAnchor).toBe(gammaAnchorB1);
      const gammaRestored = await withWorkspace(cwd, async () =>
        storeU.leaseFor("test-session", path, restoredGammaAnchor),
      );
      expect(gammaRestored).toBeDefined();
      expect(gammaRestored?.retiredAt).toBeNull();
      expect(gammaRestored?.lineId).toBe(3);
      // Adopt, not fresh: exact pre-edit ids per line (fresh would differ).
      const idByCanon = new Map(lineageU.map((row) => [row.canonHash, row.lineId] as const));
      expect(idByCanon.get(canonDigest("alpha"))).toBe(1);
      expect(idByCanon.get(canonDigest("gamma"))).toBe(3);
      expect(idByCanon.get(canonDigest("delta"))).toBe(4);
      // The superseded assignment is never resurrected.
      // The superseded post-edit assignment never comes back: the line it named left the
      // restored content, so its anchor stays retired.
      const gammaSuperseded = await withWorkspace(cwd, async () =>
        storeU.leaseFor("test-session", path, gammaAnchorNow),
      );
      expect(gammaSuperseded?.retiredAt).not.toBeNull();

      // Evidence 2: the line the edit removed and the undo never re-served stays retired
      // (the restored assignment is the pre-edit one, not a fresh allocation).
      const betaStill = await withWorkspace(cwd, async () =>
        storeU.leaseFor("test-session", path, betaAnchor),
      );
      expect(betaStill).toBeDefined();
      expect(betaStill?.retiredAt).not.toBeNull();
    });
  });

  it("stale post-edit anchors fail loudly and change nothing", async () => {
    // Guard mechanism: the served-anchor hash-equality check in applyEdit
    // (anchor-pipeline.ts) rejects anchors absent from the current assignment —
    // after the restore that is the superseded post-edit anchor, not the pre-edit one.
    await withTempFile("undo-stale.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const readTool = harness.getTool("read");
      const editTool = harness.getTool("edit");
      const read = async () =>
        rowAnchors(await readTool.execute("read", { path: "undo-stale.txt" }));
      const fileText = () => readFile(path, "utf8");
      const servedA = await read();
      const betaAnchor = servedA[1]!;
      await editTool.execute("edit", {
        path: "undo-stale.txt",
        anchor_from: betaAnchor,
        anchor_to: betaAnchor,
        replace_with: "",
      });
      const textB1 = await fileText();
      const gammaAnchorB1 = await withWorkspace(cwd, async () => {
        const store = await internalStore();
        const rows = store.lineageFor(path, snapshotHashFor(textB1));
        return rows.find((row) => row.lineId === 3)!.anchor;
      });
      const editResult = await editTool.execute("edit", {
        path: "undo-stale.txt",
        anchor_from: gammaAnchorB1,
        anchor_to: gammaAnchorB1,
        replace_with: "GAMMA",
      });
      const supersededAnchor = getText(editResult)
        .split("\n")
        .find((line) => line.startsWith("+") && line.endsWith("│GAMMA"))!
        .slice(1)
        .split("│")[0]!;
      expect(supersededAnchor).not.toBe(gammaAnchorB1);
      const undoTool = harness.getTool("undo_last_edit");
      await undoTool.execute("undo", { path: "undo-stale.txt" });
      expect(await fileText()).toBe(textB1);
      const restoredGammaAnchor = await withWorkspace(cwd, async () => {
        const store = await internalStore();
        const rows = store.lineageFor(path, snapshotHashFor(textB1));
        return rows.find((row) => row.lineId === 3)!.anchor;
      });
      expect(restoredGammaAnchor).toBe(gammaAnchorB1);
      const { codeOf } = await import("../../src/utils.js");
      const beforeStale = await fileText();
      let threw = false;
      let staleCode: string | undefined;
      let staleMessage = "";
      try {
        await editTool.execute("edit", {
          path: "undo-stale.txt",
          anchor_from: supersededAnchor,
          anchor_to: supersededAnchor,
          replace_with: "STALE",
        });
      } catch (error) {
        threw = true;
        staleCode = codeOf(error);
        staleMessage = error instanceof Error ? error.message : String(error);
      }
      expect(threw).toBe(true);
      expect(staleCode).toBe("E_STALE_ANCHOR");
      expect(staleMessage).toContain("[E_STALE_ANCHOR]");
      expect(await fileText()).toBe(beforeStale);
    });
  });
});
