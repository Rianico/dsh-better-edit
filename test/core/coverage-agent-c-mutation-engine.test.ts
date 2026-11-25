import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { localIO, type FileIO } from "../../src/fs-bridge.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import {
  collectRemovedHashes,
  countLineChanges,
  applyOne,
  enforceNoopLoop,
} from "../../src/mutation/engine.js";
import { persistUndoAndWrite } from "../../src/mutation.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import * as undoMod from "../../src/undo-edit.js";

describe("coverage: mutation engine collectRemovedHashes / countLineChanges", () => {
  it("collectRemovedHashes handles found and not-found hashes", () => {
    const hashes = ["aaa", "bbb", "ccc", "ddd"];
    const edit: any = { hash_bounds: [{ hash: "bbb" }, { hash: "ccc" }], content_lines: ["x"] };
    expect(collectRemovedHashes(edit, hashes).size).toBe(2);
    // reversed hashes still collect
    const editRev: any = { hash_bounds: [{ hash: "ccc" }, { hash: "bbb" }], content_lines: ["x"] };
    expect(collectRemovedHashes(editRev, hashes).size).toBe(2);
    // not found -> empty
    const editMiss: any = { hash_bounds: [{ hash: "zzz" }, { hash: "yyy" }], content_lines: ["x"] };
    expect(collectRemovedHashes(editMiss, hashes).size).toBe(0);
    // one found one not -> empty
    const editOneMiss: any = {
      hash_bounds: [{ hash: "bbb" }, { hash: "zzz" }],
      content_lines: ["x"],
    };
    expect(collectRemovedHashes(editOneMiss, hashes).size).toBe(0);
  });

  it("countLineChanges noop returns zeros", () => {
    const edit: any = { hash_bounds: [{ hash: "aaa" }, { hash: "bbb" }], content_lines: ["new"] };
    expect(countLineChanges(edit, ["aaa", "bbb", "ccc"], true, 0)).toEqual({
      totalAddedLines: 0,
      totalRemovedLines: 0,
    });
  });

  it("countLineChanges computes removed and added lines", () => {
    const hashes = ["h1", "h2", "h3", "h4"];
    const edit: any = {
      hash_bounds: [{ hash: "h2" }, { hash: "h3" }],
      content_lines: ["a", "b", "c"],
    };
    // removed 2 lines (h2-h3), added 3 minus autoFixes 1 => 2
    expect(countLineChanges(edit, hashes, false, 1)).toEqual({
      totalAddedLines: 2,
      totalRemovedLines: 2,
    });
    // reversed bounds still works via indexOf
    const editRev: any = { hash_bounds: [{ hash: "h3" }, { hash: "h2" }], content_lines: ["a"] };
    expect(countLineChanges(editRev, hashes, false, 0).totalRemovedLines).toBe(2);
    // hashes not found -> removed 0
    const editMiss: any = {
      hash_bounds: [{ hash: "zz" }, { hash: "yy" }],
      content_lines: ["a", "b"],
    };
    expect(countLineChanges(editMiss, ["h1"], false, 0)).toEqual({
      totalAddedLines: 2,
      totalRemovedLines: 0,
    });
  });
});

