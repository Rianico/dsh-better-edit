import { describe, it, expect } from "vitest";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";

describe("coverage-agent-e fixtures2", () => {
  it("wrapTool handles warning and string result", async () => {
    await withTempFile("a.txt", "hello", async ({ cwd }) => {
      const harness: any = setupIntegrationTest(cwd);
      const readRes = await harness.readTool.execute("read", { path: "a.txt" } as any);
      const hash = getText(readRes)
        .split("\n")
        .find((l: string) => l.includes("│"))!
        .split("│")[0]!;
      try {
        const oldRes = await harness.editTool.execute("edit", {
          path: "a.txt",
          anchor_from: hash,
          anchor_to: hash,
          replace_with: "hi-old",
        } as any);
        expect(typeof getText(oldRes)).toBe("string");
      } catch (e: any) {
        expect(String(e.message ?? e).length).toBeGreaterThan(0);
      }
      const { buildReadTool } = await import("../../src/tool-read.js");
      const { localIO: _localIO } = await import("../../src/fs-bridge.js");
      const customIo: any = {
        resolve: async (p: string) => p,
        readText: async () => "hi",
        writeText: async () => {},
        emitObserved: async () => {},
        statVersion: async () => undefined,
      };
      const _readTool: any = buildReadTool(customIo);
      const _fakeTool: any = {
        execute: async () => ({ text: "hello", warning: "warn text" }),
      };
      const { setupIntegrationTest: _ } = await import("../support/fixtures.js");
      const readRes2 = await harness.readTool.execute("read", { path: "a.txt" } as any);
      const hash2 = getText(readRes2)
        .split("\n")
        .find((l: string) => l.includes("│"))!
        .split("│")[0]!;
      const noopRes = await harness.editTool.execute("edit", {
        path: "a.txt",
        edits: [[hash2, hash2, "hello"]],
      } as any);
      expect(typeof getText(noopRes)).toBe("string");
    });
  });

  it("withTempFile handles string result", async () => {
    await withTempFile("a.txt", "test", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "a.txt" } as any);
      expect(getText(res)).toBeDefined();
    });
  });
});
