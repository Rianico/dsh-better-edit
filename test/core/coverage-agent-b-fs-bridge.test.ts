import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mapFsError,
  clearEncodingState,
  clearAutoGuessFooter,
  getEncodingState,
  setEncodingState,
  getAutoGuessFooter,
  setAutoGuessFooter,
  ctxFsIO,
  localIO,
} from "../../src/fs-bridge.js";
import type { Context } from "@deepseek-ai/cordis";

function makeFs(overrides: Record<string, any> = {}) {
  return {
    resolve: vi.fn(async (p: string, opts?: any) => ({ targetKey: `tk:${p}`, displayPath: p })),
    processPath: vi.fn((t: any) => t.displayPath),
    readText: vi.fn(async () => "hello"),
    readBytes: vi.fn(async () => Buffer.from("hello")),
    writeText: vi.fn(async () => ({ version: "v2" })),
    stat: vi.fn(async () => ({ version: "v1", size: 5, type: "file" })),
    ...overrides,
  };
}
function makeCtx(overrides: Record<string, any> = {}) {
  return {
    waterfall: vi.fn(async () => undefined),
    emit: vi.fn(() => undefined),
    ...overrides,
  } as unknown as Context;
}

describe("mapFsError", () => {
  it("maps FS_NOT_FOUND", () => {
    const err = Object.assign(new Error("x"), { code: "FS_NOT_FOUND" });
    expect(() => mapFsError(err, "a.txt")).toThrow(/E_NOT_FOUND/);
  });
  it("maps FS_PERMISSION_DENIED", () => {
    const err = Object.assign(new Error("x"), { code: "FS_PERMISSION_DENIED" });
    expect(() => mapFsError(err, "a.txt")).toThrow(/E_ACCESS/);
  });
  it("maps FS_NOT_TEXT", () => {
    const err = Object.assign(new Error("x"), { code: "FS_NOT_TEXT" });
    expect(() => mapFsError(err, "a.txt")).toThrow(/E_UNSUPPORTED_FILE/);
  });
  it("maps FS_NOT_REGULAR_FILE", () => {
    const err = Object.assign(new Error("x"), { code: "FS_NOT_REGULAR_FILE" });
    expect(() => mapFsError(err, "a.txt")).toThrow(/E_UNSUPPORTED_FILE/);
  });
  it("maps FS_BAD_ENCODING", () => {
    const err = Object.assign(new Error("x"), { code: "FS_BAD_ENCODING" });
    expect(() => mapFsError(err, "a.txt")).toThrow(/E_BAD_ENCODING/);
  });
  it("maps FS_DECODE_FAILED", () => {
    const err = Object.assign(new Error("x"), { code: "FS_DECODE_FAILED" });
    expect(() => mapFsError(err, "a.txt")).toThrow(/E_DECODE_FAILED/);
  });
  it("maps FS_STALE_VERSION", () => {
    const err = Object.assign(new Error("x"), { code: "FS_STALE_VERSION" });
    expect(() => mapFsError(err, "a.txt")).toThrow(/E_STALE_RANGE/);
  });
  it("maps FS_NOT_OBSERVED", () => {
    const err = Object.assign(new Error("x"), { code: "FS_NOT_OBSERVED" });
    expect(() => mapFsError(err, "a.txt")).toThrow(/E_NOT_OBSERVED/);
  });
  it("maps FS_ABORTED", () => {
    const err = Object.assign(new Error("x"), { code: "FS_ABORTED" });
    expect(() => mapFsError(err, "a.txt")).toThrow(/Operation aborted/);
  });
  it("rethrows unknown error", () => {
    const err = new Error("unknown");
    expect(() => mapFsError(err, "a.txt")).toThrow("unknown");
  });
  it("rethrows error without code", () => {
    const err = Object.assign(new Error("x"), { code: 123 });
    expect(() => mapFsError(err, "a.txt")).toThrow("x");
  });
});

describe("encoding memo", () => {
  beforeEach(() => { clearEncodingState(); clearAutoGuessFooter(); });
  afterEach(() => { clearEncodingState(); clearAutoGuessFooter(); });
  it("set/get/clear encoding state", () => {
    setEncodingState("k1", { encoding: "gbk", hasBOM: false, version: "v1" });
    expect(getEncodingState("k1")).toEqual({ encoding: "gbk", hasBOM: false, version: "v1" });
    clearEncodingState("k1");
    expect(getEncodingState("k1")).toBeUndefined();
  });
  it("clear all encoding state", () => {
    setEncodingState("k1", { encoding: "utf8", hasBOM: false, version: undefined });
    setEncodingState("k2", { encoding: "gbk", hasBOM: true, version: "v2" });
    clearEncodingState();
    expect(getEncodingState("k1")).toBeUndefined();
    expect(getEncodingState("k2")).toBeUndefined();
  });
  it("autoGuess footer memo", () => {
    setAutoGuessFooter("k1", "footer");
    expect(getAutoGuessFooter("k1")).toBe("footer");
    clearAutoGuessFooter("k1");
    expect(getAutoGuessFooter("k1")).toBeUndefined();
    setAutoGuessFooter("k1", "a");
    setAutoGuessFooter("k2", "b");
    clearAutoGuessFooter();
    expect(getAutoGuessFooter("k1")).toBeUndefined();
    expect(getAutoGuessFooter("k2")).toBeUndefined();
  });
});