describe("coverage: mutation engine applyOne", () => {
  it("applies pre-resolved edit", async () => {
    await initHasher();
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const edit: any = {
      hash_bounds: [{ hash: hashes[0]! }, { hash: hashes[0]! }],
      content_lines: ["A"],
    };
    const result = await applyOne(
      {
        content,
        hashes,
        served: [hashes[0]!, hashes[1]!, hashes[2]!],
        anchorFrom: hashes[0]!,
        anchorTo: hashes[0]!,
        replaceWith: "A",
        absolutePath: "/tmp/a.txt",
        displayPath: "a.txt",
        warnings: [],
        persist: false,
        edit,
      },
      async () => {
        throw new Error("should not reject");
      },
    );
    expect(result.result).toBe("A\nb\nc");
    expect(result.noop).toBe(false);
  });

  it("handles resEdit failure via onReject", async () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    let rejected: any;
    await applyOne(
      {
        content,
        hashes,
        served: hashes as any,
        anchorFrom: "bad hash with spaces",
        anchorTo: "also bad",
        replaceWith: "x",
        absolutePath: "/tmp/a.txt",
        displayPath: "a.txt",
        warnings: [],
        persist: false,
      },
      async (err) => {
        rejected = err;
        throw err as any;
      },
    ).catch(() => {});
    expect(rejected).toBeDefined();
  });

  it("handles anchor mismatch via onReject", async () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    let rejected: any;
    // use stale hash
    await applyOne(
      {
        content,
        hashes,
        served: hashes as any,
        anchorFrom: "zzz",
        anchorTo: "zzz",
        replaceWith: "x",
        absolutePath: "/tmp/a.txt",
        displayPath: "a.txt",
        warnings: [],
        persist: false,
      },
      async (err) => {
        rejected = err;
        throw err as any;
      },
    ).catch(() => {});
    expect(String(rejected)).toMatch(/E_STALE_ANCHOR|E_MALFORMED_ANCHOR|AnchorMismatch/);
  });

  it("noop detection keeps original hashes", async () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const result = await applyOne(
      {
        content,
        hashes,
        served: hashes as any,
        anchorFrom: hashes[0]!,
        anchorTo: hashes[0]!,
        replaceWith: "a",
        absolutePath: "/tmp/a.txt",
        displayPath: "a.txt",
        warnings: [],
        persist: false,
      },
      async (e) => {
        throw e as any;
      },
    );
    expect(result.noop).toBe(true);
    expect(result.hashes).toEqual(hashes);
  });
});

