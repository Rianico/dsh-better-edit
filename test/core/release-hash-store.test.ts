/**
 * `releaseHashStore` + the root dispose hook: the HOST's escape hatch and the plugin's teardown.
 *
 * These cases exercise PRODUCTION bindings: `src/hash-store.ts` binds the lifecycle hooks once at
 * module load, so this file never calls `configureStoreLifecycle` or `_resetForTests` — doing so
 * would unbind the behaviour under test. Every case drives a real temp workspace and a real sqlite
 * handle; nothing here stubs the store.
 *
 * `releaseHashStore` is imported from the package ENTRY (`src/index.ts`) on purpose: the host-facing
 * export is what this file pins, not an internal module path.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { loadHashStore, shutdownHashStore, type HashStore } from "../../src/hash-store.js";
import { apply, releaseHashStore } from "../../src/index.js";
import {
  agentPathCount,
  attachStore,
  detachAgent,
  inFlightCount,
  ownerCount,
} from "../../src/store-lifecycle-slot.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { getWritableTempRoot } from "../support/fixtures.js";

/**
 * Liveness of the connection a store actually holds. The public `HashStore` surface exposes no
 * handle, and a closed `node:sqlite` connection finalizes its prepared statements — so a read that
 * must otherwise succeed is the honest probe: it returns on a live handle and throws
 * `ERR_INVALID_STATE` once the handle closed.
 */
function handleIsOpen(store: HashStore): boolean {
  try {
    store.getSnapshot("/__liveness-probe__.ts", "probe\n");
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_INVALID_STATE") return false;
    throw error;
  }
}

/** Two microtask ticks: enough for a `finally`-scheduled prune and a `.catch` to run. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
}

/**
 * Waits, microtask by microtask, until the load issued just before holds its scope. The scope is
 * entered synchronously once the drain gate ahead of it resolves, so no timer is needed — and none
 * is used, because a sleep would make the race this helper stages a matter of luck. (Copied from
 * `test/core/hash-store-lifecycle-wiring.test.ts`.)
 */
async function waitForOpenScope(storePath: string): Promise<void> {
  for (let i = 0; i < 10_000; i += 1) {
    if (inFlightCount(storePath) > 0) return;
    await Promise.resolve();
  }
  throw new Error("open scope never started");
}

/**
 * Drain the microtask queue. The effect disposer returns nothing (`void releaseHashStore(...)`), so
 * the release chain settles a few microtask hops after the disposer returns. Those hops are the
 * whole wait — an idle close is synchronous — so a fixed drain is deterministic, not lucky.
 */
async function drainMicrotasks(ticks = 32): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

/** Yield microtasks until `check` holds, then stop: the dispose chain never needs a timer. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 10_000; i += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error(`never observed: ${what}`);
}

/** The minimal root-scoped host `apply` touches: a logger, an event channel, and a fiber effect. */
interface StubHost {
  rootCtx: {
    logger: { warn(message: string): void; error(message: string): void };
    get(service: string): unknown;
    fs: { sandboxMode: undefined };
    systemPrompt: { getSectionOrder(): number };
    on(event: string, handler: (payload: unknown) => void): () => void;
    effect(execute: () => unknown): () => void;
  };
  rootListeners: Map<string, (payload: unknown) => void>;
  warnings: string[];
  effects: Array<() => unknown>;
  /** Run every effect disposer, as Cordis does when the plugin fiber unloads. */
  disposeRoot(): Promise<void>;
}

/**
 * Stub host modelled on the DSH named-entry registry (copied from
 * `test/core/agent-store-lifecycle.test.ts`). Deliberately minimal: the dispose hook under test
 * reads only `logger`, `on` and `effect`, and the agent layer is never driven here.
 *
 * `effect` mirrors Cordis: `execute` runs IMMEDIATELY and the disposer it returns is what runs on
 * unload. Nothing else about `apply` is unloaded — Cordis 4.0.5 treats a function plugin as a
 * constructor (`new apply(...)`) and DISCARDS its return value.
 */
function createStubHost(): StubHost {
  const warnings: string[] = [];
  const effects: Array<() => unknown> = [];
  const rootListeners = new Map<string, (payload: unknown) => void>();
  const rootCtx = {
    logger: {
      warn(message: string) {
        warnings.push(message);
      },
      error(message: string) {
        warnings.push(message);
      },
    },
    get(_service: string) {
      return undefined;
    },
    fs: { sandboxMode: undefined as undefined },
    systemPrompt: { getSectionOrder: () => 1000 },
    on(event: string, handler: (payload: unknown) => void) {
      rootListeners.set(event, handler);
      return () => {
        rootListeners.delete(event);
      };
    },
    effect(execute: () => unknown) {
      const dispose = execute();
      if (typeof dispose === "function") effects.push(dispose as () => unknown);
      return () => {};
    },
  };

  return {
    rootCtx,
    rootListeners,
    warnings,
    effects,
    async disposeRoot() {
      // Unload runs each disposer once; awaiting one waits the release promise it returns, if any.
      const disposers = effects.splice(0).reverse();
      for (const dispose of disposers) await dispose();
    },
  };
}

