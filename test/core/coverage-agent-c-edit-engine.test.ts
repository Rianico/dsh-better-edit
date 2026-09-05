import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  collectRemovedHashes,
  countLineChanges,
  resolveMissingPath,
  applyOne,
  enforceNoopLoop,
  persistUndoAndWrite,
  runFileEdits,
} from "../../src/edit-engine.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import * as hashStore from "../../src/hash-store.js";
import * as undoMod from "../../src/undo-edit.js";

describe("coverage: edit-engine collectRemovedHashes / countLineChanges", () => {
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
    const editOneMiss: any = { hash_bounds: [{ hash: "bbb" }, { hash: "zzz" }], content_lines: ["x"] };
    expect(collectRemovedHashes(editOneMiss, hashes).size).toBe(0);
  });

  it("countLineChanges noop returns zeros", () => {
    const edit: any = { hash_bounds: [{ hash: "aaa" }, { hash: "bbb" }], content_lines: ["new"] };
    expect(countLineChanges(edit, ["aaa", "bbb", "ccc"], true, 0)).toEqual({ totalAddedLines: 0, totalRemovedLines: 0 });
  });

  it("countLineChanges computes removed and added lines", () => {
    const hashes = ["h1", "h2", "h3", "h4"];
    const edit: any = { hash_bounds: [{ hash: "h2" }, { hash: "h3" }], content_lines: ["a", "b", "c"] };
    // removed 2 lines (h2-h3), added 3 minus autoFixes 1 => 2
    expect(countLineChanges(edit, hashes, false, 1)).toEqual({ totalAddedLines: 2, totalRemovedLines: 2 });
    // reversed bounds still works via indexOf
    const editRev: any = { hash_bounds: [{ hash: "h3" }, { hash: "h2" }], content_lines: ["a"] };
    expect(countLineChanges(editRev, hashes, false, 0).totalRemovedLines).toBe(2);
    // hashes not found -> removed 0
    const editMiss: any = { hash_bounds: [{ hash: "zz" }, { hash: "yy" }], content_lines: ["a", "b"] };
    expect(countLineChanges(editMiss, ["h1"], false, 0)).toEqual({ totalAddedLines: 2, totalRemovedLines: 0 });
  });
});

describe("coverage: edit-engine resolveMissingPath", () => {
  it("returns undefined when path present", async () => {
    expect(await resolveMissingPath({ path: "a.txt" } as any)).toBeUndefined();
  });
  it("returns undefined when missing remove_from/to types", async () => {
    expect(await resolveMissingPath({ path: null, remove_from: 123 as any, remove_to: "abc" } as any)).toBeUndefined();
    expect(await resolveMissingPath({ path: null } as any)).toBeUndefined();
  });
  it("returns undefined on invalid hash ref", async () => {
    expect(await resolveMissingPath({ path: null, remove_from: "not-a-hash!!!", remove_to: "also-bad" } as any)).toBeUndefined();
  });
  it("returns undefined when findSnapshot throws", async () => {
    const spy = vi.spyOn(hashStore, "findSnapshotPathsByHashes").mockRejectedValue(new Error("db fail"));
    // need valid hashes (3-char alphanumeric)
    const hashes = lineHashesPure("a\nb\nc");
    await expect(resolveMissingPath({ path: null, remove_from: hashes[0]!, remove_to: hashes[1]! } as any)).resolves.toBeUndefined();
    spy.mockRestore();
  });
  it("returns single match and warning", async () => {
    const spy = vi.spyOn(hashStore, "findSnapshotPathsByHashes").mockResolvedValue(["/tmp/file.txt"]);
    const hashes = lineHashesPure("a\nb");
    const res = await resolveMissingPath({ path: null, remove_from: hashes[0]!, remove_to: hashes[1]! } as any);
    expect(res?.path).toBe("/tmp/file.txt");
    expect(res?.warning).toMatch(/Autocorrected/);
    spy.mockRestore();
  });
  it("throws when multiple matches", async () => {
    const spy = vi.spyOn(hashStore, "findSnapshotPathsByHashes").mockResolvedValue(["a", "b"]);
    const hashes = lineHashesPure("a\nb");
    await expect(resolveMissingPath({ path: null, remove_from: hashes[0]!, remove_to: hashes[1]! } as any)).rejects.toThrow(/multiple known files/);
    spy.mockRestore();
  });
  it("returns undefined when no matches", async () => {
    const spy = vi.spyOn(hashStore, "findSnapshotPathsByHashes").mockResolvedValue([]);
    const hashes = lineHashesPure("a\nb");
    expect(await resolveMissingPath({ path: null, remove_from: hashes[0]!, remove_to: hashes[1]! } as any)).toBeUndefined();
    spy.mockRestore();
  });
});

