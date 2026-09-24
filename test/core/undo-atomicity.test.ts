import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";
import { loadHashStore } from "../../src/hash-store.js";
import { codeOf } from "../../src/utils.js";

/**
 * Cross-pair undo atomicity (T3b CP1).
 *
 * `undo_last_edit`'s restore path writes the file, then commits two store rows: the
 * snapshot/lineage adopt (`upsertSnapshot`) and the undo-pair clear (`deleteUndoPair`).
 * The file write is outside any transaction, so the store pair is the only thing that
 * can be atomic — and it must be both-or-neither. A half-applied pair (adopt absent,
 * pair cleared) is a state no later `read`/`edit`/`undo_last_edit` can detect.
 *
 * Faults are deterministic (`vi.spyOn` on the cached store object): no timing race, no
 * sleep, no production fault-injection flag.
 */

type Harness = ReturnType<typeof setupIntegrationTest>;

/** Read once, then apply one edit, so a real undo pair exists. */
async function applyOneEdit(harness: Harness): Promise<void> {
  const served = await harness.readTool.execute("read", { path: "t.txt" });
  const row = getText(served)
    .split("\n")
    .find((line) => line.includes("│b"));
  if (row === undefined) throw new Error("read did not serve line b");
  const hash = row.split("│")[0];
  if (hash === undefined) throw new Error("served row carried no anchor");
  await harness.editTool.execute("edit", {
    path: "t.txt",
    edits: [[hash, hash, "B"]],
  });
}

interface UndoProbe {
  /** Canonical path, identical to the one `undo_last_edit` resolves. */
  abs: string;
  /** The cached store the tool itself uses (`loadHashStore(cwd)` is that entry). */
  store: Awaited<ReturnType<typeof loadHashStore>>;
  /** The pre-edit content the undo restores. */
  restoredContent: string;
  /** Snapshot anchors for the restored content, captured before the undo. */
  beforeAnchors: string[] | undefined;
}

async function probe(cwd: string, harness: Harness): Promise<UndoProbe> {
  const abs = await harness.io.resolve("t.txt", cwd, new AbortController().signal);
  const store = await loadHashStore(cwd);
  const entry = store.getUndo(abs);
  if (entry === undefined) throw new Error("expected an undo pair after one edit");
  return {
    abs,
    store,
    restoredContent: entry.content,
    beforeAnchors: store.getSnapshot(abs, entry.content),
  };
}

/** The invariant: the pair clear and the snapshot adopt landed together, or neither did. */
function pairState(p: UndoProbe): { pairCleared: boolean; adoptLanded: boolean } {
  return {
    pairCleared: p.store.getUndo(p.abs) === undefined,
    adoptLanded:
      JSON.stringify(p.store.getSnapshot(p.abs, p.restoredContent)) !==
      JSON.stringify(p.beforeAnchors),
  };
}

/** Run the undo, returning the thrown error (or undefined when it returned normally). */
async function undoFaulting(harness: Harness): Promise<unknown> {
  try {
    await harness.undoTool.execute("undo_last_edit", { path: "t.txt" });
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("undo atomicity — the snapshot adopt and the undo-pair clear", () => {
  it("reports a snapshot-adopt fault and keeps the undo pair", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      await applyOneEdit(harness);
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\n");
      const p = await probe(cwd, harness);

      const adopt = vi.spyOn(p.store, "upsertSnapshot").mockImplementation(() => {
        throw new Error("injected: snapshot-adopt fault");
      });
      const fault = await undoFaulting(harness);
      adopt.mockRestore();

      // The file write is outside the unit and stands.
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");

      // Both-or-neither: the adopt faulted, so the pair must NOT have been cleared.
      expect(pairState(p)).toEqual({ pairCleared: false, adoptLanded: false });

      // No silent swallow: the fault is reported, and never as a successful undo.
      expect(codeOf(fault)).toBe("E_UNDO_NOT_RECORDED");
      expect(String(fault)).not.toContain("Undone last edit");
    });
  });

  it("rolls the snapshot adopt back when the undo-pair clear faults", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      await applyOneEdit(harness);
      const p = await probe(cwd, harness);

      const clear = vi.spyOn(p.store, "deleteUndoPair").mockImplementation(() => {
        throw new Error("injected: undo-pair-clear fault");
      });
      const fault = await undoFaulting(harness);
      clear.mockRestore();

      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");

      // The adopt ran first; only a shared unit can roll it back with the failed clear.
      expect(pairState(p)).toEqual({ pairCleared: false, adoptLanded: false });
      expect(codeOf(fault)).toBe("E_UNDO_NOT_RECORDED");
    });
  });

  it("after an adopt fault the next undo terminates the retained pair", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      await applyOneEdit(harness);
      const p = await probe(cwd, harness);

      const adopt = vi.spyOn(p.store, "upsertSnapshot").mockImplementation(() => {
        throw new Error("injected: snapshot-adopt fault");
      });
      await undoFaulting(harness);
      adopt.mockRestore();

      // Recoverable: the pair is retained, the file is reverted, so the next undo sees a
      // file that no longer matches the recorded post-edit content and clears the pair.
      expect(p.store.getUndo(p.abs)).toBeDefined();
      const second = await harness.undoTool.execute("undo_last_edit", { path: "t.txt" });
      expect(getText(second)).toContain("E_UNDO_STALE");
      expect(p.store.getUndo(p.abs)).toBeUndefined();
    });
  });

  it("a write fault retires anchors but leaves a state a read can escape (deliverable C)", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      await applyOneEdit(harness);
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\n");

      const write = vi.spyOn(harness.io, "writeText").mockImplementation(() => {
        throw new Error("injected: file-write fault");
      });
      const fault = await undoFaulting(harness);
      write.mockRestore();

      // `retireAnchors` runs before the write, so the anchors are retired and the file is
      // unchanged; the store pair is untouched because it runs after the write.
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\n");
      const store = await loadHashStore(cwd);
      const abs = await harness.io.resolve("t.txt", cwd, new AbortController().signal);
      expect(store.getUndo(abs)).toBeDefined();
      expect(fault).toBeDefined();

      // Terminating recovery: a read re-serves the unchanged file, and its fresh anchors edit.
      const served = await harness.readTool.execute("read", { path: "t.txt" });
      const row = getText(served)
        .split("\n")
        .find((line) => line.includes("│B"));
      if (row === undefined) throw new Error("re-read did not serve line B");
      const hash = row.split("│")[0];
      if (hash === undefined) throw new Error("re-read row carried no anchor");
      await harness.editTool.execute("edit", { path: "t.txt", edits: [[hash, hash, "Z"]] });
      expect(await readFile(path, "utf-8")).toBe("a\nZ\nc\n");
    });
  });
});
