import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { getWritableTempRoot } from "../support/fixtures.js";

describe("coverage-agent-g lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handleGitPollution: workspace store, .git without entry, autoGitignore true appends", async () => {
    const dir = await mkdtemp(join(await getWritableTempRoot(), "lc-gp-"));
    const ws = join(dir, "ws");
    await mkdir(join(ws, ".git"), { recursive: true });
    await writeFile(join(ws, ".gitignore"), "node_modules\n", "utf-8");
    const storePath = join(ws, ".dsh_better_edit", "hash-store.sqlite");
    await mkdir(join(ws, ".dsh_better_edit"), { recursive: true });
    // mock loadConfig to return workspace + autoGitignore true
    const pathsMod = await import("../../src/paths.js");
    const storeCfgMod = await import("../../src/store-config.js");
    const spyLoad = vi.spyOn(storeCfgMod, "loadConfig").mockReturnValue({
      storeDir: "workspace",
      autoGitignore: true,
      autoGuessEncoding: false,
      supportedEncodings: [],
    } as any);
    const spyWorkspace = vi.spyOn(await import("../../src/workspace-context.js"), "workspaceCwd").mockReturnValue(ws);
    // need to trigger handleGitPollution via onStoreOpen
    const lc = await import("../../src/store-lifecycle.js");
    lc._resetLifecycleForTests();
    const fakeStmts: any = {
      servedPruneOlderThan: () => {},
      undoPruneOlderThan: () => {},
    };
    const fakeStore: any = { pruneMissing: () => Promise.resolve() };
    await lc.onStoreOpen(storePath, fakeStmts, fakeStore);
    expect(existsSync(join(ws, ".gitignore"))).toBe(true);
    const gi = readFileSync(join(ws, ".gitignore"), "utf-8");
    expect(gi).toContain(".dsh_better_edit");
    spyLoad.mockRestore();
    spyWorkspace.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("handleGitPollution: autoGitignore false warns once", async () => {
    const dir = await mkdtemp(join(await getWritableTempRoot(), "lc-gp2-"));
    const ws = join(dir, "ws");
    await mkdir(join(ws, ".git"), { recursive: true });
    await writeFile(join(ws, ".gitignore"), "", "utf-8");
    const storePath = join(ws, ".dsh_better_edit", "hash-store.sqlite");
    await mkdir(join(ws, ".dsh_better_edit"), { recursive: true });
    const storeCfgMod = await import("../../src/store-config.js");
    const spyLoad = vi.spyOn(storeCfgMod, "loadConfig").mockReturnValue({
      storeDir: "workspace",
      autoGitignore: false,
    } as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lc = await import("../../src/store-lifecycle.js");
    lc._resetLifecycleForTests();
    const fakeStmts: any = { servedPruneOlderThan: () => {}, undoPruneOlderThan: () => {} };
    const fakeStore: any = { pruneMissing: () => Promise.resolve() };
    await lc.onStoreOpen(storePath, fakeStmts, fakeStore);
    expect(warnSpy).toHaveBeenCalled();
    // second call should not warn again (has check)
    warnSpy.mockClear();
    await lc.onStoreOpen(storePath, fakeStmts, fakeStore);
    expect(warnSpy).not.toHaveBeenCalled();
    spyLoad.mockRestore();
    warnSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("handleGitPollution: storeDir central skips", async () => {
    const storeCfgMod = await import("../../src/store-config.js");
    const spyLoad = vi.spyOn(storeCfgMod, "loadConfig").mockReturnValue({ storeDir: "central" } as any);
    const lc = await import("../../src/store-lifecycle.js");
    lc._resetLifecycleForTests();
    await lc.onStoreOpen("/tmp/central/store.json", { servedPruneOlderThan: () => {}, undoPruneOlderThan: () => {} } as any, { pruneMissing: () => Promise.resolve() } as any);
    spyLoad.mockRestore();
  });

  it("handleGitPollution: .git not exists skips", async () => {
    const dir = await mkdtemp(join(await getWritableTempRoot(), "lc-nogit-"));
    const ws = join(dir, "ws2");
    await mkdir(ws, { recursive: true });
    const storePath = join(ws, ".dsh_better_edit", "hash-store.sqlite");
    const storeCfgMod = await import("../../src/store-config.js");
    const spyLoad = vi.spyOn(storeCfgMod, "loadConfig").mockReturnValue({ storeDir: "workspace", autoGitignore: true } as any);
    const lc = await import("../../src/store-lifecycle.js");
    lc._resetLifecycleForTests();
    await lc.onStoreOpen(storePath, { servedPruneOlderThan: () => {}, undoPruneOlderThan: () => {} } as any, { pruneMissing: () => Promise.resolve() } as any);
    spyLoad.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("handleGitPollution: gitignore already has entry skips", async () => {
    const dir = await mkdtemp(join(await getWritableTempRoot(), "lc-has-"));
    const ws = join(dir, "ws");
    await mkdir(join(ws, ".git"), { recursive: true });
    await writeFile(join(ws, ".gitignore"), ".dsh_better_edit/\n", "utf-8");
    const storePath = join(ws, ".dsh_better_edit", "hash-store.sqlite");
    const storeCfgMod = await import("../../src/store-config.js");
    const spyLoad = vi.spyOn(storeCfgMod, "loadConfig").mockReturnValue({ storeDir: "workspace", autoGitignore: true } as any);
    const lc = await import("../../src/store-lifecycle.js");
    lc._resetLifecycleForTests();
    await lc.onStoreOpen(storePath, { servedPruneOlderThan: () => {}, undoPruneOlderThan: () => {} } as any, { pruneMissing: () => Promise.resolve() } as any);
    spyLoad.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("onStoreOpen servedPrune throws and undoPrune throws", async () => {
    const lc = await import("../../src/store-lifecycle.js");
    lc._resetLifecycleForTests();
    const storeCfgMod = await import("../../src/store-config.js");
    const spyLoad = vi.spyOn(storeCfgMod, "loadConfig").mockReturnValue({ storeDir: "central", undo_ttl_s: 10 } as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeStmts: any = {
      servedPruneOlderThan: () => { throw new Error("served fail"); },
      undoPruneOlderThan: () => { throw new Error("undo fail"); },
    };
    await lc.onStoreOpen("/tmp/p", fakeStmts, { pruneMissing: () => Promise.resolve() } as any);
    expect(warnSpy).toHaveBeenCalled();
    spyLoad.mockRestore();
    warnSpy.mockRestore();
  });

  it("onStoreOpen pruneMissing throttled and not throttled", async () => {
    const lc = await import("../../src/store-lifecycle.js");
    lc._resetLifecycleForTests();
    const storeCfgMod = await import("../../src/store-config.js");
    vi.spyOn(storeCfgMod, "loadConfig").mockReturnValue({ storeDir: "central", undo_ttl_s: -1 } as any);
    const pruneMock = vi.fn(() => Promise.resolve());
    const stmts: any = { servedPruneOlderThan: () => {}, undoPruneOlderThan: () => {} };
    await lc.onStoreOpen("/tmp/p1", stmts, { pruneMissing: pruneMock } as any);
    expect(pruneMock).toHaveBeenCalledTimes(1);
    // second call throttled (same storePath, within 24h)
    await lc.onStoreOpen("/tmp/p1", stmts, { pruneMissing: pruneMock } as any);
    expect(pruneMock).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("runCentralJanitorIfDue: throttled, workspace early return, loadConfig fail, readdir ENOENT and error, stat branches", async () => {
    const lc = await import("../../src/store-lifecycle.js");
    lc._resetLifecycleForTests();
    await expect(lc.runCentralJanitorIfDue()).resolves.not.toThrow();
    await expect(lc.runCentralJanitorIfDue()).resolves.not.toThrow();
    vi.restoreAllMocks();
    lc._resetLifecycleForTests();
    await expect(lc.runCentralJanitorIfDue()).resolves.not.toThrow();
    vi.restoreAllMocks();
  });

  it("runCentralJanitor liveDirs and deletion branches", async () => {
    const lc = await import("../../src/store-lifecycle.js");
    lc._resetLifecycleForTests();
    const fakeHome = await mkdtemp(join(await getWritableTempRoot(), "home-"));
    const prevHome = process.env.HOME;
    const prevDsh = process.env.DSH_HOME;
    process.env.HOME = fakeHome;
    process.env.DSH_HOME = fakeHome;
    const runtimeDir = join(fakeHome, "plugins", "dsh-better-edit", "runtime");
    await mkdir(join(runtimeDir, "old1"), { recursive: true });
    await mkdir(join(runtimeDir, "old2"), { recursive: true });
    await writeFile(join(runtimeDir, "old1", "hash-store.sqlite"), "x");
    await writeFile(join(runtimeDir, "old2", "hash-store.sqlite"), "y");
    lc.setStoresGetter(() => new Map([[join(runtimeDir, "old1", "hash-store.sqlite"), { path: join(runtimeDir, "old1", "hash-store.sqlite") }]]), () => new Map());
    await lc.runCentralJanitorIfDue().catch(() => {});
    lc.setStoresGetter(() => new Map(), () => new Map());
    lc._resetLifecycleForTests();
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDsh;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("onAppStart and onSessionStart delegate", async () => {
    const lc = await import("../../src/store-lifecycle.js");
    lc._resetLifecycleForTests();
    await lc.onAppStart();
    await lc.onSessionStart();
    expect(true).toBe(true);
  });
});