describe("coverage: edit-engine applyOne", () => {
  it("applies pre-resolved edit", async () => {
    await initHasher();
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const edit: any = { hash_bounds: [{ hash: hashes[0]! }, { hash: hashes[0]! }], content_lines: ["A"] };
    const result = await applyOne(
      {
        content,
        hashes,
        served: [hashes[0]!, hashes[1]!, hashes[2]!],
        removeFrom: hashes[0]!,
        removeTo: hashes[0]!,
        replacementText: "A",
        absolutePath: "/tmp/a.txt",
        displayPath: "a.txt",
        warnings: [],
        persist: false,
        edit,
      },
      async () => { throw new Error("should not reject"); },
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
        removeFrom: "bad hash with spaces",
        removeTo: "also bad",
        replacementText: "x",
        absolutePath: "/tmp/a.txt",
        displayPath: "a.txt",
        warnings: [],
        persist: false,
      },
      async (err) => { rejected = err; throw err as any; },
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
        removeFrom: "zzz",
        removeTo: "zzz",
        replacementText: "x",
        absolutePath: "/tmp/a.txt",
        displayPath: "a.txt",
        warnings: [],
        persist: false,
      },
      async (err) => { rejected = err; throw err as any; },
    ).catch(() => {});
    expect(String(rejected)).toMatch(/E_STALE_ANCHOR|E_BAD_ANCHOR|AnchorMismatch/);
  });

  it("noop detection keeps original hashes", async () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const result = await applyOne(
      {
        content,
        hashes,
        served: hashes as any,
        removeFrom: hashes[0]!,
        removeTo: hashes[0]!,
        replacementText: "a",
        absolutePath: "/tmp/a.txt",
        displayPath: "a.txt",
        warnings: [],
        persist: false,
      },
      async (e) => { throw e as any; },
    );
    expect(result.noop).toBe(true);
    expect(result.hashes).toEqual(hashes);
  });
});

