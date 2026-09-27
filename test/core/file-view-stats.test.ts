import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { fileSnap, loadFileKindAndText, type FileStats } from "../../src/file-view.js";
import { withTempFile } from "../support/fixtures.js";

/**
 * FU-6 — port of pi-better-edit@2334352's stat consolidation. Upstream's
 * `test/core/file-content-stats.test.ts` has six cells; the "propagates the stat through
 * prepareFile" cell is dropped here because this tree has no `prepareFile` seam — the read
 * tool loads text through `FileIO.readText` (`src/file-view.ts` readView), and
 * `loadFileKindAndText` → `fileSnap` is the local seam the plumbing lands on. Upstream's
 * fake-stats cell asserts a `|checksum` suffix in the snapshot id; this tree's `fmtSnapId`
 * predates ADR-0013 (no checksum segment), so the id is asserted without it.
 */
describe("file-view — stat consolidation", () => {
  it("returns the loader's stat with text content", async () => {
    await withTempFile("stats.txt", "alpha\nbeta\n", async ({ path }) => {
      const file = await loadFileKindAndText(path);
      const actual = await stat(path);
      if (file.kind !== "text") throw new Error(`expected text, got ${file.kind}`);
      expect(file.stats?.ino).toBe(actual.ino);
      expect(file.stats?.size).toBe(actual.size);
      expect(file.stats?.mtimeMs).toBe(actual.mtimeMs);
    });
  });

  it("snapshots from preloaded stats without re-stat'ing the file", async () => {
    await withTempFile("snap.txt", "alpha\nbeta\n", async ({ path }) => {
      const preloaded: FileStats = { ino: 4242, mtimeMs: 1, ctimeMs: 2, size: 999 };
      const snap = await fileSnap(path, preloaded);
      // A real `stat` would report this file's own inode and size; these are the caller's numbers.
      expect(snap.ino).toBe(4242);
      expect(snap.size).toBe(999);
      expect(snap.mtimeMs).toBe(1);
      expect(snap.snapshotId).toContain("|4242|1|2|999");
    });
  });

  it("accepts a real fs.Stats as-is", async () => {
    await withTempFile("snap-real.txt", "alpha\n", async ({ path }) => {
      const actual = await stat(path);
      const snap = await fileSnap(path, actual);
      // The loader hands its own `fs.Stats` over, so the domain type must accept it structurally.
      expect(snap.ino).toBe(actual.ino);
      expect(snap.size).toBe(actual.size);
    });
  });

  it("still stats the file when no stats are preloaded", async () => {
    await withTempFile("snap-plain.txt", "alpha\n", async ({ path }) => {
      const snap = await fileSnap(path);
      const actual = await stat(path);
      expect(snap.ino).toBe(actual.ino);
      expect(snap.size).toBe(actual.size);
    });
  });
});
