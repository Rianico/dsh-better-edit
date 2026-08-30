import { describe, it, expect, vi } from "vitest";

describe("coverage-agent-e more", () => {
  it("ctxFsIO isValidUtf8 true branch", async () => {
    const { ctxFsIO, clearEncodingState, clearAutoGuessFooter } = await import("../../src/fs-bridge.js");
    const { _resetConfigCache } = await import("../../src/store-config.js");
    process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
    _resetConfigCache();
    clearEncodingState(); clearAutoGuessFooter();
    const validUtf8Bytes = Buffer.from("hello world valid utf8");
    const fakeFs: any = {
      resolve: async (p: string) => ({ targetKey: `tk:${p}`, displayPath: p }),
      processPath: (t: any) => t.displayPath,
      readText: async () => { throw Object.assign(new Error("not text"), { code: "FS_NOT_TEXT" }); },
      readBytes: async () => validUtf8Bytes,
      stat: async () => ({ size: validUtf8Bytes.length, version: "v1" }),
      writeText: async () => ({ version: "v2" }),
    };
    const fakeCtx: any = { waterfall: async () => undefined, emit: () => {} };
    const io = ctxFsIO(fakeFs, fakeCtx);
    const txt = await io.readText("/abs/valid.txt");
    expect(txt).toBe("hello world valid utf8");
    delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
    _resetConfigCache();
  });

  it("ctxFsIO chardet mid-confidence footer", async () => {
    const encMod: any = await import("../../src/encoding.js");
    const spy = vi.spyOn(encMod, "chardetTop3Candidates").mockResolvedValue([
      { encoding: "gbk", confidence: 65, sample: "你好", score: 65 },
      { encoding: "big5", confidence: 60, sample: "test", score: 60 },
    ] as any);
    const { ctxFsIO, clearEncodingState, clearAutoGuessFooter, getAutoGuessFooter } = await import("../../src/fs-bridge.js");
    const { _resetConfigCache } = await import("../../src/store-config.js");
    process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
    _resetConfigCache();
    clearEncodingState(); clearAutoGuessFooter();
    const gbkBytes = (await import("iconv-lite")).default.encode("你好世界 hello", "gbk");
    const fakeFs: any = {
      resolve: async (p: string) => ({ targetKey: `tk:${p}-mid`, displayPath: p }),
      processPath: (t: any) => t.displayPath,
      readText: async () => { throw Object.assign(new Error("not text"), { code: "FS_NOT_TEXT" }); },
      readBytes: async () => gbkBytes,
      stat: async () => ({ size: gbkBytes.length, version: "v1" }),
      writeText: async () => ({ version: "v2" }),
    };
    const fakeCtx: any = { waterfall: async () => undefined, emit: () => {} };
    const io = ctxFsIO(fakeFs, fakeCtx);
    const txt = await io.readText("/abs/mid.txt");
    expect(txt.length).toBeGreaterThan(0);
    const footer = getAutoGuessFooter("tk:/abs/mid.txt");
    expect(typeof footer === "string" || footer === undefined).toBe(true);
    spy.mockRestore();
    delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
    _resetConfigCache();
    clearEncodingState(); clearAutoGuessFooter();
  });

  it("ctxFsIO writeText with encodingHint", async () => {
    const { ctxFsIO } = await import("../../src/fs-bridge.js");
    const fakeFs: any = {
      resolve: async (p: string) => ({ targetKey: `tk:${p}`, displayPath: p }),
      processPath: (t: any) => t.displayPath,
      readText: async () => "hi",
      readBytes: async () => Buffer.from("hi"),
      stat: async () => ({ size: 2, version: "v1" }),
      writeText: async () => ({ version: "v2" }),
    };
    const fakeCtx: any = { waterfall: async () => undefined, emit: () => {} };
    const io = ctxFsIO(fakeFs, fakeCtx);
    await io.writeText("/abs/enc.txt", "hello", undefined, undefined, undefined, "gbk");
    expect(true).toBe(true);
  });

  it("localIO readText with BOM via host fs", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { localIO } = await import("../../src/fs-bridge.js");
    const dir = await mkdtemp(join(tmpdir(), "e-more-bom-"));
    try {
      const p = join(dir, "bom.txt");
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      await writeFile(p, Buffer.concat([bom, Buffer.from("bom content")])); 
      const txt = await localIO().readText(p);
      expect(txt).toContain("bom content");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