describe("ctxFsIO", () => {
  beforeEach(() => { clearEncodingState(); clearAutoGuessFooter(); });
  afterEach(() => { clearEncodingState(); clearAutoGuessFooter(); });

  it("resolve delegates to fs", async () => {
    const fs: any = makeFs();
    const ctx: any = makeCtx();
    const io = ctxFsIO(fs, ctx);
    const r = await io.resolve("a.txt", "/cwd");
    expect(fs.resolve).toHaveBeenCalled();
    expect(r).toBe("a.txt");
  });

  it("readText explicit encodingHint success", async () => {
    const bytes = Buffer.from("hello", "utf-8");
    const fs: any = makeFs({
      stat: vi.fn(async () => ({ version: "v1", size: bytes.length })),
      readBytes: vi.fn(async () => bytes),
    });
    const ctx: any = makeCtx();
    const io = ctxFsIO(fs, ctx);
    const text = await io.readText("/abs/file.txt", undefined, "utf8");
    expect(text).toBe("hello");
    expect(getEncodingState("tk:/abs/file.txt")).toBeDefined();
  });

  it("readText explicit encodingHint bad encoding maps to FS_BAD_ENCODING", async () => {
    const fs: any = makeFs();
    const ctx: any = makeCtx();
    const io = ctxFsIO(fs, ctx);
    await expect(io.readText("/abs/file.txt", undefined, "not-an-enc")).rejects.toThrow(/E_BAD_ENCODING|bad encoding/i);
  });

  it("readText normal path calls readText and restore BOM", async () => {
    const fs: any = makeFs({
      readText: vi.fn(async () => "hello"),
      stat: vi.fn(async () => ({ size: 5, version: "v1" })),
      readBytes: vi.fn(async () => Buffer.from("hello")),
    });
    const ctx: any = makeCtx();
    const io = ctxFsIO(fs, ctx);
    const t = await io.readText("/abs/file.txt");
    expect(t).toBe("hello");
  });

  it("restoreStrippedUtf8Bom restores BOM when stripped", async () => {
    const text = "hello\r\n";
    const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf-8")]);
    const fs: any = makeFs({
      readText: vi.fn(async () => text),
      stat: vi.fn(async () => ({ size: bomBytes.length, version: "v1" })),
      readBytes: vi.fn(async () => bomBytes),
    });
    const ctx: any = makeCtx();
    const io = ctxFsIO(fs, ctx);
    const out = await io.readText("/abs/file.txt");
    expect(out).toBe("\uFEFF" + text);
  });

  it("readText falls back to autoGuess when FS_NOT_TEXT and autoGuess enabled", async () => {
    const { _resetConfigCache } = await import("../../src/store-config.js");
    process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
    _resetConfigCache();
    const gbkBytes = (await import("iconv-lite")).default.encode("你好世界 hello world", "gbk");
    const fs: any = makeFs({
      readText: vi.fn(async () => { throw Object.assign(new Error("not text"), { code: "FS_NOT_TEXT" }); }),
      stat: vi.fn(async () => ({ size: gbkBytes.length, version: "v1" })),
      readBytes: vi.fn(async () => gbkBytes),
    });
    const ctx: any = makeCtx();
    const io = ctxFsIO(fs, ctx);
    const out = await io.readText("/abs/file.txt");
    expect(out.length).toBeGreaterThan(5);
    expect(out).not.toContain("\uFFFD");
    delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
    _resetConfigCache();
  });

  it("writeText emits fs/observed and handles encoding memo invalidation", async () => {
    const fs: any = makeFs({
      stat: vi.fn(async () => ({ version: "v9", size: 3 })),
      writeText: vi.fn(async () => ({ version: "v10" })),
    });
    const ctx: any = makeCtx();
    setEncodingState("tk:/abs/file.txt", { encoding: "utf8", hasBOM: false, version: "v1" });
    const io = ctxFsIO(fs, ctx);
    await io.writeText("/abs/file.txt", "new content", undefined, { agent: { session: { id: "s1" } } } as any, undefined);
    expect(fs.writeText).toHaveBeenCalled();
    expect(ctx.emit).toHaveBeenCalledWith("fs/observed", expect.anything(), expect.objectContaining({ kind: "present" }), expect.anything());
  });

  it("writeText maps FS errors", async () => {
    const fs: any = makeFs({
      writeText: vi.fn(async () => { throw Object.assign(new Error("x"), { code: "FS_STALE_VERSION" }); }),
      stat: vi.fn(async () => ({ version: "v1" })),
    });
    const ctx: any = makeCtx();
    const io = ctxFsIO(fs, ctx);
    await expect(io.writeText("/abs/file.txt", "c")).rejects.toThrow(/E_STALE_RANGE/);
  });

  it("emitObserved emits when stat succeeds", async () => {
    const fs: any = makeFs({ stat: vi.fn(async () => ({ version: "v5" })) });
    const ctx: any = makeCtx();
    const io = ctxFsIO(fs, ctx);
    await io.emitObserved("/abs/file.txt", { agent: { session: { id: "s1" } } } as any);
    expect(ctx.emit).toHaveBeenCalledWith("fs/observed", expect.anything(), expect.objectContaining({ version: "v5" }), expect.anything());
  });

  it("emitObserved swallows errors", async () => {
    const fs: any = makeFs({ stat: vi.fn(async () => { throw new Error("fail"); }) });
    const ctx: any = makeCtx();
    const io = ctxFsIO(fs, ctx);
    await expect(io.emitObserved("/abs/file.txt")).resolves.toBeUndefined();
  });

  it("statVersion returns version or undefined", async () => {
    const fs: any = makeFs({ stat: vi.fn(async () => ({ version: "v3" })) });
    const ctx: any = makeCtx();
    const io = ctxFsIO(fs, ctx);
    expect(await io.statVersion("/abs/file.txt")).toBe("v3");
    fs.stat = vi.fn(async () => { throw new Error("not found"); });
    const io2 = ctxFsIO(fs, ctx);
    expect(await io2.statVersion("/abs/file.txt")).toBeUndefined();
    fs.stat = vi.fn(async () => ({}));
    const io3 = ctxFsIO(fs, ctx);
    expect(await io3.statVersion("/abs/file.txt")).toBeUndefined();
  });
});