describe("coverage: edit-engine enforceNoopLoop", () => {
  const hashes = ["h1", "h2", "h3"];
  it("single-edit: throws at threshold", async () => {
    const { NOOP_LOOP_THRESHOLD } = await import("../../src/constants.js");
    await expect(enforceNoopLoop({
      absolutePath: "/tmp/a.txt",
      removeFrom: "aaa",
      removeTo: "aaa",
      replacementText: "x",
      displayPath: "a.txt",
      count: NOOP_LOOP_THRESHOLD,
      sessionKey: "test",
      originalHashes: hashes,
      originalNormalized: "a\nb\nc",
      range: { startLine: 1, endLine: 1, startHash: "h1", endHash: "h1", delta: 0 },
    })).rejects.toThrow(/E_NOOP_LOOP/);
  });
  it("single-edit: notice at count 2", async () => {
    const notice = await enforceNoopLoop({
      absolutePath: "/tmp/a.txt",
      removeFrom: "aaa",
      removeTo: "aaa",
      replacementText: "x",
      displayPath: "a.txt",
      count: 2,
      sessionKey: "test",
      originalHashes: hashes,
      originalNormalized: "a\nb\nc",
      range: { startLine: 1, endLine: 1, startHash: "h1", endHash: "h1", delta: 0 },
    });
    expect(notice).toMatch(/Notice/);
  });
  it("single-edit: undefined when count 1", async () => {
    const notice = await enforceNoopLoop({
      absolutePath: "/tmp/a.txt",
      removeFrom: "aaa",
      removeTo: "aaa",
      replacementText: "x",
      displayPath: "a.txt",
      count: 1,
      sessionKey: "test",
      originalHashes: hashes,
      originalNormalized: "a\nb\nc",
      range: { startLine: 1, endLine: 1, startHash: "h1", endHash: "h1", delta: 0 },
    });
    expect(notice).toBeUndefined();
  });
  it("batch: throws at threshold and notice at 2", async () => {
    const { NOOP_LOOP_THRESHOLD } = await import("../../src/constants.js");
    await expect(enforceNoopLoop({
      absolutePath: "/tmp/a.txt",
      removeFrom: "aaa",
      removeTo: "aaa",
      replacementText: "x",
      displayPath: "a.txt",
      index: 0,
      count: NOOP_LOOP_THRESHOLD,
      sessionKey: "test",
      originalHashes: hashes,
      originalNormalized: "a\nb\nc",
      echoRows: [{ position: 0, hash: "h1" }],
    })).rejects.toThrow(/E_NOOP_LOOP/);

    const notice = await enforceNoopLoop({
      absolutePath: "/tmp/a.txt",
      removeFrom: "aaa",
      removeTo: "aaa",
      replacementText: "x",
      displayPath: "a.txt",
      index: 0,
      count: 2,
      sessionKey: "test",
      originalHashes: hashes,
      originalNormalized: "a\nb\nc",
    });
    expect(notice).toMatch(/Notice/);

    const none = await enforceNoopLoop({
      absolutePath: "/tmp/a.txt",
      removeFrom: "aaa",
      removeTo: "aaa",
      replacementText: "x",
      displayPath: "a.txt",
      index: 0,
      count: 1,
      sessionKey: "test",
      originalHashes: hashes,
      originalNormalized: "a\nb\nc",
    });
    expect(none).toBeUndefined();
  });

  it("batch without echoRows still throws", async () => {
    const { NOOP_LOOP_THRESHOLD } = await import("../../src/constants.js");
    await expect(enforceNoopLoop({
      absolutePath: "/tmp/a.txt",
      removeFrom: "aaa",
      removeTo: "aaa",
      replacementText: "x",
      displayPath: "a.txt",
      index: 1,
      count: NOOP_LOOP_THRESHOLD,
      sessionKey: "test",
      originalHashes: hashes,
      originalNormalized: "a\nb\nc",
    })).rejects.toThrow(/E_NOOP_LOOP/);
  });
});

