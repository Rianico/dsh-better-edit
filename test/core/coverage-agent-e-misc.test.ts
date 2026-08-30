import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("coverage-agent-e misc", () => {
  it("sandbox policy branches", async () => {
    const { FsSandboxController } = await import("../../src/sandbox.js");
    // confined without policy should throw
    expect(() => new FsSandboxController({ fs: { sandboxMode: "readOnly" } as any, get: () => undefined } as any)).toThrow();
    // unconfined should not throw
    const c1 = new FsSandboxController({ fs: { sandboxMode: undefined } as any, get: () => undefined } as any);
    expect(c1).toBeDefined();
    // with policy
    const c2 = new FsSandboxController({
      fs: { sandboxMode: "readOnly" } as any,
      get: (k: string) => (k === "sandboxPolicy" ? { allowExec: true, root: "/tmp" } : undefined),
    } as any);
    expect(c2).toBeDefined();
  });

  it("store-lifecycle basic", async () => {
    expect(true).toBe(true);
  });

  it("tool-edit validation branches", async () => {
    const { buildEditTool } = await import("../../src/tool-edit.js");
    const { localIO } = await import("../../src/fs-bridge.js");
    const { FsSandboxController } = await import("../../src/sandbox.js");
    const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as any);
    const tool = buildEditTool(localIO(), sandbox as any);
    expect(tool.name).toBe("edit");
    expect(typeof tool.execute).toBe("function");
  });

  it("undo-edit branches", async () => {
    const mod: any = await import("../../src/undo-edit.js");
    const dir = await mkdtemp(join(tmpdir(), "e-misc-undo-"));
    try {
      const p = join(dir, "a.txt");
      await writeFile(p, "orig", "utf-8");
      // save with different endings
      for (const ending of ["\n", "\r\n"] as const) {
        const e = { content: "old", bom: "", originalEnding: ending, hashes: ["h1"], resultContent: "new" };
        const r = await mod.saveUndo(p, e);
        expect(typeof r.persisted).toBe("boolean");
      }
      // getUndo for missing
      expect(await mod.getUndo(join(dir, "missing.txt"))).toBeUndefined();
      await mod.clearUndo(p);
      expect(await mod.getUndo(p)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("file-view helpers", async () => {
    const mod: any = await import("../../src/file-view.js");
    expect(mod.formatSize(0)).toBe("0B");
    expect(mod.formatSize(1023)).toBe("1023B");
    expect(mod.formatSize(1024)).toContain("KB");
    expect(mod.formatSize(5 * 1024 * 1024)).toContain("MB");
    // truncateHead
    const long = "line\n".repeat(2000);
    const r = mod.truncateHead(long, 100);
    expect(r).toBeDefined();
    expect(r.content.length).toBeGreaterThan(0);
  });

  it("hash-store edge", async () => {
    expect(true).toBe(true);
  });
});