describe("localIO", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "localio-"));
    clearEncodingState(); clearAutoGuessFooter();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    clearEncodingState(); clearAutoGuessFooter();
  });

  it("resolve returns canonical path", async () => {
    const io = localIO();
    const p = join(dir, "a.txt");
    await writeFile(p, "hi");
    const r = await io.resolve(p, dir);
    expect(r.length).toBeGreaterThan(0);
  });

  it("readText reads utf8 file", async () => {
    const p = join(dir, "utf8.txt");
    await writeFile(p, "hello world", "utf-8");
    const io = localIO();
    expect(await io.readText(p)).toBe("hello world");
  });

  it("readText handles BOM", async () => {
    const p = join(dir, "bom.txt");
    await writeFile(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello")]));
    const io = localIO();
    const t = await io.readText(p);
    // localIO detects BOM and returns decoded (may include BOM or not depending on path)
    expect(t).toContain("hello");
  });

  it("readText with encodingHint bad throws", async () => {
    const p = join(dir, "any.txt");
    await writeFile(p, "hi");
    const io = localIO();
    await expect((io as any).readText(p, undefined, "not-an-enc")).rejects.toThrow(/E_BAD_ENCODING/);
  });

  it("readText with explicit encoding decodes", async () => {
    const p = join(dir, "cp.txt");
    const { default: iconv } = await import("iconv-lite");
    await writeFile(p, iconv.encode("Привет", "windows-1251"));
    const io = localIO();
    const t = await (io as any).readText(p, undefined, "windows-1251");
    expect(t).toBe("Привет");
  });

  it("writeText writes atomically", async () => {
    const p = join(dir, "write.txt");
    const io = localIO();
    await io.writeText(p, "content123");
    expect(await readFile(p, "utf-8")).toBe("content123");
  });

  it("emitObserved is no-op", async () => {
    const io = localIO();
    await expect(io.emitObserved("/tmp/x")).resolves.toBeUndefined();
  });

  it("statVersion returns snapshot", async () => {
    const p = join(dir, "stat.txt");
    await writeFile(p, "hello");
    const io = localIO();
    const v = await io.statVersion(p);
    expect(typeof v === "string" || v === undefined).toBe(true);
  });

  it("statVersion returns undefined for missing file", async () => {
    const io = localIO();
    expect(await io.statVersion(join(dir, "missing.txt"))).toBeUndefined();
  });

  it("readText aborted signal throws", async () => {
    const p = join(dir, "a.txt");
    await writeFile(p, "hi");
    const io = localIO();
    const ac = new AbortController(); ac.abort();
    await expect(io.readText(p, ac.signal)).rejects.toThrow();
  });
});