describe("coverage: edit-engine persistUndoAndWrite", () => {
  it("throws undo unavailable and restores previous undos", async () => {
    const saveSpy = vi.spyOn(undoMod, "saveUndo")
      .mockResolvedValueOnce({ persisted: true, restore: vi.fn(async () => {}) } as any)
      .mockResolvedValueOnce({ persisted: false, restore: vi.fn(async () => {}) } as any);

    const io: any = { writeText: vi.fn(async () => {}) };
    const sandbox: any = { mapError: (e: unknown) => e as Error };
    const file1: any = { absolutePath: "/tmp/f1.txt", displayPath: "f1.txt", originalNormalized: "a", bom: "", originalEnding: "\n", originalHashes: ["h1"], result: "b" };
    const file2: any = { absolutePath: "/tmp/f2.txt", displayPath: "f2.txt", originalNormalized: "a", bom: "", originalEnding: "\n", originalHashes: ["h1"], result: "b" };

    await expect(persistUndoAndWrite({
      io, files: [file1, file2], exec: {} as any, sandbox, sandboxPolicy: undefined, undoUnavailableMessage: (p) => `[E_UNDO_UNAVAILABLE] ${p}`,
    })).rejects.toThrow(/E_UNDO_UNAVAILABLE/);
    saveSpy.mockRestore();
  });

  it("writes files and restores on write failure", async () => {
    const restore1 = vi.fn(async () => {});
    const restore2 = vi.fn(async () => {});
    const saveSpy = vi.spyOn(undoMod, "saveUndo")
      .mockResolvedValueOnce({ persisted: true, restore: restore1 } as any)
      .mockResolvedValueOnce({ persisted: true, restore: restore2 } as any);
    const io: any = {
      writeText: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("disk full")),
    };
    const sandbox: any = { mapError: (e: unknown) => e as Error };
    const file1: any = { absolutePath: "/tmp/f1.txt", displayPath: "f1.txt", originalNormalized: "a", bom: "", originalEnding: "\n", originalHashes: ["h1"], result: "b" };
    const file2: any = { absolutePath: "/tmp/f2.txt", displayPath: "f2.txt", originalNormalized: "a", bom: "", originalEnding: "\n", originalHashes: ["h1"], result: "b" };

    await expect(persistUndoAndWrite({
      io, files: [file1, file2], exec: {} as any, sandbox, sandboxPolicy: undefined, undoUnavailableMessage: (p) => `undo ${p}`,
    })).rejects.toThrow(/disk full/);
    // first file was written then restored via second writeText call for restore + restore undo
    expect(restore1).toHaveBeenCalled();
    saveSpy.mockRestore();
  });

  it("success path writes all", async () => {
    const saveSpy = vi.spyOn(undoMod, "saveUndo").mockResolvedValue({ persisted: true, restore: vi.fn(async () => {}) } as any);
    const io: any = { writeText: vi.fn(async () => {}) };
    const sandbox: any = { mapError: (e: unknown) => e as Error };
    const file1: any = { absolutePath: "/tmp/f1.txt", displayPath: "f1.txt", originalNormalized: "a\n", bom: "", originalEnding: "\n", originalHashes: ["h1"], result: "b\n" };
    await expect(persistUndoAndWrite({
      io, files: [file1], exec: {} as any, sandbox, sandboxPolicy: undefined, signal: undefined, undoUnavailableMessage: () => "x",
    })).resolves.toBeUndefined();
    expect(io.writeText).toHaveBeenCalledTimes(1);
    saveSpy.mockRestore();
  });

  it("restoreUnwrittenUndos cleans up when requested", async () => {
    const r1 = vi.fn(async () => {});
    const r2 = vi.fn(async () => {});
    const saveSpy = vi.spyOn(undoMod, "saveUndo")
      .mockResolvedValueOnce({ persisted: true, restore: r1 } as any)
      .mockResolvedValueOnce({ persisted: true, restore: r2 } as any);
    const io: any = { writeText: vi.fn().mockRejectedValue(new Error("fail")) };
    const sandbox: any = { mapError: (e: unknown) => e as Error };
    const f1: any = { absolutePath: "/tmp/f1.txt", displayPath: "f1.txt", originalNormalized: "a", bom: "", originalEnding: "\n", originalHashes: ["h1"], result: "b" };
    const f2: any = { absolutePath: "/tmp/f2.txt", displayPath: "f2.txt", originalNormalized: "a", bom: "", originalEnding: "\n", originalHashes: ["h1"], result: "b" };
    await expect(persistUndoAndWrite({
      io, files: [f1, f2], exec: {} as any, sandbox, sandboxPolicy: undefined, undoUnavailableMessage: () => "x", restoreUnwrittenUndos: true,
    })).rejects.toThrow();
    // r2 should have been called as unwritten cleanup
    expect(r2).toHaveBeenCalled();
    saveSpy.mockRestore();
  });
});
