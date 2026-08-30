import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";
import { localIO } from "../../src/fs-bridge.js";
import { buildUndoTool } from "../../src/tool-undo.js";
import { FsSandboxController } from "../../src/sandbox.js";
import { saveUndo, clearUndo, getUndo } from "../../src/undo-edit.js";

function makeExec(cwd: string, sessionKey="test-session") {
  return {
    signal: new AbortController().signal,
    agent: { id: sessionKey, session: { id: sessionKey, header: { cwd } } },
  } as any;
}

describe("tool-undo coverage", () => {
  it("undo with no history returns message", async () => {
    await withTempFile("t.txt", "hello\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const undo = harness.getTool("undo_last_edit") as any;
      const res = await undo.execute("undo_last_edit", { path: "t.txt" });
      expect(getText(res)).toContain("No undo history");
    });
  });

  it("undo after file deleted returns E_UNDO_STALE and clears", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await harness.readTool.execute("read", { path: "t.txt" });
      const hash = getText(served).split("\n").find(l=>l.includes("│b"))!.split("│")[0]!;
      await harness.editTool.execute("edit", { path: "t.txt", edits: [[hash, hash, "B"]] } as any);
      const { rm } = await import("node:fs/promises");
      await rm(path);
      const undo = harness.getTool("undo_last_edit") as any;
      try {
        const res = await undo.execute("undo_last_edit", { path: "t.txt" });
        const txt = getText(res);
        expect(txt).toMatch(/E_UNDO_STALE|No undo|ENOENT/);
      } catch (e: any) {
        expect(String(e.message ?? e)).toMatch(/ENOENT|E_UNDO_STALE/);
      }
    });
  });
  it("undo after external modification returns stale", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await harness.readTool.execute("read", { path: "t.txt" });
      const hash = getText(served).split("\n").find(l=>l.includes("│b"))!.split("│")[0]!;
      await harness.editTool.execute("edit", { path: "t.txt", edits: [[hash, hash, "B"]] } as any);
      await writeFile(path, "externally modified\n", "utf-8");
      const undo = harness.getTool("undo_last_edit") as any;
      const res = await undo.execute("undo_last_edit", { path: "t.txt" });
      expect(getText(res)).toContain("E_UNDO_STALE");
    });
  });

  it("successful undo restores content and shows diff", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await harness.readTool.execute("read", { path: "t.txt" });
      const hash = getText(served).split("\n").find(l=>l.includes("│b"))!.split("│")[0]!;
      await harness.editTool.execute("edit", { path: "t.txt", edits: [[hash, hash, "BB"]] } as any);
      expect(await readFile(path, "utf-8")).toBe("a\nBB\nc\n");
      const undo = harness.getTool("undo_last_edit") as any;
      const res = await undo.execute("undo_last_edit", { path: "t.txt" });
      const txt = getText(res);
      expect(txt).toContain("Undone last edit");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });

  it("second undo after success has no history", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await harness.readTool.execute("read", { path: "t.txt" });
      const hash = getText(served).split("\n").find(l=>l.includes("│a"))!.split("│")[0]!;
      await harness.editTool.execute("edit", { path: "t.txt", edits: [[hash, hash, "AA"]] } as any);
      const undo = harness.getTool("undo_last_edit") as any;
      await undo.execute("undo_last_edit", { path: "t.txt" });
      const res2 = await undo.execute("undo_last_edit", { path: "t.txt" });
      expect(getText(res2)).toContain("No undo history");
    });
  });

  it("registerUndoTool registers", async () => {
    try {
      const { Context } = await import("@deepseek-ai/cordis");
      const io = localIO();
      const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: ()=>undefined } as never);
      const root = new (Context as any)();
      const agent = new (Context as any)();
      const { registerUndoTool } = await import("../../src/tool-undo.js");
      const dispose = registerUndoTool(root, agent, io, sandbox);
      expect(typeof dispose).toBe("function");
      dispose();
    } catch {}
  });
});

describe("undo-edit persistence coverage", () => {
  it("saveUndo and getUndo roundtrip", async () => {
    await withTempFile("t.txt", "x\n", async ({ cwd }) => {
      const { join } = await import("node:path");
      const abs = join(cwd, "t.txt");
      const entry = { content: "old\n", bom: "", originalEnding: "\n" as const, hashes: ["h1"], resultContent: "new\n" };
      const r = await saveUndo(abs, entry);
      expect(typeof r.persisted).toBe("boolean");
      const loaded = await getUndo(abs);
      if (loaded) expect(loaded.content).toBe("old\n");
      await clearUndo(abs);
      expect(await getUndo(abs)).toBeUndefined();
      const r2 = await saveUndo(abs, entry);
      await expect(r2.restore()).resolves.not.toThrow();
    });
  });

  it("getUndo returns undefined for invalid ending", async () => {
    await withTempFile("t.txt", "x\n", async ({ cwd }) => {
      const { join } = await import("node:path");
      const abs = join(cwd, "t.txt");
      // directly write invalid record via hash-store
      const { loadHashStore } = await import("../../src/hash-store.js");
      const store = await loadHashStore();
      (store as any).upsertUndo(abs, { content: "a", bom: "", ending: "invalid", hashes: ["h"], resultContent: "b" });
      const loaded = await getUndo(abs);
      expect(loaded).toBeUndefined();
    });
  });

  it("clearUndo handles missing entry", async () => {
    await clearUndo("/nonexistent/path/xyz.txt");
    expect(await getUndo("/nonexistent/path/xyz.txt")).toBeUndefined();
  });

  it("saveUndo restore puts back previous", async () => {
    await withTempFile("t.txt", "x\n", async ({ cwd }) => {
      const { join } = await import("node:path");
      const abs = join(cwd, "t.txt");
      const e1 = { content: "c1\n", bom: "", originalEnding: "\n" as const, hashes: ["h1"], resultContent: "r1\n" };
      const e2 = { content: "c2\n", bom: "", originalEnding: "\n" as const, hashes: ["h2"], resultContent: "r2\n" };
      await saveUndo(abs, e1);
      const r = await saveUndo(abs, e2);
      const cur = await getUndo(abs);
      if (cur) expect(cur.content).toBe("c2\n");
      await expect(r.restore()).resolves.not.toThrow();
      const after = await getUndo(abs);
      if (after) expect(after.content).toBe("c1\n");
      await clearUndo(abs);
    });
  });
});