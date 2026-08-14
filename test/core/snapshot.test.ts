import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, symlink } from "fs/promises";
import { join } from "node:path";
import { fileSnap } from "../../src/file-reader.js";
import { getWritableTempRoot } from "../support/fixtures.js";
async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-snapshot-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("fileSnap", () => {
  it("returns snapshot info with correct format for an existing file", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "test.ts");
      await writeFile(filePath, "hello\nworld\n", "utf-8");

      const snap = await fileSnap(filePath);

      expect(snap.snapshotId).toMatch(/^v2\|.+\|.+\|.+\|.+\|.+$/);
      expect(snap.snapshotId).toContain("test.ts");
      expect(typeof snap.mtimeMs).toBe("number");
      expect(snap.mtimeMs).toBeGreaterThan(0);
      expect(typeof snap.ino).toBe("number");
      expect(typeof snap.ctimeMs).toBe("number");
      expect(typeof snap.size).toBe("number");
      expect(snap.size).toBe(12);
    });
  });

  it("returns different snapshotIds for different files", async () => {
    await withTempDir(async (dir) => {
      const fileA = join(dir, "a.ts");
      const fileB = join(dir, "b.ts");
      await writeFile(fileA, "a\n", "utf-8");
      await writeFile(fileB, "b\n", "utf-8");

      const snapA = await fileSnap(fileA);
      const snapB = await fileSnap(fileB);

      expect(snapA.snapshotId).not.toBe(snapB.snapshotId);
    });
  });

  it("returns different snapshotIds when file content changes", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "changing.ts");
      await writeFile(filePath, "original\n", "utf-8");

      const snap1 = await fileSnap(filePath);

      await new Promise((r) => setTimeout(r, 50));
      await writeFile(filePath, "modified\n", "utf-8");

      const snap2 = await fileSnap(filePath);

      expect(snap1.snapshotId).not.toBe(snap2.snapshotId);
    });
  });

  it.skipIf(process.platform === "win32")("resolves symlinks and returns the canonical path in snapshotId", async () => {
    await withTempDir(async (dir) => {
      const realFile = join(dir, "real.ts");
      const linkPath = join(dir, "link.ts");
      await writeFile(realFile, "real content\n", "utf-8");
      await symlink(realFile, linkPath);

      const snap = await fileSnap(linkPath);

      expect(snap.snapshotId).toContain("real.ts");
      expect(snap.size).toBe(13);
    });
  });

  it("throws on non-existent file", async () => {
    await withTempDir(async (dir) => {
      const missingPath = join(dir, "does-not-exist.ts");
      await expect(fileSnap(missingPath)).rejects.toThrow();
    });
  });

  it("returns correct size for empty file", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "empty.ts");
      await writeFile(filePath, "", "utf-8");

      const snap = await fileSnap(filePath);
      expect(snap.size).toBe(0);
    });
  });

  it("snapshotId format is v2|path|ino|mtimeMs|ctimeMs|size", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "format.ts");
      await writeFile(filePath, "data\n", "utf-8");

      const snap = await fileSnap(filePath);
      const parts = snap.snapshotId.split("|");

      expect(parts[0]).toBe("v2");
      expect(parts[1]).toContain("format.ts");
      expect(parts[2]).toBe(String(snap.ino));
      expect(parts[3]).toBe(String(snap.mtimeMs));
      expect(parts[4]).toBe(String(snap.ctimeMs));
      expect(parts[5]).toBe(String(snap.size));
    });
  });
});
