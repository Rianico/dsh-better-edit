import { describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import {
  SUPPORTED_ENCODINGS,
  normalizeEncoding,
  isSupportedEncoding,
  detectBom,
  isValidUtf8,
  scoreText,
  decodeBytes,
  encodeText,
  top3Candidates,
  hasReplacementChar,
} from "../../src/encoding.js";

describe("normalizeEncoding", () => {
  it("canonicalizes case-insensitive and hyphen/underscore variants", () => {
    expect(normalizeEncoding("UTF-8")).toBe("utf8");
    expect(normalizeEncoding("utf_8")).toBe("utf8");
    expect(normalizeEncoding("Utf8")).toBe("utf8");
    expect(normalizeEncoding("UTF8BOM")).toBe("utf8bom");
    expect(normalizeEncoding("utf8bom")).toBe("utf8bom");
    expect(normalizeEncoding("GBK")).toBe("gbk");
    expect(normalizeEncoding("gb18030")).toBe("gbk");
    expect(normalizeEncoding("gb2312")).toBe("gbk");
    expect(normalizeEncoding("BIG5")).toBe("big5");
    expect(normalizeEncoding("shift_jis")).toBe("shift_jis");
    expect(normalizeEncoding("shift-jis")).toBe("shift_jis");
    expect(normalizeEncoding("SJIS")).toBe("shift_jis");
    expect(normalizeEncoding("cp1251")).toBe("windows-1251");
    expect(normalizeEncoding("windows-1251")).toBe("windows-1251");
    expect(normalizeEncoding("windows1251")).toBe("windows-1251");
    expect(normalizeEncoding("latin1")).toBe("iso-8859-1");
    expect(normalizeEncoding("ISO-8859-1")).toBe("iso-8859-1");
  });

  it("returns undefined for unknown encodings", () => {
    expect(normalizeEncoding("unknown-xyz")).toBeUndefined();
    expect(normalizeEncoding("utf32")).toBeUndefined();
    expect(normalizeEncoding("")).toBeUndefined();
  });

  it("trims whitespace", () => {
    expect(normalizeEncoding("  gbk  ")).toBe("gbk");
    expect(normalizeEncoding("\nshift_jis\t")).toBe("shift_jis");
  });
});

describe("isSupportedEncoding", () => {
  it("accepts supported legacy encodings and utf8 families", () => {
    expect(isSupportedEncoding("gbk")).toBe(true);
    expect(isSupportedEncoding("big5")).toBe(true);
    expect(isSupportedEncoding("shift_jis")).toBe(true);
    expect(isSupportedEncoding("euc-kr")).toBe(true);
    expect(isSupportedEncoding("windows-1251")).toBe(true);
    expect(isSupportedEncoding("iso-8859-1")).toBe(true);
    expect(isSupportedEncoding("utf8")).toBe(true);
    expect(isSupportedEncoding("utf8bom")).toBe(true);
    expect(isSupportedEncoding("utf16le")).toBe(true);
    expect(isSupportedEncoding("utf16be")).toBe(true);
    expect(isSupportedEncoding("cp1251")).toBe(true); // alias
  });

  it("rejects unsupported", () => {
    expect(isSupportedEncoding("utf32")).toBe(false);
    expect(isSupportedEncoding("ascii")).toBe(false);
  });
});

describe("SUPPORTED_ENCODINGS constant", () => {
  it("contains expected defaults for #34", () => {
    expect(SUPPORTED_ENCODINGS).toEqual(
      expect.arrayContaining(["gbk", "big5", "shift_jis", "euc-kr", "windows-1251", "iso-8859-1"]),
    );
    expect(SUPPORTED_ENCODINGS.length).toBe(6);
  });
});

describe("detectBom", () => {
  it("detects UTF-8 BOM EF BB BF", () => {
    const b = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(detectBom(b)).toEqual({ encoding: "utf8bom", bomLen: 3, hasBOM: true });
  });

  it("detects UTF-16LE BOM FF FE", () => {
    const b = new Uint8Array([0xff, 0xfe, 0x68, 0x00]);
    expect(detectBom(b)).toEqual({ encoding: "utf16le", bomLen: 2, hasBOM: true });
  });

  it("detects UTF-16BE BOM FE FF", () => {
    const b = new Uint8Array([0xfe, 0xff, 0x00, 0x68]);
    expect(detectBom(b)).toEqual({ encoding: "utf16be", bomLen: 2, hasBOM: true });
  });

  it("detects UTF-32LE BOM FF FE 00 00", () => {
    const b = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x68]);
    expect(detectBom(b)).toEqual({ encoding: "utf32le", bomLen: 4, hasBOM: true });
  });

  it("detects UTF-32BE BOM 00 00 FE FF", () => {
    const b = new Uint8Array([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00]);
    expect(detectBom(b)).toEqual({ encoding: "utf32be", bomLen: 4, hasBOM: true });
  });

  it("prefers 4-byte BOM over 2-byte when overlapping (FF FE 00 00)", () => {
    // FF FE could be utf16le, but with 00 00 it's utf32le — ensure 4-byte wins
    const b = new Uint8Array([0xff, 0xfe, 0x00, 0x00]);
    expect(detectBom(b)?.encoding).toBe("utf32le");
  });

  it("returns undefined for no BOM", () => {
    expect(detectBom(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]))).toBeUndefined();
    expect(detectBom(new Uint8Array([]))).toBeUndefined();
  });

  it("returns undefined for truncated BOM", () => {
    expect(detectBom(new Uint8Array([0xef, 0xbb]))).toBeUndefined();
    expect(detectBom(new Uint8Array([0xff]))).toBeUndefined();
  });
});

