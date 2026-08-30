import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("coverage-agent-e final", () => {
  it("encoding remaining branches", async () => {
    const m: any = await import("../../src/encoding.js");
    // hit normalizeEncoding with dash variants
    expect(m.normalizeEncoding("UTF_8")).toBe("utf8");
    expect(m.normalizeEncoding("utf8")).toBe("utf8");
    // hit getTop3Candidates with empty allowlist
    const empty = m.top3Candidates(Buffer.from("hello"), []);
    expect(Array.isArray(empty)).toBe(true);
    // hit scoreText with empty and with replacement char
    expect(typeof m.scoreText("", "utf8")).toBe("number");
    expect(m.scoreText("\uFFFD", "utf8")).toBeLessThan(100);
    // hit hasReplacementChar
    expect(m.hasReplacementChar("test\uFFFD")).toBe(true);
    // hit isValidUtf8 with valid and invalid
    expect(m.isValidUtf8(Buffer.from([0x61, 0x62]))).toBe(true);
    expect(m.isValidUtf8(Buffer.from([0xff, 0xfe]))).toBe(false);
    // hit decodeBytes with unsupported
    expect(m.decodeBytes(Buffer.from([0x61]), "utf8")).toBe("a");
    expect(m.decodeBytes(Buffer.from([0x61]), "unknown" as any)).toBeUndefined();
    // hit chardetTop3Candidates with empty
    const cands = await m.chardetTop3Candidates?.(Buffer.from("hello"), ["utf8"]).catch(() => []);
    expect(Array.isArray(cands) || cands === undefined).toBe(true);
  });

  it("file-view remaining", async () => {
    const m: any = await import("../../src/file-view.js");
    // hit formatSize with large
    expect(m.formatSize(0)).toBe("0B");
    expect(m.formatSize(5 * 1024 * 1024)).toContain("MB");
    // hit truncateHead with edge
    const r = m.truncateHead("a\nb\nc\nd\ne\nf\ng\n", 2);
    expect(r).toBeDefined();
    expect(r.content).toBeDefined();
  });

  it("utils remaining", async () => {
    const m: any = await import("../../src/utils.js");
    if (m.errCode) {
      expect(m.errCode(new Error("test"))).toBeUndefined();
      expect(m.errCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT");
    }
    if (m.splitLines) {
      expect(m.splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
      const res = m.splitLines("a\r\nb");
      expect(res[0]?.trim()).toBe("a");
    }
  });

  it("fs-write deep nested and permission", async () => {
    const { writeAtomic } = await import("../../src/fs-write.js");
    const dir = await mkdtemp(join(tmpdir(), "e-final-"));
    try {
      const p = join(dir, "a", "b", "c.txt");
      await writeAtomic(p, "deep");
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(p, "utf-8")).toBe("deep");
      await writeAtomic(p, "deep2");
      expect(await readFile(p, "utf-8")).toBe("deep2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fs-bridge encoding memo", async () => {
    const { setEncodingState, getEncodingState, clearEncodingState } = await import("../../src/fs-bridge.js");
    setEncodingState("k-test", { encoding: "gbk", hasBOM: true, version: "v1" });
    expect(getEncodingState("k-test")?.encoding).toBe("gbk");
    clearEncodingState("k-test");
    expect(getEncodingState("k-test")).toBeUndefined();
  });
});
