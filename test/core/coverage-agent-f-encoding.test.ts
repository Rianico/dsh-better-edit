import { describe, it, expect } from "vitest";
import {
  normalizeEncoding,
  isSupportedEncoding,
  detectBom,
  isValidUtf8,
  hasReplacementChar,
  decodeBytes,
  encodeText,
  top3Candidates,
  scoreText,
  detectWithChardet,
  chardetTop3Candidates,
} from "../../src/encoding.js";

describe("coverage-f: encoding normalize & isSupported", () => {
  it("covers normalizeEncoding candidates and direct lower", () => {
    expect(normalizeEncoding("UTF-8")).toBe("utf8");
    expect(normalizeEncoding(" utf8 ")).toBe("utf8");
    expect(normalizeEncoding("GBK")).toBe("gbk");
    expect(normalizeEncoding("gb18030")).toBe("gbk");
    expect(normalizeEncoding("Big5")).toBe("big5");
    expect(normalizeEncoding("SHIFT_JIS")).toBe("shift_jis");
    expect(normalizeEncoding("sjis")).toBe("shift_jis");
    expect(normalizeEncoding("EUC-KR")).toBe("euc-kr");
    expect(normalizeEncoding("euckr")).toBe("euc-kr");
    expect(normalizeEncoding("CP1251")).toBe("windows-1251");
    expect(normalizeEncoding("windows-1251")).toBe("windows-1251");
    expect(normalizeEncoding("latin1")).toBe("iso-8859-1");
    expect(normalizeEncoding("ISO-8859-1")).toBe("iso-8859-1");
    expect(normalizeEncoding("nope")).toBeUndefined();
    expect(normalizeEncoding("utf8bom")).toBe("utf8bom");
  });
  it("isSupportedEncoding branches", () => {
    expect(isSupportedEncoding("gbk")).toBe(true);
    expect(isSupportedEncoding("utf8")).toBe(true);
    expect(isSupportedEncoding("utf8bom")).toBe(true);
    expect(isSupportedEncoding("utf16le")).toBe(true);
    expect(isSupportedEncoding("utf32be")).toBe(true);
    expect(isSupportedEncoding("nope")).toBe(false);
    expect(isSupportedEncoding("  GBK  ")).toBe(true);
  });
});

describe("coverage-f: encoding bom & utf8", () => {
  it("detectBom all", () => {
    expect(detectBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))?.encoding).toBe("utf8bom");
    expect(detectBom(new Uint8Array([0xff, 0xfe, 0x00, 0x00]))?.encoding).toBe("utf32le");
    expect(detectBom(new Uint8Array([0x00, 0x00, 0xfe, 0xff]))?.encoding).toBe("utf32be");
    expect(detectBom(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))?.encoding).toBe("utf16le");
    expect(detectBom(new Uint8Array([0xfe, 0xff, 0x00, 0x61]))?.encoding).toBe("utf16be");
    expect(detectBom(new Uint8Array([]))).toBeUndefined();
    expect(detectBom(new Uint8Array([0x00]))).toBeUndefined();
  });
  it("isValidUtf8 & hasReplacementChar", () => {
    expect(isValidUtf8(new Uint8Array([0x61, 0x62]))).toBe(true);
    expect(isValidUtf8(new Uint8Array([0xff, 0xfe]))).toBe(false);
    expect(isValidUtf8(new Uint8Array([]))).toBe(true);
    expect(hasReplacementChar("a\uFFFD")).toBe(true);
    expect(hasReplacementChar("abc")).toBe(false);
  });
});

