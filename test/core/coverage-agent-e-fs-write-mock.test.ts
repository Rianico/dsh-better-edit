import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const actual: any = await vi.importActual("node:fs/promises");
  return {
    ...actual,
    readdir: vi.fn(async (...args: any[]) => {
      if ((globalThis as any).__mockReaddirThrow) {
        (globalThis as any).__mockReaddirThrow = false;
        throw new Error("mock readdir fail");
      }
      return actual.readdir(...args);
    }),
    open: vi.fn(async (...args: any[]) => {
      if ((globalThis as any).__mockOpenThrow) {
        (globalThis as any).__mockOpenThrow = false;
        return {
          writeFile: async () => { throw new Error("write fail"); },
          chmod: async () => {},
          sync: async () => {},
          close: async () => {},
        } as any;
      }
      return actual.open(...args);
    }),
    rename: vi.fn(async (...args: any[]) => {
      if ((globalThis as any).__mockRenameThrow) {
        (globalThis as any).__mockRenameThrow = false;
        throw new Error("rename fail");
      }
      return actual.rename(...args);
    }),
  };
});

describe("coverage-agent-e fs-write mock", () => {
  it("sweepStaleTemps handles readdir failure", async () => {
    (globalThis as any).__mockReaddirThrow = true;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { writeAtomic } = await import("../../src/fs-write.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "e-mock-readdir-"));
    try {
      await writeAtomic(join(dir, "a.txt"), "hello");
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("failed to sweep"), expect.anything());
    } finally {
      consoleSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writeAtomic handles tempHandle write failure", async () => {
    (globalThis as any).__mockOpenThrow = true;
    const { writeAtomic } = await import("../../src/fs-write.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "e-mock-open-"));
    try {
      await expect(writeAtomic(join(dir, "fail.txt"), "hi")).rejects.toThrow("write fail");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writeAtomic handles rename failure", async () => {
    (globalThis as any).__mockRenameThrow = true;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { writeAtomic } = await import("../../src/fs-write.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "e-mock-rename-"));
    try {
      await expect(writeAtomic(join(dir, "r.txt"), "hi")).rejects.toThrow("rename fail");
    } finally {
      consoleSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
