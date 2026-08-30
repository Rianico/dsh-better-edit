import { describe, it, expect } from "vitest";
import { cntDiff } from "../../src/utils.js";

describe("coverage-last-90", () => {
  it("cntDiff empty", () => {
    expect(cntDiff("", "+")).toBe(0);
    expect(cntDiff("hello", "+")).toBe(0);
    expect(cntDiff("+a\n", "+")).toBe(1);
    expect(cntDiff("+++a\n", "+")).toBe(0);
  });

  it("encoding normalize", async () => {
    const m: any = await import("../../src/encoding.js");
    expect(m.normalizeEncoding("utf-8")).toBe("utf8");
    expect(m.normalizeEncoding("  GBK  ")).toBe("gbk");
    expect(m.top3Candidates(Buffer.from("hello"), ["utf8"]).length).toBeGreaterThan(0);
  });

  it("file-view formatSize", async () => {
    const m: any = await import("../../src/file-view.js");
    expect(m.formatSize(0)).toBe("0B");
    expect(m.formatSize(1024)).toContain("KB");
    expect(m.formatSize(1024*1024)).toContain("MB");
  });
});
