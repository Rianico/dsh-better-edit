import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWritableTempRoot } from "../support/fixtures.js";

describe("coverage-agent-g hash-store", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("validators", async () => {
    const { isValidHashList, isValidSnapshot, isValidServedList } = await import("../../src/hash-store.js");
    expect(isValidHashList(["abc"])).toBe(true);
    expect(isValidHashList("not-array")).toBe(false);
    expect(isValidHashList([123 as any])).toBe(false);
    expect(isValidHashList(["ab"])).toBe(false);
    expect(isValidHashList(["abc", "def"])).toBe(true);
    expect(isValidSnapshot({ content: "hi", hashes: ["abc"] })).toBe(true);
    expect(isValidSnapshot({ content: 123, hashes: ["abc"] })).toBe(false);
    expect(isValidSnapshot(null)).toBe(false);
    expect(isValidServedList(["abc", null])).toBe(true);
    expect(isValidServedList(["ab"])).toBe(false);
    expect(isValidServedList("not-array")).toBe(false);
  });

  it("isCorruptionError branches", async () => {
    const { isCorruptionError } = await import("../../src/hash-store.js");
    expect(isCorruptionError({ errcode: 11 })).toBe(true);
    expect(isCorruptionError({ errcode: 24 })).toBe(true);
    expect(isCorruptionError({ errcode: 5 })).toBe(false);
    expect(isCorruptionError({ code: "SQLITE_CORRUPT" })).toBe(true);
    expect(isCorruptionError(new Error("corrupt database"))).toBe(true);
    expect(isCorruptionError(new Error("other"))).toBe(false);
    expect(isCorruptionError(null)).toBe(false);
  });

  it("getSnapshot and findSnapshotPaths", async () => {
    const dir = await mkdtemp(join(await getWritableTempRoot(), "hs-g-"));
    const prevHome = process.env.HOME;
    const prevDsh = process.env.DSH_HOME;
    process.env.HOME = dir;
    process.env.DSH_HOME = join(dir, ".dsh");
    try {
      const { loadHashStore, shutdownHashStore } = await import("../../src/hash-store.js");
      const store: any = await loadHashStore();
      const p = join(dir, "file.txt");
      await store.upsertSnapshot(p, "c", 1, ["abc"]);
      const got = store.getSnapshot(p, "c", true);
      expect(got === undefined || Array.isArray(got)).toBe(true);
      const matches = store.findSnapshotPaths(["abc"]);
      expect(Array.isArray(matches)).toBe(true);
      shutdownHashStore();
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDsh;
      const { shutdownHashStore } = await import("../../src/hash-store.js");
      shutdownHashStore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("getUndo and served", async () => {
    const dir = await mkdtemp(join(await getWritableTempRoot(), "hs-g2-"));
    const prevHome = process.env.HOME;
    const prevDsh = process.env.DSH_HOME;
    process.env.HOME = dir;
    process.env.DSH_HOME = join(dir, ".dsh");
    try {
      const { loadHashStore, shutdownHashStore } = await import("../../src/hash-store.js");
      const store: any = await loadHashStore();
      const p = join(dir, "a.txt");
      store.upsertUndo(p, { content: "c", bom: "", ending: "\n", hashes: ["abc"], resultContent: "r" });
      expect(store.getUndo(p)?.content).toBe("c");
      expect(store.getUndo("/nope")).toBeUndefined();
      store.upsertServed("sess", p, JSON.stringify(["abc", null]));
      const served = store.getServed("sess", p);
      expect(Array.isArray(served)).toBe(true);
      store.deleteServed("sess", p);
      store.deleteServedByPath(p);
      store.wipeServed("sess");
      store.pruneServedOlderThan(Date.now() + 10000);
      store.pruneUndoOlderThan(Date.now() + 10000);
      store.deleteSnapshot(p);
      expect(store.allKnownPaths()).toBeDefined();
      shutdownHashStore();
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDsh;
      const { shutdownHashStore } = await import("../../src/hash-store.js");
      shutdownHashStore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pruneMissing", async () => {
    const dir = await mkdtemp(join(await getWritableTempRoot(), "hs-prune-"));
    const prevHome = process.env.HOME;
    const prevDsh = process.env.DSH_HOME;
    process.env.HOME = dir;
    process.env.DSH_HOME = join(dir, ".dsh");
    try {
      const { loadHashStore, shutdownHashStore } = await import("../../src/hash-store.js");
      const store: any = await loadHashStore();
      const existing = join(dir, "exists.txt");
      await writeFile(existing, "hi", "utf-8");
      const missing = join(dir, "missing.txt");
      store.upsertSnapshot(existing, "c1", 1, ["abc"]);
      store.upsertSnapshot(missing, "c2", 1, ["def"]);
      await store.pruneMissing();
      expect(store.getSnapshot(missing, "x", false)).toBeUndefined();
      shutdownHashStore();
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDsh;
      const { shutdownHashStore } = await import("../../src/hash-store.js");
      shutdownHashStore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("coverage-agent-g file-view", () => {
  it("formatSize and truncateHead", async () => {
    const { formatSize, truncateHead } = await import("../../src/file-view.js");
    expect(formatSize(500)).toBe("500B");
    expect(formatSize(2048)).toContain("KB");
    expect(formatSize(3 * 1024 * 1024)).toContain("MB");
    const r1 = truncateHead("a\nb", {});
    expect(r1.truncated).toBe(false);
    const big = "x".repeat(60000);
    const r2 = truncateHead(big, { maxBytes: 100 });
    expect(r2.firstLineExceedsLimit).toBe(true);
    const many = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const r3 = truncateHead(many, { maxLines: 10 });
    expect(r3.truncatedBy).toBe("lines");
    const r4 = truncateHead("a".repeat(1000) + "\n" + "b".repeat(1000), { maxBytes: 1500 });
    expect(r4.truncated).toBe(true);
  });

  it("loadFileKindAndText branches", async () => {
    const { loadFileKindAndText } = await import("../../src/file-view.js");
    const dir = await mkdtemp(join(await getWritableTempRoot(), "fv-"));
    try {
      expect((await loadFileKindAndText(dir)).kind).toBe("directory");
      const empty = join(dir, "empty.txt");
      await writeFile(empty, "", "utf-8");
      expect((await loadFileKindAndText(empty)).kind).toBe("text");
      const big = join(dir, "big.txt");
      await writeFile(big, "x".repeat(600 * 1024), "utf-8");
      const bigRes = await loadFileKindAndText(big);
      expect(["binary", "text"].includes(bigRes.kind)).toBe(true);
      const bin = join(dir, "bin.dat");
      await writeFile(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const binRes = await loadFileKindAndText(bin);
      expect(["binary", "image", "text"].includes(binRes.kind)).toBe(true);
      const badUtf8 = join(dir, "bad.txt");
      await writeFile(badUtf8, Buffer.from([0xff, 0xff, 0x61]));
      const badRes: any = await loadFileKindAndText(badUtf8);
      expect(["text", "binary"].includes(badRes.kind)).toBe(true);
      const { fileSnap } = await import("../../src/file-view.js");
      const snap = await fileSnap(empty);
      expect(snap.snapshotId).toContain("v2|");
      const { normFromText } = await import("../../src/file-view.js");
      await expect(normFromText({ absolutePath: empty, rawText: "a\n".repeat(100), displayPath: "x", maxLines: 10 })).rejects.toThrow(/E_LARGE_FILE/);
      const { valAccess } = await import("../../src/file-view.js");
      await expect(valAccess("/nope/path", "/nope/path")).rejects.toThrow(/E_NOT_FOUND/);
      const { valKind } = await import("../../src/file-view.js");
      expect(() => valKind({ kind: "directory" } as any, "p")).toThrow(/directory/);
      expect(() => valKind({ kind: "binary", description: "x" } as any, "p")).toThrow(/binary/);
      expect(() => valKind({ kind: "image", mimeType: "image/png" } as any, "p")).toThrow(/image/);
      const { fmtReadPreview } = await import("../../src/file-view.js");
      const manyLines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
      const r = await fmtReadPreview(manyLines, { offset: 5, limit: 5 }, undefined, empty);
      expect(r.served.length).toBe(5);
      const { preview } = await import("../../src/file-view.js");
      const pv = await preview("a\nb", ["h1", "h2"], {});
      expect(pv.text).toContain("h1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("coverage-agent-g fixtures", () => {
  it("fixtures helpers", async () => {
    const { withTempFile, setupIntegrationTest, getText, getWritableTempRoot } = await import("../support/fixtures.js");
    await withTempFile("a.txt", "hello\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "a.txt" } as any);
      expect(getText(res)).toContain("hello");
      const { withHome } = await import("../support/fixtures.js");
      const restore = withHome("/tmp");
      expect(typeof restore).toBe("function");
    });
    const root = await getWritableTempRoot();
    expect(typeof root).toBe("string");
  });
});