describe("isValidUtf8", () => {
  it("accepts valid UTF-8 including multi-byte CJK", () => {
    expect(isValidUtf8(Buffer.from("hello"))).toBe(true);
    expect(isValidUtf8(Buffer.from("你好世界"))).toBe(true);
    expect(isValidUtf8(new Uint8Array([]))).toBe(true);
  });

  it("rejects GBK bytes and lone 0xFF", () => {
    // GBK for 你好 = C4E3 BAC3 — not valid UTF-8
    expect(isValidUtf8(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))).toBe(false);
    expect(isValidUtf8(Buffer.from([0xff]))).toBe(false);
    expect(isValidUtf8(Buffer.from([0x68, 0xff, 0x69]))).toBe(false);
  });
});

describe("decodeBytes / encodeText", () => {
  it("decodes utf8 via TextDecoder", () => {
    const b = Buffer.from("hello 世界");
    expect(decodeBytes(b, "utf8")).toBe("hello 世界");
  });

  it("decodes utf16le", () => {
    const b = Buffer.from("hi", "utf16le");
    expect(decodeBytes(b, "utf16le")).toBe("hi");
  });

  it("decodes GBK via iconv-lite", () => {
    const gbkBytes = iconv.encode("你好", "gbk");
    expect(decodeBytes(gbkBytes, "gbk")).toBe("你好");
  });

  it("decodes windows-1251 via iconv-lite", () => {
    const cpBytes = iconv.encode("Привет", "windows-1251");
    expect(decodeBytes(cpBytes, "windows-1251")).toBe("Привет");
  });

  it("decodes shift_jis via iconv-lite", () => {
    const sj = iconv.encode("こんにちは", "shift_jis");
    expect(decodeBytes(sj, "shift_jis")).toBe("こんにちは");
  });

  it("returns undefined on invalid enc for decodeBytes? no throw", () => {
    // unknown enc should fall through iconv and return undefined or throw caught
    // iconv-lite throws for unknown, so we expect undefined
    expect(decodeBytes(Buffer.from([0x00]), "not-an-enc")).toBeUndefined();
  });

  it("encodeText round-trips gbk", () => {
    const enc = encodeText("你好", "gbk");
    expect(enc).toBeDefined();
    expect(iconv.decode(Buffer.from(enc!), "gbk")).toBe("你好");
  });

  it("encodeText utf8 uses TextEncoder", () => {
    const enc = encodeText("hello", "utf8");
    expect(Buffer.from(enc!).toString("utf-8")).toBe("hello");
  });

  it("encodeText handles utf16be via iconv", () => {
    const enc = encodeText("hi", "utf16be");
    expect(enc).toBeDefined();
    expect(iconv.decode(Buffer.from(enc!), "utf16be")).toBe("hi");
  });
});

