import { describe, it, expect } from "vitest";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";

describe("coverage-agent-e tool", () => {
  it("tool-edit validation", async () => {
    await withTempFile("a.txt", "hello", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      await expect(harness.editTool.execute("edit", { path: "a.txt", edits: [] } as any)).rejects.toThrow(/E_BAD_SHAPE/);
      await expect(harness.editTool.execute("edit", { path: "a.txt", edits: [["bad", "bad2", "x"]] } as any)).rejects.toThrow();
    });
  });

  it("tool-undo and read", async () => {
    await withTempFile("a.txt", "a\nb\nc\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const readRes = await harness.readTool.execute("read", { path: "a.txt" } as any);
      const hash = getText(readRes).split("\n").find(l=>l.includes("│b"))!.split("│")[0]!;
      await harness.editTool.execute("edit", { path: "a.txt", edits: [[hash, hash, "BB"]] } as any);
      const undoRes = await harness.getTool("undo_last_edit").execute("undo_last_edit", { path: "a.txt" } as any);
      expect(getText(undoRes).length).toBeGreaterThan(0);
      const read2 = await harness.readTool.execute("read", { path: "a.txt" } as any);
      expect(getText(read2).length).toBeGreaterThan(0);
    });
  });

  it("sandbox controller", async () => {
    const { FsSandboxController } = await import("../../src/sandbox.js");
    expect(() => new FsSandboxController({ fs: { sandboxMode: "readOnly" } as any, get: () => undefined } as any)).toThrow();
    const c = new FsSandboxController({ fs: { sandboxMode: undefined } as any, get: () => undefined } as any);
    expect(c).toBeDefined();
  });
});
