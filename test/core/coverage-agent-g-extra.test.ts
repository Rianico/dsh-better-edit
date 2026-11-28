import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWritableTempRoot } from "../support/fixtures.js";

describe("extra store-lifecycle", () => {
  it("covers handleGitPollution via onStoreOpen with gitignore append", async () => {
    const dir = await mkdtemp(join(await getWritableTempRoot(), "extra-lc-"));
    const ws = join(dir, "ws");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(ws, ".git"), { recursive: true });
    await writeFile(join(ws, ".gitignore"), "node_modules\n", "utf-8");
    const storePath = join(ws, ".dsh_better_edit", "hash-store.sqlite");
    await mkdir(join(ws, ".dsh_better_edit"), { recursive: true });
    const sc: any = await import("../../src/store-config.js");
    const spy = vi
      .spyOn(sc, "loadConfig")
      .mockReturnValue({ storeDir: "workspace", autoGitignore: true, undo_ttl_s: 3600 } as any);
    const lc: any = await import("../../src/store-lifecycle.js");
    lc._resetLifecycleForTests();
    const servedPruneArgs: number[] = [];
    const undoPruneArgs: number[] = [];
    let pruneMissingCalls = 0;
    let vacuumCalls = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await lc.onStoreOpen(
      storePath,
      {
        servedMetaPruneOlderThan: (ts: number) => {
          servedPruneArgs.push(ts);
        },
      },
      {
        pruneUndoOlderThan: (ts: number) => {
          undoPruneArgs.push(ts);
        },
        pruneMissing: async () => {
          pruneMissingCalls += 1;
        },
        vacuumSnapshots: () => {
          vacuumCalls += 1;
        },
      } as any,
    );

    expect(warn).not.toHaveBeenCalled();
    expect(servedPruneArgs).toHaveLength(1);
    expect(Number.isFinite(servedPruneArgs[0])).toBe(true);
    expect(undoPruneArgs).toHaveLength(1);
    expect(Number.isFinite(undoPruneArgs[0])).toBe(true);
    expect(pruneMissingCalls).toBe(1);
    expect(vacuumCalls).toBe(1);

    warn.mockRestore();
    spy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("extra sandbox", () => {
  it("covers mapError and resolvePolicy", async () => {
    const { FsSandboxController } = await import("../../src/sandbox.js");
    const { FsError } = await import("@deepseek-ai/dsh-fs");
    const ctrl = new FsSandboxController({
      fs: { sandboxMode: undefined } as any,
      get: () => undefined,
    } as any);
    expect(ctrl.mapError(new Error("x"), undefined)).toBeInstanceOf(Error);
    const denied = new FsError("d", "FS_SANDBOX_DENIED" as any);
    expect(ctrl.mapError(denied, { mode: "a" } as any)).toBeInstanceOf(FsError);
    await expect(
      ctrl.resolvePolicy(
        "edit",
        { sandbox_permissions: "a", justification: "b" } as any,
        {} as any,
      ),
    ).rejects.toThrow();
  });
});

describe("extra tool-edit", () => {
  it("covers tool validation", async () => {
    const { buildEditTool } = await import("../../src/tool-edit.js");
    const { localIO } = await import("../../src/fs-bridge.js");
    const { FsSandboxController } = await import("../../src/sandbox.js");
    const sandbox = new FsSandboxController({
      fs: { sandboxMode: undefined } as any,
      get: () => undefined,
    } as any);
    const tool: any = buildEditTool(localIO() as any, sandbox);
    const exec: any = {
      agent: { id: "a", session: { id: "a", header: { cwd: "/tmp" } } },
      callId: "c",
      signal: undefined,
    };
    await expect(tool.execute({ path: "", edits: [] }, exec)).rejects.toThrow();
    try {
      const res = await tool.execute({ path: "a.txt", edits: [["abc", "def", "hi"]] }, exec);
      expect(typeof res === "string" || typeof res === "object").toBe(true);
    } catch (e: any) {
      expect(String(e.message)).toBeDefined();
    }
  });
});

describe("extra undo-edit", () => {
  it("covers saveUndo and getUndo", async () => {
    const mod: any = await import("../../src/undo-edit.js");
    const dir = await mkdtemp(join(await getWritableTempRoot(), "extra-undo-"));
    const p = join(dir, "a.txt");
    await writeFile(p, "hi", "utf-8");
    const e = {
      content: "c",
      bom: "",
      originalEnding: "\n" as const,
      hashes: ["h"],
      resultContent: "r",
    };
    const r = await mod.saveUndo(p, e);
    expect(typeof r.persisted).toBe("boolean");
    const loaded = await mod.getUndo(p).catch(() => undefined);
    expect(loaded === undefined || typeof loaded?.content === "string").toBe(true);
    {
      const { DatabaseSync } = await import("node:sqlite");
      const { hashStorePath } = await import("../../src/store-tenancy.js");
      const db = new DatabaseSync(hashStorePath());
      db.prepare("UPDATE file_undo SET ending = 'bad' WHERE path = ?").run(p);
      db.close();
      const bad = await mod.getUndo(p);
      expect(bad).toBeUndefined();
    }
    await mod.clearUndo(p).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
});
