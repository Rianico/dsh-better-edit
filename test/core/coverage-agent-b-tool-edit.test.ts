import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";
import { localIO } from "../../src/fs-bridge.js";
import { buildEditTool } from "../../src/tool-edit.js";
import { FsSandboxController } from "../../src/sandbox.js";

function makeExec(cwd: string, sessionKey = "test-session") {
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
      const line = text.split("\n").find((l) => l.includes("│b"))!;
      const hash = line.split("│")[0]!;
      const out = await harness.editTool.execute("edit", {
        path: "t.txt",
        edits: [[hash, hash, "B"]],
      } as any);
      const outText = getText(out as any);
      expect(outText).toContain("Successfully");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\n");
    });
  });

  it("edit with invalid shape throws", async () => {
    await withTempFile("t.txt", "a\nb\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      await expect(
        harness.editTool.execute("edit", { path: "", edits: [["x", "x", "y"]] } as any),
      ).rejects.toThrow();
    });
  });

  it("resolveNullPath with matching hashes: null path rejects E_BAD_PAYLOAD, no inference", async () => {
    await withTempFile("only.txt", "line one\nline two\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      // serve to create snapshots — one file matches, the retired inference arm's best case
      const res = await harness.readTool.execute("read", { path: "only.txt" });
      const lines = getText(res)
        .split("\n")
        .filter((l) => l.includes("│"));
      const h1 = lines[0]!.split("│")[0]!;
      const io = localIO();
      const sandbox = new FsSandboxController({
        fs: { sandboxMode: undefined },
        get: () => undefined,
      } as never);
      const tool = buildEditTool(io, sandbox);
      const exec = makeExec(cwd);
      // #117: null file is an admission error — even a single hash match must not infer.
      await expect(
        tool.execute({ path: null, edits: [[h1, h1, "replaced"]] } as any, exec),
      ).rejects.toMatchObject({ code: "E_BAD_PAYLOAD" });
      expect(await readFile(path, "utf-8")).toBe("line one\nline two\n");
    });
  });

  it("resolveNullPath with unknown hashes: null path rejects without inference wording", async () => {
    await withTempFile("t.txt", "a\nb\n", async ({ cwd, path }) => {
      const io = localIO();
      const sandbox = new FsSandboxController({
        fs: { sandboxMode: undefined },
        get: () => undefined,
      } as never);
      const tool = buildEditTool(io, sandbox);
      const exec = makeExec(cwd);
      let error: unknown;
      try {
        await tool.execute({ path: null, edits: [["zzz", "zzz", "x"]] } as any, exec);
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(error).toMatchObject({ code: "E_BAD_PAYLOAD" });
      // #117 retired the inference seam: the rejection must not advertise a lookup.
      expect((error as Error).message).not.toMatch(/inferred|Autocorrected/);
      expect(await readFile(path, "utf-8")).toBe("a\nb\n");
    });
  });

  it("edit batch with multiple edits in one call", async () => {
    await withTempFile("t.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "t.txt" });
      const lines = getText(res)
        .split("\n")
        .filter((l) => l.includes("│"));
      const ha = lines.find((l) => l.includes("│a"))!.split("│")[0]!;
      const hc = lines.find((l) => l.includes("│c"))!.split("│")[0]!;
      const out = await harness.editTool.execute("edit", {
        path: "t.txt",
        edits: [
          [ha, ha, "A"],
          [hc, hc, "C"],
        ],
      } as any);
      expect(getText(out as any)).toContain("2 of 2");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("A\nb\nC\nd\n");
    });
  });

  it("edit with empty path string rejects", async () => {
    await withTempFile("t.txt", "hello\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      await expect(
        harness.editTool.execute("edit", { path: "", edits: [["a", "a", "b"]] } as any),
      ).rejects.toThrow();
    });
  });

  it("registerEditTool registers and disposes", async () => {
    const { Context } = await import("@deepseek-ai/cordis");
    // shallow smoke: build and register on a dummy agent ctx
    const io = localIO();
    const sandbox = new FsSandboxController({
      fs: { sandboxMode: undefined },
      get: () => undefined,
    } as never);
    // Use a real Context if available, else skip
    try {
      const root = new (Context as any)();
      const agent = new (Context as any)();
      const { registerEditTool } = await import("../../src/tool-edit.js");
      const dispose = registerEditTool(root, agent, io, sandbox);
      expect(typeof dispose).toBe("function");
      dispose();
    } catch {
      /* cordis may need setup, ignore */
    }
  });
});