describe("scoreText and hasReplacementChar", () => {
  it("penalizes replacement char", () => {
    expect(scoreText("hello\uFFFDworld", "utf8")).toBe(-1000);
    expect(hasReplacementChar("a\uFFFD")).toBe(true);
    expect(hasReplacementChar("hello")).toBe(false);
  });

  it("rewards CJK for gbk/big5, Cyrillic for windows-1251", () => {
    const cjk = "你好世界";
    const cyrillic = "Привет мир";
    expect(scoreText(cjk, "gbk")).toBeGreaterThan(scoreText(cjk, "windows-1251"));
    expect(scoreText(cyrillic, "windows-1251")).toBeGreaterThan(scoreText(cyrillic, "gbk"));
  });

  it("rewards hiragana for shift_jis, hangul for euc-kr", () => {
    const hiragana = "こんにちは";
    const hangul = "안녕하세요";
    expect(scoreText(hiragana, "shift_jis")).toBeGreaterThan(scoreText(hiragana, "gbk"));
    expect(scoreText(hangul, "euc-kr")).toBeGreaterThan(scoreText(hangul, "gbk"));
  });

  it("penalizes low printable ratio", () => {
    const low = "\u0001\u0002\u0003\u0004";
    expect(scoreText(low, "gbk")).toBeLessThan(0);
  });
});

describe("top3Candidates", () => {
  it("returns top 3 sorted by score for GBK bytes", () => {
    const gbkBytes = iconv.encode("你好世界 hello", "gbk");
    const cands = top3Candidates(gbkBytes, [...SUPPORTED_ENCODINGS]);
    expect(cands.length).toBe(3);
    // best should be gbk or big5 (both CJK), but gbk should be top for GBK-encoded bytes
    expect(cands.map((c) => c.encoding)).toContain("gbk");
    expect(cands[0]!.sample.length).toBeLessThanOrEqual(50);
    expect(cands[0]!.sample.length).toBeGreaterThan(0);
    // sorted descending
    expect(cands[0]!.score).toBeGreaterThanOrEqual(cands[1]!.score);
    expect(cands[1]!.score).toBeGreaterThanOrEqual(cands[2]!.score);
  });

  it("returns top 3 for CP1251 bytes", () => {
    const cp = iconv.encode("Привет мир hello", "windows-1251");
    const cands = top3Candidates(cp, [...SUPPORTED_ENCODINGS]);
    expect(cands[0]!.encoding).toBe("windows-1251");
  });

  it("returns top 3 for Shift_JIS bytes", () => {
    const sj = iconv.encode("こんにちは world", "shift_jis");
    const cands = top3Candidates(sj, [...SUPPORTED_ENCODINGS]);
    // shift_jis should be in top 3, ideally top
    const encs = cands.map((c) => c.encoding);
    expect(encs).toContain("shift_jis");
  });

  it("smart slice caps at 50 chars", () => {
    const long = iconv.encode("a".repeat(100) + "你好" + "b".repeat(100), "gbk");
    const cands = top3Candidates(long, ["gbk"]);
    expect(cands[0]!.sample.length).toBeLessThanOrEqual(50);
  });

  it("handles empty allowlist", () => {
    expect(top3Candidates(Buffer.from("hi"), [])).toEqual([]);
  });

  it("normalizes allowlist entries", () => {
    const gbkBytes = iconv.encode("你好", "gbk");
    const cands = top3Candidates(gbkBytes, ["GBK", "CP1251"]);
    expect(cands.map((c) => c.encoding)).toContain("gbk"); // canonical lowercased
  });

  it("smart slice seeks first non-ASCII ±32", () => {
    // 30 ascii then CJK then ascii — slice should include CJK
    const text = "a".repeat(30) + "你好" + "b".repeat(30);
    const gbkBytes = iconv.encode(text, "gbk");
    const cands = top3Candidates(gbkBytes, ["gbk"]);
    expect(cands[0]!.sample).toContain("你好");
  });
});

describe("BOM integration via decodeBytes", () => {
  it("decodes UTF-16LE bytes with BOM stripped correctly", () => {
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]);
    // detectBom would have stripped BOM, but decodeBytes with utf16le should still decode payload
    const payload = withBom.subarray(2);
    expect(decodeBytes(payload, "utf16le")).toBe("hi");
  });
});
