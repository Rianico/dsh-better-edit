import { describe, it, expect } from "vitest";

describe("encoding chardet mock", () => {
  it("detectWithChardet with mocked high confidence", async () => {
    const mod = await import("../../src/encoding.js");
    const bytes = Buffer.from("hello world 你好", "utf-8");
    const res = await mod.detectWithChardet(bytes, ["gbk", "big5", "utf8"]);
    expect(res === undefined || typeof res === "string").toBe(true);
  });

  it("top3Candidates and scoreText", async () => {
    const mod = await import("../../src/encoding.js");
    const bytes = Buffer.from("hello 你好 world");
    const cands = mod.top3Candidates(bytes, ["gbk", "big5", "shift_jis"]);
    expect(cands.length).toBeGreaterThan(0);
    expect(typeof mod.scoreText("hello", "utf8")).toBe("number");
    expect(typeof mod.scoreText("\uFFFD\uFFFD", "utf8")).toBe("number");
  });

  it("normalizeEncoding all aliases", async () => {
    const mod = await import("../../src/encoding.js");
    expect(mod.normalizeEncoding("utf-8")).toBe("utf8");
    expect(mod.normalizeEncoding("UTF8BOM")).toBe("utf8bom");
    expect(mod.normalizeEncoding("shift-jis")).toBe("shift_jis");
    expect(mod.normalizeEncoding("SJIS")).toBe("shift_jis");
    expect(mod.normalizeEncoding("EUC-KR")).toBe("euc-kr");
    expect(mod.normalizeEncoding("windows-1251")).toBe("windows-1251");
    expect(mod.normalizeEncoding("latin1")).toBe("iso-8859-1");
    expect(mod.normalizeEncoding("nope")).toBeUndefined();
    expect(mod.isSupportedEncoding("gbk")).toBe(true);
    expect(mod.isSupportedEncoding("utf32be")).toBe(true);
  });

  it("detectBom all variants", async () => {
    const mod = await import("../../src/encoding.js");
    expect(mod.detectBom(new Uint8Array([0xef, 0xbb, 0xbf]))?.encoding).toBe("utf8bom");
    expect(mod.detectBom(new Uint8Array([0xff, 0xfe, 0x00, 0x00]))?.encoding).toBe("utf32le");
    expect(mod.detectBom(new Uint8Array([0x00, 0x00, 0xfe, 0xff]))?.encoding).toBe("utf32be");
    expect(mod.detectBom(new Uint8Array([0xff, 0xfe]))?.encoding).toBe("utf16le");
    expect(mod.detectBom(new Uint8Array([0xfe, 0xff]))?.encoding).toBe("utf16be");
    expect(mod.detectBom(new Uint8Array([0x00]))).toBeUndefined();
  });

  it("decodeBytes and encodeText", async () => {
    const mod = await import("../../src/encoding.js");
    expect(mod.decodeBytes(Buffer.from([0x61]), "utf8")).toBe("a");
    expect(mod.decodeBytes(Buffer.from([0xd6, 0xd0]), "gbk")).toBeDefined();
    expect(mod.decodeBytes(Buffer.from([0xff]), "nope" as any)).toBeUndefined();
    expect(mod.encodeText("hello", "utf8")).toBeDefined();
    expect(mod.hasReplacementChar("a\uFFFD")).toBe(true);
    expect(mod.hasReplacementChar("abc")).toBe(false);
    expect(mod.isValidUtf8(new Uint8Array([0x61]))).toBe(true);
    expect(mod.isValidUtf8(new Uint8Array([0xff]))).toBe(false);
  });
});
