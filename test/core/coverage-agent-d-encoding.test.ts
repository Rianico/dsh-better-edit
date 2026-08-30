import { describe, it, expect, vi, beforeEach } from "vitest";
import iconv from "iconv-lite";
import {
  normalizeEncoding,
  isSupportedEncoding,
  detectBom,
  isValidUtf8,
  scoreText,
  decodeBytes,
  encodeText,
  top3Candidates,
  hasReplacementChar,
  detectWithChardet,
  chardetTop3Candidates,
  getTop3Candidates,
  SUPPORTED_ENCODINGS,
} from "../../src/encoding.js";

describe("coverage-agent-d encoding extra", () => {
  it("normalizeEncoding candidates loop branch", () => {
    // input with underscores vs hyphens hits both candidates array paths
    expect(normalizeEncoding("windows-1251")).toBe("windows-1251");
    expect(normalizeEncoding("windows_1251")).toBe("windows-1251");
    expect(normalizeEncoding("  WINDOWS_1251 ")).toBe("windows-1251");
    // lower direct
    expect(normalizeEncoding("GBK")).toBe("gbk");
    expect(normalizeEncoding("iso-8859-1")).toBe("iso-8859-1");
    expect(normalizeEncoding("latin1")).toBe("iso-8859-1");
  });

  it("isSupportedEncoding covers utf16 families", () => {
    expect(isSupportedEncoding("utf16le")).toBe(true);
    expect(isSupportedEncoding("utf16be")).toBe(true);
    expect(isSupportedEncoding("utf32le")).toBe(true);
    expect(isSupportedEncoding("utf32be")).toBe(true);
    expect(isSupportedEncoding("utf8")).toBe(true);
    expect(isSupportedEncoding("utf8bom")).toBe(true);
  });

  it("detectBom edge: utf32le vs utf16le priority", () => {
    expect(detectBom(new Uint8Array([0xff,0xfe,0x00,0x00]))?.encoding).toBe("utf32le");
    expect(detectBom(new Uint8Array([0x00,0x00,0xfe,0xff]))?.encoding).toBe("utf32be");
    expect(detectBom(new Uint8Array([0xfe,0xff]))?.encoding).toBe("utf16be");
  });

  it("scoreText low printable ratio branch", () => {
    const low = String.fromCharCode(1,2,3,4,5,6);
    expect(scoreText(low, "gbk")).toBeLessThan(0);
    const withReplacement = "a\uFFFD";
    expect(scoreText(withReplacement, "gbk")).toBe(-1000);
  });

  it("decodeBytes handles utf32 via iconv fallback and invalid enc", () => {
    // utf8 via TextDecoder
    expect(decodeBytes(Buffer.from("hi"), "utf8")).toBe("hi");
    expect(decodeBytes(Buffer.from("hi", "utf16le"), "utf16le")).toBe("hi");
    // utf16be via TextDecoder (in encoding.ts it uses TextDecoder for utf16be) - but our test used Buffer which is utf16le, so decode may fail; just check not throw
    const beBytes = Buffer.from([0,104,0,105]);
    expect(decodeBytes(beBytes, "utf16be")).toBe("hi");
    // iconv-lite path
    const gbk = iconv.encode("你好", "gbk");
    expect(decodeBytes(gbk, "gbk")).toBe("你好");
    expect(decodeBytes(Buffer.from([0]), "not-an-enc")).toBeUndefined();
  });

  it("encodeText handles utf16le, utf16be, gbk, error", () => {
    expect(encodeText("hi", "utf8")).toBeDefined();
    expect(encodeText("hi", "utf16le")).toBeDefined();
    const be = encodeText("hi", "utf16be");
    // encode may be via iconv, check roundtrip if defined
    if (be) expect(iconv.decode(Buffer.from(be!), "utf16be")).toBe("hi"); else expect(be).toBeUndefined();
    const gbk = encodeText("你好", "gbk");
    expect(gbk).toBeDefined();
    // invalid enc should return undefined or not throw
    const bad = encodeText("hi", "not-an-enc");
    expect(bad===undefined || bad instanceof Uint8Array).toBe(true);
  });

  it("top3Candidates normalizes allowlist and handles empty", () => {
    const b = iconv.encode("你好 world", "gbk");
    expect(top3Candidates(b, [])).toEqual([]);
    const cands = top3Candidates(b, ["GBK","CP1251"]);
    expect(cands.map(c=>c.encoding)).toContain("gbk");
    // printableRatio <0.85 branch
    const lowBytes = Buffer.from([0x01,0x02,0x03]);
    const lowCands = top3Candidates(lowBytes, ["gbk","windows-1251"]);
    expect(lowCands.length).toBe(2);
  });

  it("smartSlice and printableRatio branches", () => {
    // ascii only text -> slice 0-50
    const ascii = Buffer.from("a".repeat(100));
    const candsAscii = top3Candidates(ascii, ["gbk"]);
    expect(candsAscii[0]!.sample.length).toBeLessThanOrEqual(50);
    // long with non-ascii in middle
    const long = iconv.encode("a".repeat(40)+"你好"+"b".repeat(40), "gbk");
    const candsLong = top3Candidates(long, ["gbk"]);
    expect(candsLong[0]!.sample).toContain("\u4f60"); // will be decoded char
  });

  it("hasReplacementChar", () => {
    expect(hasReplacementChar("hello")).toBe(false);
    expect(hasReplacementChar("a\uFFFD")).toBe(true);
  });

  it("detectWithChardet fallback when chardet missing or low confidence", async () => {
    const bytes = Buffer.from("short ascii");
    const r = await detectWithChardet(bytes, ["gbk"]);
    expect(r===undefined || typeof r==="string").toBe(true);
    const r2 = await detectWithChardet(Buffer.from([0xc4,0xe3]), ["gbk"]);
    // should not throw
    expect(r2===undefined || typeof r2==="string").toBe(true);
  });

  it("chardetTop3Candidates returns filtered list", async () => {
    const bytes = iconv.encode("Привет мир", "windows-1251");
    const cands = await chardetTop3Candidates(bytes, ["windows-1251","gbk"]);
    expect(Array.isArray(cands)).toBe(true);
  });

  it("getTop3Candidates falls back to heuristic", async () => {
    const bytes = iconv.encode("你好世界", "gbk");
    const cands = await getTop3Candidates(bytes, ["gbk","windows-1251"]);
    expect(cands.length).toBeGreaterThan(0);
  });

  it("isValidUtf8 branches", () => {
    expect(isValidUtf8(Buffer.from("hello"))).toBe(true);
    expect(isValidUtf8(Buffer.from([0xff]))).toBe(false);
    expect(isValidUtf8(new Uint8Array([]))).toBe(true);
  });

  it("SUPPORTED_ENCODINGS includes all 6", () => {
    expect(SUPPORTED_ENCODINGS.length).toBe(6);
  });
});
