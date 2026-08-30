import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isValidHashList,
  lineHashes,
  snapshotIOFor,
  setDefaultHashSnapshotIO,
} from "../../src/hashline/hash.js";
import { initHasher, HASH_RE } from "../../src/hashline/hash-assign.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("coverage: hash.ts snapshotIOFor / isValidHashList", () => {
  afterEach(() => setDefaultHashSnapshotIO(undefined));

  it("isValidHashList rejects non-array, non-string, bad pattern", () => {
    expect(isValidHashList(null)).toBe(false);
    expect(isValidHashList("string")).toBe(false);
    expect(isValidHashList([])).toBe(true);
    expect(isValidHashList(["abc"])).toBe(true);
    expect(isValidHashList(["ab"])).toBe(false); // not 3 chars
    expect(isValidHashList(["abc", 123 as any])).toBe(false);
    expect(isValidHashList(["abc", ""])).toBe(false);
    // test HASH_RE boundary
    const good = lineHashesPure("a\nb\nc")[0]!;
    expect(isValidHashList([good])).toBe(true);
  });

  it("snapshotIOFor adapts HashStore methods", async () => {
    const fakeStore: any = {
      getSnapshot: vi.fn(async () => ["aaa", "bbb"]),
      upsertSnapshot: vi.fn(),
    };
    const io = snapshotIOFor(fakeStore)!;
    expect(await io.get("p", "content", true)).toEqual(["aaa", "bbb"]);
    await io.upsert("p", "checksum", 2, ["aaa"]);
    expect(fakeStore.upsertSnapshot).toHaveBeenCalled();
  });

  it("snapshotIOFor with undefined uses default when set", async () => {
    const custom = {
      get: vi.fn(async () => ["x"]),
      upsert: vi.fn(async () => {}),
    };
    setDefaultHashSnapshotIO(custom as any);
    const io = snapshotIOFor(undefined)!;
    expect(await io.get("p", "c", true)).toEqual(["x"]);
    await io.upsert("p", "cs", 1, ["x"]);
    expect(custom.upsert).toHaveBeenCalled();
    setDefaultHashSnapshotIO(undefined);
  });

  it("snapshotIOFor falls through to loadHashStore when no store and no default", async () => {
    setDefaultHashSnapshotIO(undefined);
    // just ensure it returns an IO object with get/upsert (we don't call loadHashStore here)
    const io = snapshotIOFor(undefined);
    expect(io).toBeDefined();
    expect(typeof io!.get).toBe("function");
    expect(typeof io!.upsert).toBe("function");
  });

  it("lineHashes without path returns pure hashes", async () => {
    await initHasher();
    const h = await lineHashes("hello\nworld");
    expect(h).toEqual(lineHashesPure("hello\nworld"));
  });

  it("lineHashes with previous uses mapStableHashes and persists", async () => {
    await initHasher();
    const prevContent = "a\nb\nc";
    const prevHashes = await lineHashes(prevContent, home.testPath);
    const newContent = "a\nb changed\nc";
    const io = {
      get: vi.fn(async () => undefined),
      upsert: vi.fn(async () => {}),
    };
    const hashes = await lineHashes(newContent, home.testPath, { content: prevContent, hashes: prevHashes }, io as any, true);
    expect(hashes).toHaveLength(3);
    expect(io.upsert).toHaveBeenCalled();
  });

  it("lineHashes with previous handles upsert failure gracefully", async () => {
    const prevContent = "a\nb";
    const prevHashes = lineHashesPure(prevContent);
    const io = {
      get: vi.fn(async () => undefined),
      upsert: vi.fn(async () => { throw new Error("db fail"); }),
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hashes = await lineHashes("a\nb\nc", home.testPath, { content: prevContent, hashes: prevHashes }, io as any);
    expect(hashes).toHaveLength(3);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to persist"), expect.anything());
    consoleSpy.mockRestore();
  });

  it("lineHashes with cached hit returns cached", async () => {
    const cached = ["aaa", "bbb", "ccc"];
    const io = {
      get: vi.fn(async () => cached),
      upsert: vi.fn(async () => {}),
    };
    const result = await lineHashes("a\nb\nc", home.testPath, undefined, io as any);
    expect(result).toEqual(cached);
    expect(io.get).toHaveBeenCalled();
    expect(io.upsert).not.toHaveBeenCalled();
  });

  it("lineHashes handles io.get failure", async () => {
    const io = {
      get: vi.fn(async () => { throw new Error("read fail"); }),
      upsert: vi.fn(async () => {}),
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await lineHashes("a\nb\nc", home.testPath, undefined, io as any);
    expect(result).toHaveLength(3);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("lineHashes handles io.upsert failure after computing new hashes", async () => {
    const io = {
      get: vi.fn(async () => undefined),
      upsert: vi.fn(async () => { throw new Error("upsert fail"); }),
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await lineHashes("a\nb\nc", home.testPath, undefined, io as any);
    expect(result).toHaveLength(3);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to persist"), expect.anything());
    consoleSpy.mockRestore();
  });

  it("lineHashes with persist false skips IO", async () => {
    const io = {
      get: vi.fn(async () => ["should-not-return"] as any),
      upsert: vi.fn(async () => {}),
    };
    // previous path with persist false
    const prevHashes = lineHashesPure("a\nb");
    const res1 = await lineHashes("a\nb\nc", home.testPath, { content: "a\nb", hashes: prevHashes }, io as any, false);
    expect(io.upsert).not.toHaveBeenCalled();
    // no previous, persist false should still not call get with deleteCorrupt true? check
    const io2 = { get: vi.fn(async () => ["cached"]), upsert: vi.fn(async () => {}) };
    const res2 = await lineHashes("a\nb\nc", home.testPath, undefined, io2 as any, false);
    // persist false passes deleteCorrupt false
    expect(io2.get).toHaveBeenCalledWith(home.testPath, "a\nb\nc", false);
    expect(io2.upsert).not.toHaveBeenCalled();
  });

  it("lineHashes accepts HashStore as 4th arg (back-compat)", async () => {
    const fakeStore: any = {
      getSnapshot: vi.fn(async () => undefined),
      upsertSnapshot: vi.fn(),
    };
    const result = await lineHashes("a\nb", home.testPath, undefined, fakeStore as any);
    expect(result).toHaveLength(2);
    expect(fakeStore.upsertSnapshot).toHaveBeenCalled();
  });
});
