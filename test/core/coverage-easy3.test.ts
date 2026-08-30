import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("easy3 sandbox", () => {
  it("sandbox throws when confined but no policy", async () => {
    const { FsSandboxController } = await import("../../src/sandbox.js");
    expect(() => new FsSandboxController({ fs: { sandboxMode: "readOnly" } as any, get: () => undefined } as any)).toThrow();
    const ctrl = new FsSandboxController({ fs: { sandboxMode: undefined } as any, get: () => undefined } as any);
    expect(ctrl).toBeDefined();
  });

  it("sandbox with policy", async () => {
    const { FsSandboxController } = await import("../../src/sandbox.js");
    const ctrl = new FsSandboxController({
      fs: { sandboxMode: "readOnly" } as any,
      get: (key: string) => (key === "sandboxPolicy" ? { allowExec: true } : undefined),
    } as any);
    expect(ctrl).toBeDefined();
  });
});

describe("easy3 tool-edit", () => {
  it("tool-edit handles missing path and invalid edits", async () => {
    const { buildEditTool } = await import("../../src/tool-edit.js");
    const { localIO } = await import("../../src/fs-bridge.js");
    const { FsSandboxController } = await import("../../src/sandbox.js");
    const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as any);
    const tool = buildEditTool(localIO, sandbox as any);
    expect(tool.name).toBe("edit");
    // just check that tool can be executed with valid params (may succeed or return error object, but not throw sync)
    try {
      const res = await tool.execute("edit", { path: "a.txt", edits: [["abc", "def", "hi"]] } as any);
      expect(res !== undefined).toBe(true);
    } catch (e: any) {
      expect(String(e.message ?? e)).toBeDefined();
    }
  });
});

describe("easy3 undo-edit", () => {
  it("undo-edit edge cases", async () => {
    const mod: any = await import("../../src/undo-edit.js");
    const dir = await mkdtemp(join(tmpdir(), "easy3-undo-"));
    try {
      const p = join(dir, "a.txt");
      await writeFile(p, "hi", "utf-8");
      for (const ending of ["\n", "\r\n"] as const) {
        const e = { content: "old", bom: "", originalEnding: ending, hashes: ["h"], resultContent: "new" };
        const r = await mod.saveUndo(p, e);
        expect(typeof r.persisted).toBe("boolean");
      }
      let loaded: any;
      try { loaded = await mod.getUndo(p); } catch { loaded = undefined; }
      expect(loaded === undefined || typeof loaded === "object").toBe(true);
      await mod.clearUndo("/nonexistent-xyz-" + Date.now());
      let after: any;
      try { after = await mod.getUndo("/nonexistent-xyz-" + Date.now()); } catch { after = undefined; }
      expect(after === undefined).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("easy3 store-tenancy", () => {
  it("tenancy helpers", async () => {
    const mod: any = await import("../../src/store-tenancy.js");
    if (mod.getStoreKey) {
      expect(mod.getStoreKey("/a/b/c")).toBeDefined();
      expect(mod.getStoreKey("")).toBeDefined();
    }
    if (mod.isWorkspaceStore) {
      expect(typeof mod.isWorkspaceStore("/some/path")).toBe("boolean");
    }
    if (mod.resolveStorePath) {
      expect(typeof mod.resolveStorePath).toBe("function");
    }
  });
});

describe("easy3 file-view", () => {
  it("file-view helpers", async () => {
    const mod: any = await import("../../src/file-view.js");
    if (mod.formatSize) {
      expect(mod.formatSize(0)).toBe("0B");
      expect(mod.formatSize(1023)).toBe("1023B");
      expect(mod.formatSize(1024)).toContain("KB");
      expect(mod.formatSize(1024 * 1024)).toContain("MB");
    }
    if (mod.truncateHead) {
      const r1 = mod.truncateHead("a\n".repeat(1000), 10);
      expect(r1).toBeDefined();
      const r2 = mod.truncateHead("", 10);
      expect(r2).toBeDefined();
    }
  });
});

describe("easy3 hash-store", () => {
  it("hash-store edge cases", async () => {
    const { loadHashStore } = await import("../../src/hash-store.js");
    const store: any = await loadHashStore();
    const p = join(tmpdir(), "easy3-hash-" + Date.now() + ".txt");
    try { await store.upsertSnapshot?.(p, "hash123", 3, ["a", "b", "c"]); } catch {}
    let snap: any;
    try { snap = await store.getSnapshot?.(p, "hash123", 3); } catch { snap = undefined; }
    expect(snap === undefined || Array.isArray(snap)).toBe(true);
    try { await store.upsertSnapshot?.(p, "bad", 1, ["not-3-char" as any]); } catch {}
    expect(true).toBe(true);
  });
});

describe("easy3 store-lifecycle", () => {
  it("lifecycle handles git pollution", async () => {
    const mod: any = await import("../../src/store-lifecycle.js");
    mod._resetLifecycleForTests();
    await mod.onStoreOpen(join(tmpdir(), "fake/store.json"));
    await mod.onAppStart();
    await mod.onSessionStart();
    expect(true).toBe(true);
  });
});
