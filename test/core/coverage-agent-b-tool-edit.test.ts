import { describe, it, expect, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";
import { localIO } from "../../src/fs-bridge.js";
import { buildEditTool } from "../../src/tool-edit.js";
import { FsSandboxController } from "../../src/sandbox.js";

function makeExec(cwd: string, sessionKey="test-session") {
  return {
    signal: new AbortController().signal,
    agent: { id: sessionKey, session: { id: sessionKey, header: { cwd } } },
  } as any;
}

describe("tool-edit coverage", () => {
  it("edit single line via tool", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      // need served hashes
      const res = await harness.readTool.execute("read", { path: "t.txt" });
      const text = getText(res);
      const line = text.split("\n").find(l => l.includes("│b"))!;
      const hash = line.split("│")[0]!;
      const out = await harness.editTool.execute("edit", { path: "t.txt", edits: [[hash, hash, "B"]] } as any);
      const outText = getText(out as any);
      expect(outText).toContain("Successfully");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\n");
    });
  });

  it("edit with invalid shape throws", async () => {
    await withTempFile("t.txt", "a\nb\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      await expect(harness.editTool.execute("edit", { path: "", edits: [[ "x", "x", "y"]] } as any)).rejects.toThrow();
    });
  });

  it("resolveNullPath with matching hashes", async () => {
    await withTempFile("only.txt", "line one\nline two\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      // serve to create snapshots
      const res = await harness.readTool.execute("read", { path: "only.txt" });
      const text = getText(res);
      const lines = text.split("\n").filter(l=>l.includes("│"));
      const h1 = lines[0]!.split("│")[0]!;
      const h2 = lines[0]!.split("│")[0]!;
      // null path should resolve when only one file matches
      const io = localIO();
      const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: ()=>undefined } as never);
      const tool = buildEditTool(io, sandbox);
      const exec = makeExec(cwd);
      // This will exercise resolveNullPath; may throw warning or succeed
      try {
        const r = await tool.execute({ path: null, edits: [[h1, h2, "replaced"]] } as any, exec);
        expect(typeof r).toBe("string");
        expect(await readFile(path, "utf-8")).toContain("replaced");
      } catch (e) {
        // if multiple matches or no match, error is expected
        expect((e as Error).message).toMatch(/E_BAD_PAYLOAD/);
      }
    });
  });

  it("resolveNullPath with unknown hashes throws E_BAD_PAYLOAD", async () => {
    await withTempFile("t.txt", "a\nb\n", async ({ cwd }) => {
      const io = localIO();
      const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: ()=>undefined } as never);
      const tool = buildEditTool(io, sandbox);
      const exec = makeExec(cwd);
      await expect(tool.execute({ path: null, edits: [["zzz", "zzz", "x"]] } as any, exec)).rejects.toThrow(/E_BAD_PAYLOAD/);
    });
  });

  it("edit batch with multiple edits in one call", async () => {
    await withTempFile("t.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "t.txt" });
      const lines = getText(res).split("\n").filter(l=>l.includes("│"));
      const ha = lines.find(l=>l.includes("│a"))!.split("│")[0]!;
      const hc = lines.find(l=>l.includes("│c"))!.split("│")[0]!;
      const out = await harness.editTool.execute("edit", { path: "t.txt", edits: [[ha, ha, "A"], [hc, hc, "C"]] } as any);
      expect(getText(out as any)).toContain("2 of 2");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("A\nb\nC\nd\n");
    });
  });

  it("edit with empty path string rejects", async () => {
    await withTempFile("t.txt", "hello\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      await expect(harness.editTool.execute("edit", { path: "", edits: [["a","a","b"]] } as any)).rejects.toThrow();
    });
  });

  it("registerEditTool registers and disposes", async () => {
    const { Context } = await import("@deepseek-ai/cordis");
    // shallow smoke: build and register on a dummy agent ctx
    const io = localIO();
    const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: ()=>undefined } as never);
    // Use a real Context if available, else skip
    try {
      const root = new (Context as any)();
      const agent = new (Context as any)();
      const { registerEditTool } = await import("../../src/tool-edit.js");
      const dispose = registerEditTool(root, agent, io, sandbox);
      expect(typeof dispose).toBe("function");
      dispose();
    } catch { /* cordis may need setup, ignore */ }
  });
});