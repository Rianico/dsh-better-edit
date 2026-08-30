import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatSize, truncateHead, formatPaginationHint, fmtReadPreview, preview, valKind, valAccess } from "../../src/file-view.js";
import { DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "../../src/file-view.js";

describe("coverage-agent-d file-view", () => {
  it("formatSize branches", () => {
    expect(formatSize(500)).toBe("500B");
    expect(formatSize(2048)).toBe("2.0KB");
    expect(formatSize(2*1024*1024)).toBe("2.0MB");
  });
  it("truncateHead no truncation", () => {
    const r = truncateHead("a\nb\nc", {});
    expect(r.truncated).toBe(false);
    expect(r.truncatedBy).toBeNull();
  });
  it("truncateHead first line exceeds bytes", () => {
    const big = "x".repeat(DEFAULT_MAX_BYTES+10);
    const r = truncateHead(big, { maxBytes: 10 });
    expect(r.firstLineExceedsLimit).toBe(true);
    expect(r.truncatedBy).toBe("bytes");
    expect(r.outputLines).toBe(0);
  });
  it("truncateHead truncates by lines", () => {
    const content = Array.from({length: 3000}, (_,i)=>`line ${i}`).join("\n");
    const r = truncateHead(content, { maxLines: 10, maxBytes: 1_000_000 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("lines");
    expect(r.outputLines).toBe(10);
  });
  it("truncateHead truncates by bytes", () => {
    const content = "a".repeat(1000) + "\n" + "b".repeat(1000) + "\n" + "c".repeat(1000);
    const r = truncateHead(content, { maxLines: 10000, maxBytes: 1500 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("bytes");
  });
  it("truncateHead empty content", () => {
    const r = truncateHead("", {});
    expect(r.totalLines).toBe(0);
    expect(r.truncated).toBe(false);
  });
  it("formatPaginationHint", () => {
    expect(formatPaginationHint(1,10,100,11)).toContain("Showing lines 1-10");
    expect(formatPaginationHint(1,10,100,11, 1024)).toContain("limit");
  });
  it("fmtReadPreview empty file", async () => {
    const r = await fmtReadPreview("", {}, [], "/tmp/empty.txt");
    expect(r.text).toContain("File is empty");
    expect(r.served.length).toBe(1);
    const r2 = await fmtReadPreview("", {offset:5}, [], "/tmp/empty.txt");
    expect(r2.text).toContain("beyond end");
  });
  it("fmtReadPreview offset beyond total", async () => {
    const r = await fmtReadPreview("a\nb\nc", {offset:10}, undefined, "/tmp/f.txt");
    expect(r.text).toContain("beyond end");
  });
  it("fmtReadPreview pagination hint", async () => {
    const content = Array.from({length:20},(_,i)=>`line ${i}`).join("\n");
    const r = await fmtReadPreview(content, {limit:5}, undefined, "/tmp/f.txt", 1_000_000, 5);
    // truncated by lines
    expect(r.text).toContain("Showing lines");
    expect(r.nextOffset).toBeDefined();
  });
  it("fmtReadPreview oversized line", async () => {
    const long = "x".repeat(1000);
    const content = `a\n${long}\nb`;
    const r = await fmtReadPreview(content, {}, undefined, "/tmp/f.txt", 10);
    expect(r.text).toContain("exceeds");
  });
  it("valKind throws for each kind", () => {
    expect(()=>valKind({kind:"directory"} as any, "/tmp/d")).toThrow(/directory/);
    expect(()=>valKind({kind:"binary", description:"bin"} as any, "/tmp/b")).toThrow(/binary/);
    expect(()=>valKind({kind:"image", mimeType:"image/png"} as any, "/tmp/i")).toThrow(/image/);
    expect(()=>valKind({kind:"text", text:"hi"} as any, "/tmp/t")).not.toThrow();
  });
  it("valAccess throws E_NOT_FOUND and ELOOP", async () => {
    await expect(valAccess("/no/such/file/abc", "/no/such/file/abc")).rejects.toThrow(/E_NOT_FOUND/);
  });
  it("preview helper", async () => {
    const r = await preview("a\nb\nc", ["aaa","bbb","ccc"], {limit:2}, "/tmp/f.txt");
    expect(r.text).toContain("aaa");
  });
});
