import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
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
  store: InternalHashStore;
  /** The pre-edit content the undo restores. */
  restoredContent: string;
  /** Snapshot anchors for the restored content, captured before the undo. */
  beforeAnchors: string[] | undefined;
  /** Served/leased anchors for this session+path, captured before the undo. */
  beforeServedAnchors: Set<string>;
}

async function probe(cwd: string, harness: Harness): Promise<UndoProbe> {
  const abs = await harness.io.resolve("t.txt", cwd, new AbortController().signal);
  // Narrowed to the internal view: the cross-pair cell must stub `commitSnapshot`, a
  // LineageStore seam member the public `HashStore` view deliberately hides (the same
  // narrowing test/core/serve-leases.test.ts uses for the served/lease seam).
  const store = (await loadHashStore(cwd)) as InternalHashStore;
  const entry = store.getUndo(abs);
  if (entry === undefined) throw new Error("expected an undo pair after one edit");
  return {
    abs,
    store,
    restoredContent: entry.content,
    beforeAnchors: store.getSnapshot(abs, entry.content),
    beforeServedAnchors: store.getAnchorReservations(harness.sessionKey, abs).reservedHashes,
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

/**
 * The anchors the tool advertised for follow-up edits: the restored rows of its own diff
 * (the `+` rows — `genDiff` marks removed rows `-` and context rows ` `). These are the
 * anchors the tool's success message explicitly hands the model.
 */
function restoredAnchorsFromToolOutput(text: string): string[] {
  const anchors: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\+\s*(?:\d+\s+)?([A-Za-z0-9]{3})│/.exec(line);
    if (match?.[1] !== undefined) anchors.push(match[1]);
  }
  return anchors;
}

/** Did an edit with this anchor apply, or was it refused by the tool's error surface? */
async function editOutcome(harness: Harness, anchor: string): Promise<"applied" | "rejected"> {
  try {
    const result = await harness.editTool.execute("edit", {
      path: "t.txt",
      edits: [[anchor, anchor, "Q"]],
    });
    return /\[E_[A-Z_]+\]/.test(getText(result)) ? "rejected" : "applied";
  } catch {
    return "rejected";
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
  it("holds both pair writes down: the serve path cannot mask the split", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      await applyOneEdit(harness);
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\n");
      const p = await probe(cwd, harness);

      // Hold BOTH writes of the pair down: the adopt (`upsertSnapshot`) and the serve-path
      // re-materialization (`commitSnapshot` — the LineageStore seam member `grantServeLeases`
      // calls from `recordServedTruncated`). A one-shot adopt spy alone let the serve path
      // rebuild the v7 side, which is why the r1 counterexample could not show the damage.
      const adopt = vi.spyOn(p.store, "upsertSnapshot").mockImplementation(() => {
        throw new Error("injected: pair-adopt fault");
      });
      const serve = vi.spyOn(p.store, "commitSnapshot").mockImplementation(() => {
        throw new Error("injected: serve-path fault");
      });

      let returned: string | undefined;
      let fault: unknown;
      try {
        returned = getText(await harness.undoTool.execute("undo_last_edit", { path: "t.txt" }));
      } catch (error) {
        fault = error;
      }
      const advertised = returned === undefined ? [] : restoredAnchorsFromToolOutput(returned);
      const servedAnchors = p.store.getAnchorReservations(harness.sessionKey, p.abs).reservedHashes;

      // Every probe is measured here, never inferred from the claim under test.
      const endState = {
        toolClaimedSuccess: returned !== undefined && returned.includes("Undone last edit"),
        faultCode: codeOf(fault),
        undoPairPresent: p.store.getUndo(p.abs) !== undefined,
        restoredSnapshotUnchanged:
          JSON.stringify(p.store.getSnapshot(p.abs, p.restoredContent)) ===
          JSON.stringify(p.beforeAnchors),
        advertisedAnchorsServed:
          advertised.length === 0 ? "n/a" : advertised.every((hash) => servedAnchors.has(hash)),
        followUpEdit: "not-attempted:tool-faulted" as string,
        nextOperation: "not-attempted" as string,
      };

      adopt.mockRestore();
      serve.mockRestore();

      if (advertised[0] !== undefined) {
        endState.followUpEdit = await editOutcome(harness, advertised[0]);
      }

      const reread = await harness.readTool.execute("read", { path: "t.txt" });
      const row = getText(reread)
        .split("\n")
        .find((line) => line.includes("│b"));
      if (row === undefined) throw new Error("re-read did not serve line b");
      const hash = row.split("│")[0];
      if (hash === undefined) throw new Error("re-read row carried no anchor");
      endState.nextOperation = await editOutcome(harness, hash);
      expect(endState).toEqual({
        toolClaimedSuccess: false,
        faultCode: "E_UNDO_NOT_RECORDED",
        undoPairPresent: true,
        restoredSnapshotUnchanged: true,
        advertisedAnchorsServed: "n/a",
        followUpEdit: "not-attempted:tool-faulted",
        nextOperation: "applied",
      });
    });
  });
});
