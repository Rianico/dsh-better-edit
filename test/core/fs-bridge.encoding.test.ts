import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "fs/promises";
import iconv from "iconv-lite";
import { localIO, clearEncodingState } from "../../src/fs-bridge.js";
import { loadConfig, _resetConfigCache } from "../../src/store-config.js";
import { assertReadRequest } from "../../src/contract.js";
import { normalizeEncoding } from "../../src/encoding.js";

describe("localIO encoding — BOM and autoGuess", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "enc-test-"));
    clearEncodingState();
    _resetConfigCache();
    delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
    delete process.env.DSH_BETTER_EDIT_NORMALIZE_TO_UTF8;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
    _resetConfigCache();
    clearEncodingState();
  });

  it("decodes UTF-8 BOM via localIO", async () => {
    const path = join(dir, "bom.txt");
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf-8")]));
    const io = localIO();
    const text = await io.readText(path);
    expect(text).toBe("hello"); // localIO strips BOM and decodes
  });

  it("autoGuessEncoding:false falls back to raw utf8 (no candidate)", async () => {
    const path = join(dir, "gbk.txt");
    const gbkBytes = iconv.encode("你好世界", "gbk");
    await writeFile(path, gbkBytes);
    process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "false";
    _resetConfigCache();
    const io = localIO();
    // with autoGuess false, localIO will try BOM→UTF-8→autoGuess false → raw readFile utf-8 (with �)
    // For GBK bytes, readFile utf-8 will produce replacement chars, but localIO's try block will not autoGuess, so it falls to readFile("utf-8") which contains �
    const text = await io.readText(path);
    // Should not be the correct GBK decode when autoGuess off
    expect(text).not.toBe("你好世界");
  });

  it("autoGuessEncoding:true decodes GBK via top-3", async () => {
    const path = join(dir, "gbk2.txt");
    const gbkBytes = iconv.encode("你好世界你好世界 hello", "gbk");
    await writeFile(path, gbkBytes);
    process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
    _resetConfigCache();
    const io = localIO();
    const text = await io.readText(path);
    expect(text).not.toContain("\uFFFD");
    expect(text.length).toBeGreaterThan(5);
  });

  it("explicit encodingHint overrides autoGuess (Reopen with Encoding)", async () => {
    const path = join(dir, "cp.txt");
    const cpBytes = iconv.encode("Привет", "windows-1251");
    await writeFile(path, cpBytes);
    const io = localIO();
    const text = await (io as any).readText(path, undefined, "windows-1251");
    expect(text).toBe("Привет");
  });

  it("explicit unknown encoding throws E_BAD_ENCODING", async () => {
    const path = join(dir, "any.txt");
    await writeFile(path, Buffer.from("hi"));
    const io = localIO();
    await expect((io as any).readText(path, undefined, "not-an-enc")).rejects.toThrow(/E_BAD_ENCODING/);
  });

  it("decodes Shift_JIS via autoGuess", async () => {
    const path = join(dir, "sj.txt");
    const sj = iconv.encode("こんにちは世界こんにちは", "shift_jis");
    await writeFile(path, sj);
    process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
    _resetConfigCache();
    const io = localIO();
    const text = await io.readText(path);
    expect(text).not.toContain("\uFFFD");
    expect(text.length).toBeGreaterThan(5);
  });
});

describe("contract and normalizeEncoding", () => {
  it("assertReadRequest allows encoding param", () => {
    expect(() => assertReadRequest({ path: "a.txt", encoding: "gbk" })).not.toThrow();
  });

  it("assertReadRequest rejects unknown fields", () => {
    expect(() => assertReadRequest({ path: "a.txt", unknown: "x" } as any)).toThrow(/E_BAD_PAYLOAD/);
  });

  it("normalizeEncoding canonicalizes aliases", () => {
    expect(normalizeEncoding("cp1251")).toBe("windows-1251");
    expect(normalizeEncoding("GB18030")).toBe("gbk");
  });
});
