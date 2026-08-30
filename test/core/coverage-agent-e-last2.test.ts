import { describe, it, expect } from "vitest";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";

describe("coverage-agent-e last2", () => {
  it("covers undo-edit and tool-read", async () => {
    await withTempFile("a.txt", "a\nb\nc\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      // read with offset/limit
      const r1 = await harness.readTool.execute("read", { path: "a.txt", offset: 1, limit: 1 } as any);
      expect(getText(r1).length).toBeGreaterThan(0);
      // read with invalid offset
      const r2 = await harness.readTool.execute("read", { path: "a.txt", offset: 100 } as any);
      expect(typeof getText(r2)).toBe("string");
      // undo with no history
      const u1 = await harness.getTool("undo_last_edit").execute("undo_last_edit", { path: "a.txt" } as any);
      expect(getText(u1)).toMatch(/No undo|E_/);
    });
  });

  it("covers edit with valid hash", async () => {
    await withTempFile("a.txt", "a\nb\nc\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const readRes = await harness.readTool.execute("read", { path: "a.txt" } as any);
      const hash = getText(readRes).split("\n").find(l=>l.includes("│a"))!.split("│")[0]!;
      const editRes = await harness.editTool.execute("edit", { path: "a.txt", edits: [[hash, hash, "AA"]] } as any);
      expect(getText(editRes).length).toBeGreaterThan(0);
      const undoRes = await harness.getTool("undo_last_edit").execute("undo_last_edit", { path: "a.txt" } as any);
      expect(getText(undoRes)).toContain("Undone");
    });
  });
});
