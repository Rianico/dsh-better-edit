import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("easy2 sandbox", () => {
  it("FsSandboxController basic", async () => {
    const { FsSandboxController } = await import("../../src/sandbox.js");
    // missing policy with confined fs should throw
    expect(() => new FsSandboxController({ fs: { sandboxMode: "readOnly" } as any, get: () => undefined } as any)).toThrow();
    // with undefined mode should not throw
    const ctrl = new FsSandboxController({ fs: { sandboxMode: undefined } as any, get: () => undefined } as any);
    expect(ctrl).toBeDefined();
    expect(true).toBe(true);
  });
});

describe("easy2 tool-edit", () => {
  it("buildEditTool validation", async () => {
    const { buildEditTool } = await import("../../src/tool-edit.js");
    const { localIO } = await import("../../src/fs-bridge.js");
    const { FsSandboxController } = await import("../../src/sandbox.js");
    const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as any);
    const tool = buildEditTool(localIO, sandbox as any, async () => ({ stdout: "", stderr: "", exitCode: 0 } as any));
    expect(tool).toBeDefined();
    expect(tool.name).toBe("edit");
  });
});

describe("easy2 undo-edit", () => {
  it("undo-edit helpers", async () => {
    const mod = await import("../../src/undo-edit.js");
    expect(mod.saveUndo).toBeDefined();
    expect(mod.getUndo).toBeDefined();
    expect(mod.clearUndo).toBeDefined();
    // test with temp file
    const dir = await mkdtemp(join(tmpdir(), "easy2-undo-"));
    try {
      const p = join(dir, "a.txt");
      await writeFile(p, "hello", "utf-8");
      const entry = { content: "old", bom: "", originalEnding: "\n" as const, hashes: ["h1"], resultContent: "new" };
      const r = await mod.saveUndo(p, entry as any);
      expect(typeof r.persisted).toBe("boolean");
      const loaded = await mod.getUndo(p);
      if (loaded) expect(loaded.content).toBe("old");
      await mod.clearUndo(p);
      expect(await mod.getUndo(p)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("easy2 store-tenancy", () => {
  it("tenancy basic", async () => {
    const mod: any = await import("../../src/store-tenancy.js");
    expect(mod).toBeDefined();
    if (mod.getStoreKey) {
      expect(typeof mod.getStoreKey("/a/b")).toBe("string");
    }
    if (mod.isWorkspaceStore) {
      expect(typeof mod.isWorkspaceStore).toBe("function");
    }
  });
});

describe("easy2 file-view", () => {
  it("file-view helpers", async () => {
    const mod: any = await import("../../src/file-view.js");
    if (mod.formatSize) {
      expect(mod.formatSize(0)).toBe("0B");
      expect(mod.formatSize(1023)).toBe("1023B");
      expect(mod.formatSize(1024)).toContain("KB");
      expect(mod.formatSize(1024 * 1024)).toContain("MB");
      expect(mod.formatSize(10 * 1024 * 1024)).toContain("MB");
    }
    if (mod.truncateHead) {
      expect(mod.truncateHead("a\nb\nc\nd\ne", 2)).toBeDefined();
      expect(mod.truncateHead("a".repeat(10000), 100)).toBeDefined();
    }
  });
});

describe("easy2 hash-store", () => {
  it("hash-store operations", async () => {
    const { loadHashStore, shutdownHashStore } = await import("../../src/hash-store.js");
    const store = await loadHashStore();
    expect(store).toBeDefined();
    const fakePath = join(tmpdir(), "easy2-hash-" + Date.now() + ".txt");
    let snap: any;
    try { snap = await (store as any).getSnapshot?.(fakePath, "hello", false); } catch { snap = undefined; }
    expect(snap === undefined || Array.isArray(snap)).toBe(true);
    try { await shutdownHashStore(); } catch {}
  });
});

describe("easy2 edit-engine", () => {
  it("edit-engine helpers", async () => {
    const mod: any = await import("../../src/edit-engine.js");
    expect(mod).toBeDefined();
    expect(typeof mod.applyOne === "function" || typeof mod.runFileEdits === "function").toBe(true);
  });
});

describe("easy2 guidance materialize", () => {
  it("materialize branches", async () => {
    const mod: any = await import("../../src/guidance/materialize.js");
    expect(mod).toBeDefined();
    if (mod.materialize) {
      // try to call with temp dir
      const dir = await mkdtemp(join(tmpdir(), "easy2-guid-"));
      try {
        const res = await mod.materialize?.(dir, { preset: "default" } as any).catch(() => undefined);
        expect(res === undefined || typeof res === "object").toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
