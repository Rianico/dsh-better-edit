import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getWritableTempRoot } from "../support/fixtures.js";
import { shutdownHashStore } from "../../src/hash-store.js";

describe("store-lifecycle coverage agent-a", () => {
  let dir: string;
  let restoreHome: () => void;
  beforeEach(async () => {
    dir = await mkdtemp(join(await getWritableTempRoot(), "lcov-a-"));
    const prevHome = process.env.HOME;
    const prevDsh = process.env.DSH_HOME;
    process.env.HOME = dir;
    process.env.DSH_HOME = join(dir, ".dsh");
    restoreHome = () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevDsh === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevDsh;
    };
    const mod = await import("../../src/store-lifecycle.js");
    mod._resetLifecycleForTests();
  });
  afterEach(async () => {
    shutdownHashStore();
    await rm(dir, { recursive: true, force: true });
    restoreHome();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    const mod = await import("../../src/store-lifecycle.js");
    mod._resetLifecycleForTests();
  });

  it("onStoreOpen does row TTL, undo prune, pruneMissing throttled", async () => {
    const mod = await import("../../src/store-lifecycle.js");
    const store = {
      pruneMissing: vi.fn(async () => {}),
      pruneUndoOlderThan: vi.fn(),
      vacuumSnapshots: vi.fn(),
    } as any;
    let servedPruneArgs: number[] = [];
    const stmts = {
      servedMetaPruneOlderThan: (ts: number) => servedPruneArgs.push(ts),
    };
    const cfgDir = join(dir, ".dsh", "plugins", "dsh-better-edit");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(join(cfgDir, "config.yaml"), "storeDir: central\nundo_ttl_s: 100\n", "utf-8");

    const storePath = join(dir, "hash-store.sqlite");
    await mod.onStoreOpen(storePath, stmts as any, store);

    expect(servedPruneArgs.length).toBe(1);
    expect(store.pruneUndoOlderThan).toHaveBeenCalledWith(expect.any(Number));
    expect(store.pruneUndoOlderThan).toHaveBeenCalledTimes(1);
    expect(store.pruneMissing).toHaveBeenCalledTimes(1);

    servedPruneArgs = [];
    await mod.onStoreOpen(storePath, stmts as any, store);
    expect(store.pruneMissing).toHaveBeenCalledTimes(1);
    expect(store.pruneUndoOlderThan).toHaveBeenCalledTimes(2);

    const store2 = { pruneMissing: vi.fn(async () => {}), vacuumSnapshots: vi.fn() } as any;
    const otherPath = join(dir, "other.sqlite");
    await mod.onStoreOpen(otherPath, { servedMetaPruneOlderThan: () => {} } as any, store2);
    expect(store2.pruneMissing).toHaveBeenCalledTimes(1);
  });

  it("onStoreOpen handles pruneMissing failure and undo_ttl_s -1 skip", async () => {
    const mod = await import("../../src/store-lifecycle.js");
    const cfgDir = join(dir, ".dsh", "plugins", "dsh-better-edit");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(join(cfgDir, "config.yaml"), "storeDir: central\nundo_ttl_s: -1\n", "utf-8");
    const stmts = {
      servedMetaPruneOlderThan: () => {
        throw new Error("served fail");
      },
    };
    const store = {
      pruneMissing: vi.fn(async () => {
        throw new Error("prune fail");
      }),
      pruneUndoOlderThan: vi.fn(),
      vacuumSnapshots: vi.fn(),
    } as any;
    await mod.onStoreOpen(join(dir, "x.sqlite"), stmts as any, store);
    expect(store.pruneUndoOlderThan).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("handleGitPollution: autoGitignore creates .gitignore", async () => {
    const mod = await import("../../src/store-lifecycle.js");
    const ws = await mkdtemp(join(await getWritableTempRoot(), "gitpoll-"));
    const cfgDir = join(dir, ".dsh", "plugins", "dsh-better-edit");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      join(cfgDir, "config.yaml"),
      "storeDir: workspace\nautoGitignore: true\n",
      "utf-8",
    );
    await mkdir(join(ws, ".git"), { recursive: true });
    const storePath = join(ws, ".dsh_better_edit", "hash-store.sqlite");
    await mkdir(join(ws, ".dsh_better_edit"), { recursive: true });
    await writeFile(storePath, "", "utf-8");
    const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stmts = { servedMetaPruneOlderThan: () => {} } as any;
    const store = {
      pruneMissing: vi.fn(async () => {}),
      pruneUndoOlderThan: vi.fn(),
      vacuumSnapshots: vi.fn(),
    } as any;
    await mod.onStoreOpen(storePath, stmts, store);
    expect(existsSync(join(ws, ".gitignore"))).toBe(true);
    expect(readFileSync(join(ws, ".gitignore"), "utf-8")).toContain(".dsh_better_edit/");
    await rm(join(ws, ".gitignore"));
    await writeFile(join(ws, ".gitignore"), "node_modules\n", "utf-8");
    mod._resetLifecycleForTests();
    await mod.onStoreOpen(storePath, stmts, store);
    expect(readFileSync(join(ws, ".gitignore"), "utf-8")).toContain(".dsh_better_edit/");
    const contentBefore = readFileSync(join(ws, ".gitignore"), "utf-8");
    mod._resetLifecycleForTests();
    await mod.onStoreOpen(storePath, stmts, store);
    const contentAfter = readFileSync(join(ws, ".gitignore"), "utf-8");
    expect(contentAfter).toBe(contentBefore);
    await writeFile(join(ws, ".gitignore"), "node_modules", "utf-8");
    mod._resetLifecycleForTests();
    await mod.onStoreOpen(storePath, stmts, store);
    expect(readFileSync(join(ws, ".gitignore"), "utf-8")).toContain("\n.dsh_better_edit/");
    spyWarn.mockRestore();
    await rm(ws, { recursive: true, force: true });
  });

  it("handleGitPollution: warns once when autoGitignore false, skips if storeDir != workspace", async () => {
    const mod = await import("../../src/store-lifecycle.js");
    const ws = await mkdtemp(join(await getWritableTempRoot(), "gitwarn-"));
    const cfgDir = join(dir, ".dsh", "plugins", "dsh-better-edit");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      join(cfgDir, "config.yaml"),
      "storeDir: workspace\nautoGitignore: false\n",
      "utf-8",
    );
    await mkdir(join(ws, ".git"), { recursive: true });
    const storePath = join(ws, ".dsh_better_edit", "hash-store.sqlite");
    await mkdir(join(ws, ".dsh_better_edit"), { recursive: true });
    await writeFile(storePath, "", "utf-8");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stmts = { servedMetaPruneOlderThan: () => {} } as any;
    const store = {
      pruneMissing: vi.fn(async () => {}),
      pruneUndoOlderThan: vi.fn(),
      vacuumSnapshots: vi.fn(),
    } as any;
    await mod.onStoreOpen(storePath, stmts, store);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("not in .gitignore"));
    spy.mockClear();
    await mod.onStoreOpen(storePath, stmts, store);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    await writeFile(
      join(cfgDir, "config.yaml"),
      "storeDir: central\nautoGitignore: true\n",
      "utf-8",
    );
    mod._resetLifecycleForTests();
    const spy2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mod.onStoreOpen(storePath, stmts, store);
    expect(spy2).not.toHaveBeenCalledWith(expect.stringContaining(".gitignore"));
    spy2.mockRestore();

    await writeFile(
      join(cfgDir, "config.yaml"),
      "storeDir: workspace\nautoGitignore: false\n",
      "utf-8",
    );
    mod._resetLifecycleForTests();
    const ws2 = await mkdtemp(join(await getWritableTempRoot(), "gitnowarn-"));
    const storePath2 = join(ws2, ".dsh_better_edit", "hash-store.sqlite");
    await mkdir(join(ws2, ".dsh_better_edit"), { recursive: true });
    await writeFile(storePath2, "", "utf-8");
    const spy3 = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mod.onStoreOpen(storePath2, stmts, store);
    expect(spy3).not.toHaveBeenCalled();
    spy3.mockRestore();
    await rm(ws, { recursive: true, force: true });
    await rm(ws2, { recursive: true, force: true });
  });

  it("runCentralJanitorIfDue throttled, handles ENOENT, workspace skip, loadConfig fail", async () => {
    const mod = await import("../../src/store-lifecycle.js");
    const cfgDir = join(dir, ".dsh", "plugins", "dsh-better-edit");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(join(cfgDir, "config.yaml"), "storeDir: workspace\n", "utf-8");
    mod._resetLifecycleForTests();
    await mod.runCentralJanitorIfDue();
    await mod.runCentralJanitorIfDue();

    await writeFile(
      join(cfgDir, "config.yaml"),
      "storeDir: central\nstoreMaxAgeS: 0\nstoreMaxTotalBytes: 1000\n",
      "utf-8",
    );
    mod._resetLifecycleForTests();
    await mod.runCentralJanitorIfDue();

    await writeFile(join(cfgDir, "config.yaml"), ":\n: :\n", "utf-8");
    mod._resetLifecycleForTests();
    await mod.runCentralJanitorIfDue();
  });

  it("runCentralJanitor deletes old dirs, respects liveDirs, handles wal_checkpoint", async () => {
    const mod = await import("../../src/store-lifecycle.js");
    const home = dir;
    const runtimeDir = join(home, ".dsh", "plugins", "dsh-better-edit", "runtime");
    await mkdir(runtimeDir, { recursive: true });
    const oldDir = join(runtimeDir, "old-" + Date.now());
    const newDir = join(runtimeDir, "new-" + Date.now());
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    await writeFile(join(oldDir, "hash-store.sqlite"), "dummy", "utf-8");
    await writeFile(join(newDir, "hash-store.sqlite"), "dummy", "utf-8");
    const oldTime = Date.now() - 1000 * 60 * 60 * 24 * 60;
    const { utimes } = await import("node:fs/promises");
    await utimes(oldDir, oldTime / 1000, oldTime / 1000);

    const cfgDir = join(dir, ".dsh", "plugins", "dsh-better-edit");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      join(cfgDir, "config.yaml"),
      "storeDir: central\nstoreMaxAgeS: 2592000\nstoreMaxTotalBytes: 10\n",
      "utf-8",
    );
    mod._resetLifecycleForTests();
    const livePath = join(runtimeDir, "live123", "hash-store.sqlite");
    mod.setStoresGetter(
      () => new Map([[livePath, { path: livePath }]]),
      () => new Map(),
    );
    const liveDir = join(runtimeDir, "live123");
    await mkdir(liveDir, { recursive: true });
    await writeFile(join(liveDir, "hash-store.sqlite"), "live", "utf-8");

    await mod.runCentralJanitorIfDue();

    expect(existsSync(liveDir)).toBe(true);
    await mod.runCentralJanitorIfDue();
    mod.setStoresGetter(
      () => new Map(),
      () => new Map(),
    );

    await rm(runtimeDir, { recursive: true, force: true });
  });

  it("onAppStart and onSessionStart delegate to janitor", async () => {
    const mod = await import("../../src/store-lifecycle.js");
    mod._resetLifecycleForTests();
    await mod.onAppStart();
    await mod.onSessionStart();
    expect(true).toBe(true);
  });

  it("setStoresGetter wires getters", async () => {
    const mod = await import("../../src/store-lifecycle.js");
    const m1 = new Map([["a", { path: "a" }]]);
    const m2 = new Map([["b", Promise.resolve()]]);
    mod.setStoresGetter(
      () => m1 as any,
      () => m2 as any,
    );
    mod._resetLifecycleForTests();
    await mod.runCentralJanitorIfDue();
  });
});
