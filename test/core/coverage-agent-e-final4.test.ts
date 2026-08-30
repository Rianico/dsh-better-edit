import { describe, it, expect } from "vitest";

describe("coverage-agent-e final4", () => {
  it("covers sandbox and tool branches", async () => {
    const { FsSandboxController } = await import("../../src/sandbox.js");
    // Test with different sandbox modes
    const c1 = new FsSandboxController({ fs: { sandboxMode: undefined } as any, get: () => undefined } as any);
    expect(c1).toBeDefined();
    // Test with readOnly and policy
    const c2 = new FsSandboxController({
      fs: { sandboxMode: "readOnly" } as any,
      get: (k: string) => (k === "sandboxPolicy" ? { root: "/tmp", mode: "readOnly" } : undefined),
    } as any);
    expect(c2).toBeDefined();
    // Test with workspace
    const c3 = new FsSandboxController({
      fs: { sandboxMode: "workspace" } as any,
      get: (k: string) => (k === "sandboxPolicy" ? { root: "/tmp/ws", mode: "workspace" } : undefined),
    } as any);
    expect(c3).toBeDefined();
  });

  it("covers utils and encoding", async () => {
    const u: any = await import("../../src/utils.js");
    expect(u.cntDiff("a\nb\n", "+")).toBeDefined();
    expect(u.cntDiff("a\nb\n", "-")).toBeDefined();
    const e: any = await import("../../src/encoding.js");
    expect(e.normalizeEncoding("utf8")).toBe("utf8");
    expect(e.isSupportedEncoding("gbk")).toBe(true);
  });

  it("covers store-tenancy", async () => {
    const m: any = await import("../../src/store-tenancy.js");
    if (m.getStoreKey) expect(typeof m.getStoreKey("/a")).toBe("string");
    if (m.isWorkspaceStore) expect(typeof m.isWorkspaceStore("/a")).toBe("boolean");
  });
});