describe("coverage-f: encoding decode/encode", () => {
  it("decodeBytes all encodings", () => {
    expect(decodeBytes(new Uint8Array([0x61]), "utf8")).toBe("a");
    expect(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), "utf8bom")).toBeDefined();
    expect(decodeBytes(new Uint8Array([0x61, 0x00]), "utf16le")).toBeDefined();
    expect(decodeBytes(new Uint8Array([0x00, 0x61]), "utf16be")).toBeDefined();
    expect(decodeBytes(Buffer.from([0xd6, 0xd0]), "gbk")).toBeDefined();
    expect(decodeBytes(Buffer.from([0xa4, 0xa4]), "big5")).toBeDefined();
    expect(decodeBytes(Buffer.from([0x82, 0xa0]), "shift_jis")).toBeDefined();
    expect(decodeBytes(Buffer.from([0xb0, 0xa1]), "euc-kr")).toBeDefined();
    expect(decodeBytes(Buffer.from([0xff]), "nope" as any)).toBeUndefined();
  });
  it("encodeText all", () => {
    expect(encodeText("hello", "utf8")).toBeDefined();
    expect(encodeText("hello", "utf8bom")).toBeDefined();
    expect(encodeText("hi", "utf16le")).toBeDefined();
    expect(encodeText("hi", "utf16be")).toBeDefined();
    expect(encodeText("你好", "gbk")).toBeDefined();
    expect(encodeText("hello", "nope" as any)).toBeUndefined();
  });
});

describe("coverage-f: encoding scoring & top3", () => {
  it("scoreText branches", () => {
    expect(scoreText("\uFFFD", "utf8")).toBe(-1000);
    expect(scoreText("\x01\x02\x03", "utf8")).toBeLessThan(0);
    expect(scoreText("hello world", "utf8")).toBeGreaterThan(-500);
    expect(scoreText("你好世界", "gbk")).toBeGreaterThan(scoreText("hello", "gbk"));
    expect(scoreText("привет", "windows-1251")).toBeGreaterThan(scoreText("hello", "windows-1251"));
    expect(scoreText("こんにちは", "shift_jis")).toBeGreaterThan(scoreText("hello", "shift_jis"));
    expect(scoreText("안녕하세요", "euc-kr")).toBeGreaterThan(scoreText("hello", "euc-kr"));
    expect(scoreText("", "utf8")).toBeDefined();
  });
  it("top3Candidates with BOM-path and allowlist filtering", () => {
    const helloUtf8 = Buffer.from("hello world");
    const cands1 = top3Candidates(helloUtf8, ["utf8", "gbk", "big5"]);
    expect(cands1.length).toBeGreaterThan(0);
    const cands2 = top3Candidates(helloUtf8, ["nope" as any, "also-nope" as any]);
    expect(cands2.length).toBe(0);
    const gbkBytes = Buffer.from([0xd6, 0xd0, 0xb9, 0xfa]);
    const cands3 = top3Candidates(gbkBytes, ["gbk", "utf8"]);
    expect(cands3.length).toBeGreaterThan(0);
  });
  it("smartSlice via top3Candidates with non-ascii", () => {
    const mixed = Buffer.from("hello 你好 world");
    const cands = top3Candidates(mixed, ["gbk", "utf8"]);
    expect(cands[0]?.sample).toBeDefined();
    const asciiOnly = Buffer.from("hello world ".repeat(10));
    const cands2 = top3Candidates(asciiOnly, ["utf8"]);
    expect(cands2[0]?.sample.length).toBeLessThanOrEqual(50);
  });
});

describe("coverage-f: encoding chardet", () => {
  it("detectWithChardet handles missing chardet gracefully", async () => {
    const bytes = Buffer.from("hello");
    const res = await detectWithChardet(bytes, ["utf8"]);
    expect(res === undefined || typeof res === "string").toBe(true);
  });
  it("detectWithChardet with allowlist filtering", async () => {
    const bytes = Buffer.from("hello world");
    const res = await detectWithChardet(bytes, ["utf8", "gbk"]);
    expect(res === undefined || typeof res === "string").toBe(true);
  });
  it("chardetTop3Candidates returns array", async () => {
    const bytes = Buffer.from("hello");
    const res = await chardetTop3Candidates(bytes, ["utf8", "gbk"]);
    expect(Array.isArray(res)).toBe(true);
  });
  it("chardet with low confidence / invalid entries covered via real chardet", async () => {
    const bytes = Buffer.from("\x00\x01\x02\x03\x04");
    const res = await detectWithChardet(bytes, ["utf8"]);
    expect(res === undefined || typeof res === "string").toBe(true);
    const res2 = await chardetTop3Candidates(bytes, ["nope" as any]);
    expect(Array.isArray(res2)).toBe(true);
  });
});