describe("coverage: mutation engine enforceNoopLoop", () => {
  it("batch: throws at threshold and notice at 2", async () => {
    const { NOOP_LOOP_THRESHOLD } = await import("../../src/constants.js");
    await expect(
      enforceNoopLoop({
        anchorFrom: "aaa",
        anchorTo: "aaa",
        displayPath: "a.txt",
        index: 0,
        count: NOOP_LOOP_THRESHOLD,
        originalNormalized: "a\nb\nc",
        echoRows: [{ position: 0, hash: "h1" }],
      }),
    ).rejects.toThrow(/E_NOOP_LOOP/);

    const notice = await enforceNoopLoop({
      anchorFrom: "aaa",
      anchorTo: "aaa",
      displayPath: "a.txt",
      index: 0,
      count: 2,
      originalNormalized: "a\nb\nc",
    });
    expect(notice).toMatch(/^\[MODEL\] \[W_NOOP\] Notice:/);
    expect(notice).toMatch(/Resend will reject the batch\./);

    const none = await enforceNoopLoop({
      anchorFrom: "aaa",
      anchorTo: "aaa",
      displayPath: "a.txt",
      index: 0,
      count: 1,
      originalNormalized: "a\nb\nc",
    });
    expect(none).toBeUndefined();
  });

  // F5 pin: the registry owns the single `Current on-disk range:` heading —
  // the engine passes raw rows, so the heading renders exactly once.
  it("batch reject renders the on-disk heading exactly once", async () => {
    const { NOOP_LOOP_THRESHOLD } = await import("../../src/constants.js");
    let caught: Error | undefined;
    try {
      await enforceNoopLoop({
        anchorFrom: "aaa",
        anchorTo: "aaa",
        displayPath: "a.txt",
        index: 0,
        count: NOOP_LOOP_THRESHOLD,
        originalNormalized: "a\nb\nc",
        echoRows: [{ position: 0, hash: "h1" }],
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toBe(
      "[TO MODEL] [E_NOOP_LOOP] edits[0] (a.txt): identical edit (aaa → aaa) submitted 3×, no changes each time. " +
        "Range already contains this text; resend will reject the batch.\nCurrent on-disk range:\nh1│a",
    );
    expect(caught!.message.match(/Current on-disk range:/g)).toHaveLength(1);
  });

  it("batch without echoRows still throws", async () => {
    const { NOOP_LOOP_THRESHOLD } = await import("../../src/constants.js");
    await expect(
      enforceNoopLoop({
        anchorFrom: "aaa",
        anchorTo: "aaa",
        displayPath: "a.txt",
        index: 1,
        count: NOOP_LOOP_THRESHOLD,
        originalNormalized: "a\nb\nc",
      }),
    ).rejects.toThrow(/E_NOOP_LOOP/);
  });
});

describe("coverage: mutation engine persistUndoAndWrite", () => {
  it("throws undo unavailable and restores previous undos", async () => {
    const saveSpy = vi
      .spyOn(undoMod, "saveUndo")
      .mockResolvedValueOnce({ persisted: true, restore: vi.fn(async () => {}) } as any)
      .mockResolvedValueOnce({ persisted: false, restore: vi.fn(async () => {}) } as any);

    const io: any = { writeText: vi.fn(async () => {}) };
    const sandbox: any = { mapError: (e: unknown) => e as Error };
    const file1: any = {
      absolutePath: "/tmp/f1.txt",
      displayPath: "f1.txt",
      originalNormalized: "a",
      bom: "",
      originalEnding: "\n",
      originalHashes: ["h1"],
      result: "b",
    };
    const file2: any = {
      absolutePath: "/tmp/f2.txt",
      displayPath: "f2.txt",
      originalNormalized: "a",
      bom: "",
      originalEnding: "\n",
      originalHashes: ["h1"],
      result: "b",
    };

    await expect(
      persistUndoAndWrite({
        io,
        files: [file1, file2],
        exec: {} as any,
        sandbox,
        sandboxPolicy: undefined,
        undoUnavailableMessage: (p) => `[E_UNDO_UNAVAILABLE] ${p}`,
      }),
    ).rejects.toThrow(/E_UNDO_UNAVAILABLE/);
    saveSpy.mockRestore();
  });

  it("writes files and restores on write failure", async () => {
    const restore1 = vi.fn(async () => {});
    const restore2 = vi.fn(async () => {});
    const saveSpy = vi
      .spyOn(undoMod, "saveUndo")
      .mockResolvedValueOnce({ persisted: true, restore: restore1 } as any)
      .mockResolvedValueOnce({ persisted: true, restore: restore2 } as any);
    const io: any = {
      writeText: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("disk full")),
    };
    const sandbox: any = { mapError: (e: unknown) => e as Error };
    const file1: any = {
      absolutePath: "/tmp/f1.txt",
      displayPath: "f1.txt",
      originalNormalized: "a",
      bom: "",
      originalEnding: "\n",
      originalHashes: ["h1"],
      result: "b",
    };
    const file2: any = {
      absolutePath: "/tmp/f2.txt",
      displayPath: "f2.txt",
      originalNormalized: "a",
      bom: "",
      originalEnding: "\n",
      originalHashes: ["h1"],
      result: "b",
    };

    await expect(
      persistUndoAndWrite({
        io,
        files: [file1, file2],
        exec: {} as any,
        sandbox,
        sandboxPolicy: undefined,
        undoUnavailableMessage: (p) => `undo ${p}`,
      }),
    ).rejects.toThrow(/disk full/);
    // first file was written then restored via second writeText call for restore + restore undo
    expect(restore1).toHaveBeenCalled();
    saveSpy.mockRestore();
  });

  it("success path writes all", async () => {
    const saveSpy = vi
      .spyOn(undoMod, "saveUndo")
      .mockResolvedValue({ persisted: true, restore: vi.fn(async () => {}) } as any);
    const io: any = { writeText: vi.fn(async () => {}) };
    const sandbox: any = { mapError: (e: unknown) => e as Error };
    const file1: any = {
      absolutePath: "/tmp/f1.txt",
      displayPath: "f1.txt",
      originalNormalized: "a\n",
      bom: "",
      originalEnding: "\n",
      originalHashes: ["h1"],
      result: "b\n",
    };
    await expect(
      persistUndoAndWrite({
        io,
        files: [file1],
        exec: {} as any,
        sandbox,
        sandboxPolicy: undefined,
        signal: undefined,
        undoUnavailableMessage: () => "x",
      }),
    ).resolves.toEqual([]);
    expect(io.writeText).toHaveBeenCalledTimes(1);
    saveSpy.mockRestore();
  });

  // ADR-0034: a write failure restores the undo rows of the files it never wrote. The transaction
  // owns that decision — the arity of the request must not enter into it.
  it("restores the unwritten undo rows on a failed write (arity must not decide)", async () => {
    const r1 = vi.fn(async () => {});
    const r2 = vi.fn(async () => {});
    const saveSpy = vi
      .spyOn(undoMod, "saveUndo")
      .mockResolvedValueOnce({ persisted: true, restore: r1 } as any)
      .mockResolvedValueOnce({ persisted: true, restore: r2 } as any);
    const io: any = { writeText: vi.fn().mockRejectedValue(new Error("fail")) };
    const sandbox: any = { mapError: (e: unknown) => e as Error };
    const f1: any = {
      absolutePath: "/tmp/f1.txt",
      displayPath: "f1.txt",
      originalNormalized: "a",
      bom: "",
      originalEnding: "\n",
      originalHashes: ["h1"],
      result: "b",
    };
    const f2: any = {
      absolutePath: "/tmp/f2.txt",
      displayPath: "f2.txt",
      originalNormalized: "a",
      bom: "",
      originalEnding: "\n",
      originalHashes: ["h1"],
      result: "b",
    };
    await expect(
      persistUndoAndWrite({
        io,
        files: [f1, f2],
        exec: {} as any,
        sandbox,
        sandboxPolicy: undefined,
        undoUnavailableMessage: () => "x",
      }),
    ).rejects.toThrow();
    // r2 is the undo row of file 2, which was never written — it must be restored.
    expect(r2).toHaveBeenCalled();
    saveSpy.mockRestore();
  });
});

/**
 * A failed multi-item write must leave the undo history as it was.
 *
 * `execute` branches on item arity, but both branches commit exactly one file through the same
 * transaction. ADR-0034 makes that transaction the one authority for the undo rows: a write that
 * fails restores the row `saveUndo` already persisted for every file it never wrote, so the row
 * whose `resultContent` never reached the disk cannot survive. Before ADR-0034 the batch branch
 * kept it, and the next `undo_last_edit` compared the on-disk file with that phantom content and
 * reported `E_UNDO_STALE {"reason":"modified"}`, blaming an external write for the tool's own
 * failed write and silently losing the previous edit's undo.
 */
describe("mutation transaction — a failed multi-item write leaves undo history intact", () => {
  it("keeps the previous edit's undo row when a multi-item write fails", async () => {
    const initial = "one\ntwo\nthree\n";
    const afterFirstEdit = "one\nTWO\nthree\n";
    await withTempFile("failed-batch-undo.txt", initial, async ({ cwd, path }) => {
      const base = localIO();
      let failWrites = false;
      const io: FileIO = {
        ...base,
        async writeText(absolutePath, content, signal, exec, sandboxPolicy) {
          if (failWrites) throw new Error("disk full");
          return base.writeText(absolutePath, content, signal, exec, sandboxPolicy);
        },
      };
      const { readTool, editTool, undoTool } = setupIntegrationTest(cwd, io);
      const anchorOf = (served: { content: Array<{ text?: string }> }, rowText: string): string => {
        const row = getText(served)
          .split("\n")
          .find((line) => line.endsWith(`│${rowText}`));
        if (row === undefined) throw new Error(`read did not serve a row for ${rowText}`);
        return extractHash(row);
      };

      // The previous edit — its undo row is the authority that must survive the failure.
      const served = await readTool.execute("read-1", { path: "failed-batch-undo.txt" });
      const two = anchorOf(served, "two");
      await editTool.execute("edit-1", {
        file: "failed-batch-undo.txt",
        edits: [{ anchor_from: two, anchor_to: two, replace_with: "TWO" }],
      });
      expect(await readFile(path, "utf-8")).toBe(afterFirstEdit);

      // A two-item edit takes the batch branch (`items.length > 1`) and its write fails.
      const reServed = await readTool.execute("read-2", { path: "failed-batch-undo.txt" });
      const one = anchorOf(reServed, "one");
      const three = anchorOf(reServed, "three");
      failWrites = true;
      await expect(
        editTool.execute("edit-2", {
          file: "failed-batch-undo.txt",
          edits: [
            { anchor_from: one, anchor_to: one, replace_with: "ONE" },
            { anchor_from: three, anchor_to: three, replace_with: "THREE" },
          ],
        }),
      ).rejects.toThrow(/disk full/);
      // The failed edit wrote nothing.
      expect(await readFile(path, "utf-8")).toBe(afterFirstEdit);

      failWrites = false;
      const undone = await undoTool.execute("undo_last_edit", { path: "failed-batch-undo.txt" });
      // It must not report the previous edit as externally modified.
      expect(getText(undone)).not.toContain("E_UNDO_STALE");
      // It must revert edit #1, which proves edit #1's undo row was still the authority.
      expect(await readFile(path, "utf-8")).toBe(initial);
    });
  });
});
