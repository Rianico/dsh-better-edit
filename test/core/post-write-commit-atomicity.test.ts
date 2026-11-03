import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { initHasher } from "../../src/hashline/hasher.js";
import { getUndo } from "../../src/undo-edit.js";
import { loadAnchorReservations } from "../../src/session-view.js";
import { loadHashStore } from "../../src/hash-store.js";
import { withWorkspace } from "../../src/workspace-context.js";
import type { FileIO } from "../../src/fs-bridge.js";
import { localIO } from "../../src/fs-bridge.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * #98 (port of upstream a7bc3de CAND-3): post-write store commitments belong AFTER the write,
 * and each path commits them as one unit. Two previously torn states:
 *
 * - edit: the apply phase retired the anchors its edit freed, before the write existed — a failed
 *   write left a file's live anchors marked dead;
 * - undo: retirement ran before `writeText`, so a failed revert retired the anchors it never
 *   freed, and the restore's snapshot adopt / retirement / undo-pair clear were separate units.
 */

const ORIGINAL = "alpha\nbravo\ncharlie\n";
const EDITED = "alpha\nbravo edited\ncharlie\n";

beforeAll(async () => {
  await initHasher();
});

function rowsOf(result: { content: Array<{ text?: string }> }): string[] {
  return getText(result)
    .split("\n")
    .filter((line) => line.includes("│"));
}

function ioWithFailingWrite(): FileIO {
  return {
    ...localIO(),
    async writeText(): Promise<void> {
      throw new Error("induced write failure");
    },
  } as FileIO;
}

describe("edit commit ordering (#98, upstream CAND-3)", () => {
  it("a failed write retires nothing and leaves the file untouched", async () => {
    await withTempFile("cand3_edit_order.txt", ORIGINAL, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("r1", { path: "cand3_edit_order.txt" });
      const bravo = extractHash(rowsOf(read)[1]!);

      const before = await withWorkspace(cwd, () => loadAnchorReservations("test-session", path));

      const failingHarness = setupIntegrationTest(cwd, ioWithFailingWrite());
      await expect(
        failingHarness.editTool.execute("e1", {
          path: "cand3_edit_order.txt",
          anchor_from: bravo,
          anchor_to: bravo,
          replace_with: "bravo edited",
        }),
      ).rejects.toThrow();

      expect(await readFile(path, "utf8")).toBe(ORIGINAL);
      const afterFailure = await withWorkspace(cwd, () =>
        loadAnchorReservations("test-session", path),
      );
      // The anchor the edit would have freed is still live: nothing was retired for a write
      // that never landed.
      expect([...afterFailure.retiredHashes].sort()).toEqual([...before.retiredHashes].sort());
    });
  });

  it("a landed edit retires the anchors it freed", async () => {
    await withTempFile("cand3_edit_landed.txt", ORIGINAL, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("r1", { path: "cand3_edit_landed.txt" });
      const bravo = extractHash(rowsOf(read)[1]!);
      await harness.editTool.execute("e1", {
        path: "cand3_edit_landed.txt",
        anchor_from: bravo,
        anchor_to: bravo,
        replace_with: "bravo edited",
      });
      expect(await readFile(path, "utf8")).toBe(EDITED);
      const after = await withWorkspace(cwd, () => loadAnchorReservations("test-session", path));
      expect(after.retiredHashes.has(bravo)).toBe(true);
    });
  });
});

describe("undo commit ordering and atomicity (#98, upstream CAND-3)", () => {
  it("a failed revert commits neither its retirement nor the undo-pair clear", async () => {
    await withTempFile("cand3_undo_order.txt", ORIGINAL, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("r1", { path: "cand3_undo_order.txt" });
      const bravo = extractHash(rowsOf(read)[1]!);
      await harness.editTool.execute("e1", {
        path: "cand3_undo_order.txt",
        anchor_from: bravo,
        anchor_to: bravo,
        replace_with: "bravo edited",
      });
      expect(await readFile(path, "utf8")).toBe(EDITED);

      const before = await withWorkspace(cwd, () => loadAnchorReservations("test-session", path));
      // The pre-edit anchors are already retired by the edit; the post-edit hashes are live.
      const retiredBefore = new Set(before.retiredHashes);

      const failingHarness = setupIntegrationTest(cwd, ioWithFailingWrite());
      await expect(
        failingHarness.undoTool.execute("u1", { path: "cand3_undo_order.txt" }),
      ).rejects.toThrow();

      // The bytes never changed...
      expect(await readFile(path, "utf8")).toBe(EDITED);

      const afterFailure = await withWorkspace(cwd, () =>
        loadAnchorReservations("test-session", path),
      );
      // ...and the store did not move either: no revert-freed anchor was retired, and the
      // undo pair survives so a later undo still works.
      expect([...afterFailure.retiredHashes].sort()).toEqual([...retiredBefore].sort());
      expect(await withWorkspace(cwd, () => getUndo(path))).toBeDefined();

      // A real undo then lands and reverts; the pair is consumed.
      await harness.undoTool.execute("u2", { path: "cand3_undo_order.txt" });
      expect(await readFile(path, "utf8")).toBe(ORIGINAL);
      expect(await withWorkspace(cwd, () => getUndo(path))).toBeUndefined();
      // The revert freed the post-edit hash, so it is retired by the same unit.
      const afterUndo = await withWorkspace(cwd, () =>
        loadAnchorReservations("test-session", path),
      );
      expect(afterUndo.retiredHashes.size).toBeGreaterThan(retiredBefore.size);
    });
  });

  it("a store fault inside the restore unit rolls the whole triple back", async () => {
    // The failure is injected in the LAST statement of the unit (`deleteUndoPair`), so the
    // snapshot adopt and the retirement have already executed when it throws: only one
    // transaction can take all three back together.
    await withTempFile("cand3_undo_store_fault.txt", ORIGINAL, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("r1", { path: "cand3_undo_store_fault.txt" });
      const bravo = extractHash(rowsOf(read)[1]!);
      await harness.editTool.execute("e1", {
        path: "cand3_undo_store_fault.txt",
        anchor_from: bravo,
        anchor_to: bravo,
        replace_with: "bravo edited",
      });

      const before = await withWorkspace(cwd, () => loadAnchorReservations("test-session", path));
      const retiredBefore = new Set(before.retiredHashes);

      const store = await withWorkspace(cwd, () => loadHashStore());
      const originalDelete = store.deleteUndoPair.bind(store);
      let faulted = false;
      store.deleteUndoPair = (undoPath: string): void => {
        if (!faulted) {
          faulted = true;
          throw new Error("induced store fault");
        }
        originalDelete(undoPath);
      };

      try {
        await expect(
          harness.undoTool.execute("u1", { path: "cand3_undo_store_fault.txt" }),
        ).rejects.toThrow(/E_UNDO_NOT_RECORDED/);

        // The revert's write landed first...
        expect(await readFile(path, "utf8")).toBe(ORIGINAL);
        const after = await withWorkspace(cwd, () => loadAnchorReservations("test-session", path));
        // ...but the retirement that ran before the fault is rolled back with the adopt, and the
        // undo pair is still there (all three or none).
        expect([...after.retiredHashes].sort()).toEqual([...retiredBefore].sort());
        expect(await withWorkspace(cwd, () => getUndo(path))).toBeDefined();
      } finally {
        store.deleteUndoPair = originalDelete;
      }
    });
  });
});
