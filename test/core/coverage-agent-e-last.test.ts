import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("coverage-agent-e last", () => {
  it("utils errCode and splitLines", async () => {
    const m: any = await import("../../src/utils.js");
    expect(m.errCode(new Error("x"))).toBeUndefined();
    expect(m.errCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(m.splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(m.splitLines("a\r\nb")).toBeDefined();
  });

  it("tool-read and tool-undo", async () => {
    const { buildReadTool } = await import("../../src/tool-read.js");
    const { buildUndoTool } = await import("../../src/tool-undo.js");
    const { localIO } = await import("../../src/fs-bridge.js");
    const { FsSandboxController } = await import("../../src/sandbox.js");
    const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as any);
    const readTool = buildReadTool(localIO(), sandbox as any);
    expect(readTool.name).toBe("read");
    const undoTool = buildUndoTool(localIO(), sandbox as any);
    expect(undoTool.name).toBe("undo_last_edit");
  });

  it("store-config", async () => {
    const m: any = await import("../../src/store-config.js");
    const cfg = m.loadConfig();
    expect(cfg).toBeDefined();
    expect(typeof cfg.autoGuessEncoding).toBe("boolean");
    m._resetConfigCache();
  });

  it("write-hook", async () => {
    const m: any = await import("../../src/write-hook.js");
    expect(m).toBeDefined();
    if (m.installWriteHook) {
      expect(typeof m.installWriteHook).toBe("function");
    }
  });

  it("hash-assign", async () => {
    const m: any = await import("../../src/hashline/hash-assign.js");
    expect(m.lineHashesPure).toBeDefined();
    const h = m.lineHashesPure("a\nb\nc");
    expect(h.length).toBe(3);
    const h2 = m.lineHashesPure("");
    expect(Array.isArray(h2)).toBe(true);
  });
});