/** Mount the root plugin. Its disposer is NOT a return value: Cordis 4.0.5 discards that. */
function mountRoot(host: StubHost): void {
  expect(apply(host.rootCtx as never)).toBeUndefined();
  expect(host.effects).toHaveLength(1);
}

describe("releaseHashStore — host release + root dispose", () => {
  let home: string;
  let workspace: string;
  const attached: string[] = [];

  beforeAll(async () => {
    await initHasher();
  });

  beforeEach(async () => {
    home = await mkdtemp(join(await getWritableTempRoot(), "dsh-release-store-"));
    workspace = await workspaceAt("workspace");
    vi.stubEnv("HOME", home);
    vi.stubEnv("DSH_HOME", join(home, ".dsh"));
    vi.stubEnv("XDG_CONFIG_HOME", "");
  });

  afterEach(async () => {
    // A spy on `DatabaseSync.prototype.close` must never outlive its case: the cleanup below has
    // to run real closes.
    vi.restoreAllMocks();
    // Owners first: a detach is what drives the close, so it must run before the close-all.
    for (const token of attached.splice(0)) await detachAgent(token);
    shutdownHashStore();
    vi.unstubAllEnvs();
    _resetConfigCache();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });

  async function workspaceAt(name: string): Promise<string> {
    const dir = join(home, name);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  function attach(storePath: string, token: string): void {
    attachStore(storePath, token);
    attached.push(token);
  }

  it("A. graceful release with a cwd refuses an owned path", async () => {
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);
    attach(storePath, "agent-owned");

    await expect(releaseHashStore(workspace)).resolves.toBe(false);

    // Refused, not half-released: the handle is live and the claim is intact.
    expect(handleIsOpen(store)).toBe(true);
    expect(ownerCount(storePath)).toBe(1);

    const detached = detachAgent("agent-owned");
    // The detach owns the close, and it runs synchronously inside that call.
    expect(handleIsOpen(store)).toBe(false);
    await detached;
  });

  it("B. graceful release with a cwd closes a token-unowned bare open", async () => {
    const store = await loadHashStore(workspace);

    await expect(releaseHashStore(workspace)).resolves.toBe(true);
    expect(handleIsOpen(store)).toBe(false);

    // The cached entry went with the close, so this is a fresh open, not the dead handle.
    const reopened = await loadHashStore(workspace);
    expect(reopened).not.toBe(store);
    expect(handleIsOpen(reopened)).toBe(true);
  });

  it("C. force release with a cwd clears owners and closes", async () => {
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);
    attach(storePath, "agent-1");
    attach(storePath, "agent-2");
    expect(ownerCount(storePath)).toBe(2);

    await expect(releaseHashStore(workspace, { force: true })).resolves.toBe(true);

    expect(ownerCount(storePath)).toBe(0);
    expect(agentPathCount("agent-1")).toBe(0);
    expect(agentPathCount("agent-2")).toBe(0);
    expect(handleIsOpen(store)).toBe(false);
  });

  it("D. no-arg release closes every open path, including bare opens", async () => {
    const second = await workspaceAt("workspace-b");
    const third = await workspaceAt("workspace-c");
    const storeA = await loadHashStore(workspace);
    const storeB = await loadHashStore(second);
    const storeC = await loadHashStore(third);
    attach(hashStorePath(third), "agent-c");

    await expect(releaseHashStore(undefined, { force: true })).resolves.toBe(true);

    expect(handleIsOpen(storeA)).toBe(false);
    expect(handleIsOpen(storeB)).toBe(false);
    expect(handleIsOpen(storeC)).toBe(false);
    // The forced release dropped the claim with the handle.
    expect(agentPathCount("agent-c")).toBe(0);
  });

  it("E. no-arg graceful release closes the bare opens and reports false for the owned path", async () => {
    const second = await workspaceAt("workspace-b");
    const third = await workspaceAt("workspace-c");
    const storeA = await loadHashStore(workspace);
    const storeB = await loadHashStore(second);
    const storeC = await loadHashStore(third);
    const pathC = hashStorePath(third);
    attach(pathC, "agent-c");

    await expect(releaseHashStore(undefined)).resolves.toBe(false);

    expect(handleIsOpen(storeA)).toBe(false);
    expect(handleIsOpen(storeB)).toBe(false);
    // The refused path is untouched; its owner still holds it.
    expect(handleIsOpen(storeC)).toBe(true);
    expect(ownerCount(pathC)).toBe(1);
  });

  it("F. root dispose force-closes every remaining store, contained", async () => {
    const host = createStubHost();
    mountRoot(host);

    const bare = await loadHashStore(workspace);
    const ownedWorkspace = await workspaceAt("workspace-owned");
    const owned = await loadHashStore(ownedWorkspace);
    attach(hashStorePath(ownedWorkspace), "host-owned");

    const pending = host.disposeRoot();
    // The idle fast path runs inside the call: no await has happened yet, so both handles are
    // already closed here. A disposer that waited on a timer would fail this pair.
    expect(handleIsOpen(bare)).toBe(false);
    expect(handleIsOpen(owned)).toBe(false);
    await pending;
    // The disposer returns nothing (`void release…`), so the chain finishes a few hops later.
    await drainMicrotasks();
    expect(host.warnings.filter((message) => message.includes("plugin dispose"))).toEqual([]);

    // A second dispose has nothing left to release: it resolves and changes nothing.
    await expect(host.disposeRoot()).resolves.toBeUndefined();
    await drainMicrotasks();
    expect(host.warnings.filter((message) => message.includes("plugin dispose"))).toEqual([]);
    await flushMicrotasks();
  });

  it("G. root dispose contains a throwing close and warns", async () => {
    const host = createStubHost();
    mountRoot(host);
    const first = await loadHashStore(workspace);
    const otherWorkspace = await workspaceAt("workspace-other");
    const other = await loadHashStore(otherWorkspace);

    // Installed with no await in between, so the first close this consumes is the dispose's own
    // (open entries are visited in insertion order: `first`, then `other`).
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => {
      throw new Error("close exploded in dispose");
    });

    const pending = host.disposeRoot();
    // The root dispose promise never rejects: the failure is contained per path and reported false.
    await expect(pending).resolves.toBeUndefined();
    closeSpy.mockRestore();

    // The failed path kept its entry, so its handle is still live and still closeable; the rest
    // closed anyway.
    expect(handleIsOpen(first)).toBe(true);
    expect(handleIsOpen(other)).toBe(false);
    await until(
      () =>
        host.warnings.some((message) =>
          message.includes("plugin dispose left a store path unreleased"),
        ),
      "the plugin dispose warning",
    );
    await flushMicrotasks();
  });

  it("H. a release that races an open fails the load instead of resurrecting the handle", async () => {
    const storePath = hashStorePath(workspace);
    const pending = loadHashStore(workspace);
    // Stage the overlap deterministically: the release lands while the open still holds its scope.
    await waitForOpenScope(storePath);

    const released = releaseHashStore(workspace, { force: true });
    // The refusal is the pin: the load fails rather than reopening the handle the release closed.
    await expect(pending).rejects.toThrow(/released while the store was opening/i);
    await expect(released).resolves.toBe(true);

    // No handle survived the release: a later load is a fresh open, and it is live.
    const reopened = await loadHashStore(workspace);
    expect(handleIsOpen(reopened)).toBe(true);
  });

  it("J. a refused graceful release does not poison an overlapping load", async () => {
    const storePath = hashStorePath(workspace);
    const pending = loadHashStore(workspace);
    await waitForOpenScope(storePath);
    attach(storePath, "keeper");
    // Refused: no close, no epoch bump.
    await expect(releaseHashStore(workspace)).resolves.toBe(false);

    const detached = detachAgent("keeper"); // this drain closes the handle at the open scope's end
    const store = await pending; // the loader must REOPEN, not throw
    expect(handleIsOpen(store)).toBe(true);
    await detached;
  });

  it("K. detach never bumps the release epoch", async () => {
    const storePath = hashStorePath(workspace);
    const pending = loadHashStore(workspace);
    await waitForOpenScope(storePath);
    attach(storePath, "only");

    const detached = detachAgent("only");
    const store = await pending;
    expect(handleIsOpen(store)).toBe(true);
    await detached;
  });

  it("L. a throw on the dispose chain is caught and warned", async () => {
    const host = createStubHost();
    let throwOnce = true;
    const originalWarn = host.rootCtx.logger.warn;
    host.rootCtx.logger.warn = (message: string) => {
      if (throwOnce && message.includes("plugin dispose left a store path unreleased")) {
        throwOnce = false;
        throw new Error("warn exploded");
      }
      originalWarn(message);
    };
    mountRoot(host);
    await loadHashStore(workspace);

    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => {
      throw new Error("close exploded"); // forces released === false → the .then warning throws
    });
    host.disposeRoot();
    closeSpy.mockRestore();

    await until(
      () => host.warnings.some((message) => message.includes("plugin dispose failed")),
      "the plugin dispose failure warning",
    );
    await flushMicrotasks();
  });
});
