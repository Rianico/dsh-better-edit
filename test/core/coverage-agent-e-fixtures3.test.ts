import { describe, it, expect, vi } from "vitest";
import { withTempFile, setupIntegrationTest } from "../support/fixtures.js";

describe("coverage-agent-e fixtures3", () => {
  it("wrapTool handles number result and warning", async () => {
    // Mock buildReadTool to return a tool that returns number and warning object
    const toolReadMod: any = await import("../../src/tool-read.js");
    const originalBuildReadTool = toolReadMod.buildReadTool;
    const spy = vi.spyOn(toolReadMod, "buildReadTool").mockImplementation((...args: any[]) => {
      return {
        execute: async () => 42 as any, // number should hit String(result) branch
        name: "read",
      } as any;
    });
    await withTempFile("a.txt", "hi", async ({ cwd }) => {
      const harness: any = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "a.txt" } as any);
      // Should have converted 42 to "42" via String(result)
      expect(res.content[0].text).toBe("42");
    });
    spy.mockRestore();

    // Test warning branch: mock to return { text, warning }
    const spy2 = vi.spyOn(toolReadMod, "buildReadTool").mockImplementation((...args: any[]) => {
      return {
        execute: async () => ({ text: "hello", warning: "warn!" } as any),
        name: "read",
      } as any;
    });
    await withTempFile("a.txt", "hi", async ({ cwd }) => {
      const harness: any = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "a.txt" } as any);
      expect(res.content.length).toBe(2);
      expect(res.content[1].text).toBe("warn!");
    });
    spy2.mockRestore();
  });

  it("wrapEdit handles no edits and no remove_from", async () => {
    await withTempFile("a.txt", "hi", async ({ cwd }) => {
      const harness: any = setupIntegrationTest(cwd);
      // No edits and no remove_from should go to base.execute with same params and then throw E_BAD_PAYLOAD
      await expect(harness.editTool.execute("edit", { path: "a.txt" } as any)).rejects.toThrow();
      await expect(harness.editTool.execute("edit", { path: "a.txt", edits: [] } as any)).rejects.toThrow();
    });
  });

  it("makeTestSandbox and getWritableTempRoot", async () => {
    const { getWritableTempRoot, makeTempDir } = await import("../support/fixtures.js");
    const root = await getWritableTempRoot();
    expect(typeof root).toBe("string");
    const dir = await makeTempDir("test-");
    expect(dir.includes("test-")).toBe(true);
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });
});
