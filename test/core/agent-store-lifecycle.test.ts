/**
 * Agent-store wiring: per-call attach + scope, and the agent's teardown-time detach.
 *
 * These cases exercise PRODUCTION bindings: `src/hash-store.ts` binds the lifecycle hooks once at
 * module load, so this file never calls `configureStoreLifecycle` or `_resetForTests` — doing so
 * would unbind the behaviour under test. Every case drives a REAL tool definition over a real
 * temp workspace and a real sqlite handle; nothing here asserts on the wrapper in isolation.
 *
 * Timing is explicit, never incidental: the claim under test is that a 1 → 0 close runs
 * SYNCHRONOUSLY inside the detach call (no timer, no microtask), so each such step is asserted
 * before the first `await`. The one exception is the slot-count probe, which the registry prunes
 * in the detach's own `finally` — one microtask out — and is asserted there.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { wrapToolWithAgentStore } from "../../src/agent-store.js";
import { loadHashStore, shutdownHashStore, type HashStore } from "../../src/hash-store.js";
import { apply } from "../../src/index.js";
import {
  _slotCountForTests,
  agentPathCount,
  attachStore,
  detachAgent,
  isDraining,
  ownerCount,
} from "../../src/store-lifecycle-slot.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { localIO } from "../../src/fs-bridge.js";
import { buildReadTool } from "../../src/tool-read.js";
import { buildEditTool } from "../../src/tool-edit.js";
import { registerWriteHook } from "../../src/write-hook.js";
import { execCwd } from "../../src/workspace-context.js";
import {
  getText,
  getWritableTempRoot,
  makeExec,
  makeTestSandbox,
  setupIntegrationTest,
} from "../support/fixtures.js";

/**
 * Liveness of the connection a store actually holds. The public `HashStore` surface exposes no
 * handle, and a closed `node:sqlite` connection finalizes its prepared statements — so a read
 * that must otherwise succeed is the honest probe: it returns on a live handle and throws
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

/** Two microtask ticks: enough for the detach's `finally` (the prune) and a `.catch` to run. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
}

type MakeExec = (args: unknown) => ToolExecution;

/** Run one real tool body the way the registry does: parsed args plus the execution context. */
async function callTool(
  tool: { execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> },
  args: unknown,
  exec: MakeExec,
): Promise<unknown> {
  return tool.execute(args, exec(args) as unknown as ToolRunContext);
}

/** The minimal agent-scoped host the install needs: a layer, a register, an effect, a logger. */
interface StubHost {
  rootCtx: {
    logger: { warn(message: string): void; error(message: string): void };
    get(service: string): unknown;
    fs: { sandboxMode: undefined };
    systemPrompt: { getSectionOrder(): number };
    on(event: string, handler: (payload: unknown) => void): () => void;
  };
  agent: { id: string; ctx?: unknown };
  /** The agent-scoped tool layer `installAgentTools` registered into (`layer.get(name)`). */
  layer: { get(name: string): unknown };
  rootListeners: Map<string, (payload: unknown) => void>;
  warnings: string[];
  /** Run the effect cleanups Cordis runs when the agent is disposed. */
  disposeAgent(): void;
}

/**
 * Stub host modelled on the DSH named-entry registry: one agent-scoped layer whose register
 * throws on a duplicate name, plus the optional services read through `ctx.get`. Deliberately
 * minimal — this case only needs the install to reach its `agent.ctx.effect` teardown.
 */
function createStubHost(agentId: string): StubHost {
  const layerData = new Map<string, unknown>();
  const layer = {
    get: (name: string) => layerData.get(name),
    data: layerData,
  };
  const agent: { id: string; ctx?: unknown } = { id: agentId };
  const scoped = new Map<unknown, { tools: typeof layer }>([[agent, { tools: layer }]]);
  const toolsSvc = {
    get: (name: string, scope?: unknown) => (scope === undefined ? layer.get(name) : undefined),
    layers: { scoped },
  };
  const cleanups: Array<() => void> = [];
  const agentCtx = {
    tools: {
      register(def: { name: string }) {
        if (layerData.has(def.name)) {
          throw new Error(`tool "${def.name}" is already registered in this scope`);
        }
        layerData.set(def.name, def);
        return () => {
          layerData.delete(def.name);
        };
      },
    },
    systemPrompt: {
      section() {
        return () => {};
      },
    },
    on() {
      return () => {};
    },
    effect(fn: () => unknown) {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup as () => void);
      return () => {};
    },
  };
  agent.ctx = agentCtx;

  const warnings: string[] = [];
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
    get(service: string) {
      if (service === "tools") return toolsSvc;
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
  };

  return {
    rootCtx,
    agent,
    layer,
    rootListeners,
    warnings,
    disposeAgent() {
      for (const run of cleanups) run();
    },
  };
}

/** Mount the plugin on the stub host exactly as the harness does. */
function mount(host: StubHost): void {
  apply(host.rootCtx as never);
  const listener = host.rootListeners.get("agent/created");
  if (listener === undefined) {
    throw new Error("apply() did not register the agent/created listener");
  }
  listener({ agent: host.agent });
}
describe("agent-store — attach, scope and teardown wiring", () => {
  let home: string;
  let workspace: string;
  const usedTokens: string[] = [];

  beforeAll(async () => {
    await initHasher();
  });

  beforeEach(async () => {
    home = await mkdtemp(join(await getWritableTempRoot(), "dsh-agent-store-"));
    workspace = join(home, "workspace");
    await mkdir(workspace, { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("DSH_HOME", join(home, ".dsh"));
    vi.stubEnv("XDG_CONFIG_HOME", "");
  });

  afterEach(async () => {
    // A spy on `DatabaseSync.prototype.close` must never outlive its case: the cleanup below has
    // to run real closes.
    vi.restoreAllMocks();
    // Owners first: a detach is what drives the close, so it must run before the close-all.
    for (const token of usedTokens.splice(0)) await detachAgent(token);
    shutdownHashStore();
    vi.unstubAllEnvs();
    _resetConfigCache();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });

  /** Record a token the case attached, so the teardown releases whatever the case left. */
  function useToken(token: string): string {
    usedTokens.push(token);
    return token;
  }

  it("A. one agent, one workspace: repeated calls attach idempotently", async () => {
    await writeFile(join(workspace, "a.txt"), "alpha\nbeta\n", "utf-8");
    const token = useToken("agent-1");
    const readTool = wrapToolWithAgentStore(buildReadTool(localIO()));
    const exec = makeExec(workspace, token);

    // Two real calls through the decorated definition: the wrapper is what claims the store.
    await callTool(readTool, { path: "a.txt" }, exec);
    await callTool(readTool, { path: "a.txt" }, exec);

    const storePath = hashStorePath(workspace);
    expect(ownerCount(storePath)).toBe(1);
    expect(agentPathCount(token)).toBe(1);

    // The store those calls used is live: the claim is what kept it open, so nothing closed it.
    const store = await loadHashStore(workspace);
    expect(handleIsOpen(store)).toBe(true);
  });

  it("B. one agent across two workspaces claims both, and one detach closes both", async () => {
    const workspaceB = join(home, "workspace-b");
    await mkdir(workspaceB, { recursive: true });
    await writeFile(join(workspace, "b.txt"), "alpha\n", "utf-8");
    await writeFile(join(workspaceB, "b.txt"), "beta\n", "utf-8");
    const token = useToken("mover");
    const readTool = wrapToolWithAgentStore(buildReadTool(localIO()));

    await callTool(readTool, { path: "b.txt" }, makeExec(workspace, token));
    await callTool(readTool, { path: "b.txt" }, makeExec(workspaceB, token));

    const pathA = hashStorePath(workspace);
    const pathB = hashStorePath(workspaceB);
    expect(agentPathCount(token)).toBe(2);
    expect(ownerCount(pathA)).toBe(1);
    expect(ownerCount(pathB)).toBe(1);

    const storeA = await loadHashStore(workspace);
    const storeB = await loadHashStore(workspaceB);

    const detached = detachAgent(token);
    // Every path is detached before the detach's first await, so both closes already ran.
    expect(handleIsOpen(storeA)).toBe(false);
    expect(handleIsOpen(storeB)).toBe(false);
    await detached;
    expect(agentPathCount(token)).toBe(0);
  });

  it("C. two agents sharing a workspace: the last detach closes the handle", async () => {
    await writeFile(join(workspace, "c.txt"), "gamma\n", "utf-8");
    const first = useToken("a");
    const second = useToken("b");
    const readTool = wrapToolWithAgentStore(buildReadTool(localIO()));

    await callTool(readTool, { path: "c.txt" }, makeExec(workspace, first));
    await callTool(readTool, { path: "c.txt" }, makeExec(workspace, second));

    const storePath = hashStorePath(workspace);
    expect(ownerCount(storePath)).toBe(2);
    const store = await loadHashStore(workspace);

    await detachAgent(first);
    expect(ownerCount(storePath)).toBe(1);
    expect(handleIsOpen(store)).toBe(true);

    const detached = detachAgent(second);
    // The last owner's drain closed the handle synchronously, inside this call.
    expect(handleIsOpen(store)).toBe(false);
    await detached;
  });

  it("D. an in-flight call defers the close to the end of its own body", async () => {
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);
    const token = useToken("busy");

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let probed: string[] | undefined;

    // A fake body is enough for the scope claim: the wrapper's jail is around `execute`, and the
    // store read after the gate is the honest victim a premature close would break.
    const fake = wrapToolWithAgentStore({
      async execute(_args: never, exec: ToolRunContext) {
        const scoped = await loadHashStore(execCwd(exec));
        markStarted();
        await gate;
        // Runs AFTER the detach was issued, still inside this call's scope.
        probed = scoped.getSnapshot("/__in-flight-probe__.ts", "probe\n");
        return "ok";
      },
    });

    const running = fake.execute({} as never, makeExec(workspace, token)({}) as never);
    await started;
    // The attach happened synchronously; the body now holds the path's in-flight scope.
    expect(ownerCount(storePath)).toBe(1);

    const detached = detachAgent(token);
    expect(isDraining(storePath)).toBe(true);
    expect(handleIsOpen(store)).toBe(true);

    releaseGate();
    await expect(running).resolves.toBe("ok");
    // The body's read landed on a live handle: a wrapper without the scope fails here instead.
    expect(probed).toBeUndefined();
    await detached;

    expect(isDraining(storePath)).toBe(false);
    expect(handleIsOpen(store)).toBe(false);
  });

  it("E. the agent teardown closes an idle store before its disposer returns", async () => {
    const host = createStubHost("agent-teardown");
    const token = useToken(host.agent.id);
    mount(host);

    // The registered `read` is the definition `src/index.ts` decorates, not a look-alike: running
    // it is what proves the install wraps the def it registered and the teardown detaches the
    // SAME token the wrapper attached.
    const registered = host.layer.get("read") as {
      execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>;
    };
    expect(registered).toBeDefined();
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);

    // The body fails (the stub fs serves nothing); the attach and its scope still ran, which is
    // exactly what this case pins.
    await registered
      .execute({ path: "missing.txt" }, makeExec(workspace, host.agent.id)({}) as never)
      .catch(() => undefined);
    expect(ownerCount(storePath)).toBe(1);
    expect(agentPathCount(token)).toBe(1);

    // Delta, not an absolute: the slot the read left is pruned in its scope's `finally`, and the
    // attach above puts one slot back.
    const slotsBeforeDispose = _slotCountForTests();
    host.disposeAgent();

    // No await, no timer: the 1 → 0 close already ran inside detachAgent.
    expect(handleIsOpen(store)).toBe(false);
    expect(ownerCount(storePath)).toBe(0);
    // The registry prunes the idle slot in the detach's own `finally`, one microtask out.
    expect(_slotCountForTests()).toBe(slotsBeforeDispose);
    await flushMicrotasks();
    expect(_slotCountForTests()).toBe(slotsBeforeDispose - 1);
    // A close that throws must not escape the teardown, and it is reported, not swallowed.
    const reopened = await loadHashStore(workspace);
    attachStore(storePath, token);
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => {
      throw new Error("close exploded in teardown");
    });

    expect(() => host.disposeAgent()).not.toThrow();
    closeSpy.mockRestore();
    await flushMicrotasks();

    expect(host.warnings.some((m) => m.includes("store detach failed"))).toBe(true);
    // The failed close left the handle retryable, so the next close owns it (see the wiring test).
    expect(handleIsOpen(reopened)).toBe(true);
  });

  it("F. workspace mode: the store lives in the workspace and closes before removal", async () => {
    vi.stubEnv("DSH_BETTER_EDIT_STORE_DIR", "workspace");
    _resetConfigCache();
    const cwd = join(home, "ws-mode");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "f.txt"), "delta\n", "utf-8");
    const token = useToken("ws-agent");

    const readTool = wrapToolWithAgentStore(buildReadTool(localIO()));
    await callTool(readTool, { path: "f.txt" }, makeExec(cwd, token));

    const storePath = hashStorePath(cwd);
    expect(storePath).toBe(join(cwd, ".dsh_better_edit", "hash-store.sqlite"));
    expect(ownerCount(storePath)).toBe(1);
    const store = await loadHashStore(cwd);
    expect(handleIsOpen(store)).toBe(true);

    const detached = detachAgent(token);
    // The dead handle is the assertion; the removal below only proves nothing re-opens it.
    expect(handleIsOpen(store)).toBe(false);
    await detached;
    await expect(rm(cwd, { recursive: true })).resolves.toBeUndefined();
  });

  it("K. central mode: the last detach leaves a closable cache dir, no open fd", async () => {
    // T3's case F pins the workspace store; the central store lives under `$DSH_HOME/.../runtime/`
    // and is the path a bare `rm` of the cache would hit. The claim is the same in one respect —
    // the handle is dead when the last detach returns, so nothing holds the file — and different
    // in another: the directory is not the workspace, so its removal proves the cached entry (not
    // the cwd) was what kept it open.
    await writeFile(join(workspace, "k.txt"), "kappa\n", "utf-8");
    const token = useToken("last-agent");
    const readTool = wrapToolWithAgentStore(buildReadTool(localIO()));
    await callTool(readTool, { path: "k.txt" }, makeExec(workspace, token));

    const store = await loadHashStore(workspace);
    expect(handleIsOpen(store)).toBe(true);

    const detached = detachAgent(token);
    // 1 -> 0 runs the close synchronously inside the detach: no handle outlives this line.
    expect(handleIsOpen(store)).toBe(false);
    await detached;

    // The close dropped the cache entry too, so a later load is a fresh handle, not the dead one.
    const reopened = await loadHashStore(workspace);
    expect(reopened).not.toBe(store);
    expect(handleIsOpen(reopened)).toBe(true);

    const cacheDir = dirname(hashStorePath(workspace));
    expect(cacheDir).toBe(
      join(home, ".dsh", "plugins", "dsh-better-edit", "runtime", basename(cacheDir)),
    );
    expect(existsSync(cacheDir)).toBe(true);

    // Close the fresh handle first: the removal claim is about the store's own fd, not about a
    // caller that chose to keep a handle open across the delete.
    shutdownHashStore();
    await expect(rm(cacheDir, { recursive: true, force: true })).resolves.toBeUndefined();
    expect(existsSync(cacheDir)).toBe(false);
  });

  it("G. a path-resolution fault is reported, never raised: the body still runs", async () => {
    // The install passes its own channel: an attach failure reaches the plugin's logger, not
    // the console, so the callback IS the assertion seam.
    const reported: string[] = [];
    const calls: string[] = [];
    const tool = wrapToolWithAgentStore(
      {
        async execute(_args: never, _exec: ToolRunContext) {
          calls.push("body");
          return "ran";
        },
      },
      (message) => reported.push(message),
    );
    // `execCwd` reads the live `workingDirectory` service; make that read throw, which is the
    // only way the attach seam can fail before it claims anything.
    const exec = {
      signal: new AbortController().signal,
      agent: {
        id: "faulty",
        session: { id: "faulty", header: { cwd: workspace } },
        ctx: {
          get: () => ({
            get() {
              throw new Error("cwd lookup exploded");
            },
          }),
        },
      },
      arguments: {},
    } as unknown as ToolExecution;

    await expect(tool.execute({} as never, exec as never)).resolves.toBe("ran");
    expect(calls).toEqual(["body"]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("store attach failed");
    expect(reported[0]).toContain("cwd lookup exploded");
    // Nothing was claimed, so the unmade claim cannot strand a path for that token.
    expect(agentPathCount("faulty")).toBe(0);
  });
  it("H. a decorated mutating tool applies the edit and owns the store", async () => {
    await writeFile(join(workspace, "h.txt"), "alpha\nbeta\n", "utf-8");
    const integration = setupIntegrationTest(workspace);
    // One string is both the attach token and the session key: the fixture's `read` serves the
    // anchors for `sessionKey`, and the edit must cite a lease that same session owns. The
    // fixture's own `editTool` is the pi-shaped five-argument adapter, whose (callId, params)
    // signature the (args, exec) wrapper would misread — so the decorated def is the fixture's
    // io + sandbox through the builder the adapter wraps.
    const token = useToken(integration.sessionKey);
    const readText = getText(await integration.readTool.execute("read", { path: "h.txt" }));
    const betaRow = readText.split("\n").find((line) => line.includes("│beta"));
    expect(betaRow).toBeDefined();
    const hash = betaRow!.split("│")[0]!;

    const edit = wrapToolWithAgentStore(buildEditTool(integration.io, makeTestSandbox()));
    await callTool(
      edit,
      { file: "h.txt", edits: [[hash, hash, "BETA"]] },
      makeExec(workspace, token),
    );

    expect(await readFile(join(workspace, "h.txt"), "utf-8")).toBe("alpha\nBETA\n");
    expect(ownerCount(hashStorePath(workspace))).toBe(1);
  });

  it("I. a close that fails at scope end rejects the call and leaves the handle retryable", async () => {
    const token = useToken("scope-close");
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const fake = wrapToolWithAgentStore({
      async execute(_args: never, _exec: ToolRunContext) {
        markStarted();
        await gate;
        return "ok";
      },
    });

    const call = fake.execute({} as never, makeExec(workspace, token)({}) as never);
    await started;
    expect(ownerCount(storePath)).toBe(1);

    // The drain's close is the one that fails — and it runs from the scope's `finally`, so the
    // error supersedes this call's own result.
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => {
      throw new Error("close exploded");
    });
    const detached = detachAgent(token);
    expect(isDraining(storePath)).toBe(true);

    releaseGate();
    await expect(call).rejects.toThrow("close exploded");
    // The failed close kept the entry, so the handle is still live and still closeable.
    expect(handleIsOpen(store)).toBe(true);
    // The registry's documented split: a close run from a scope's end supersedes THAT scope's
    // result, while the drain's waiters already resolved because the drain finished either way.
    // A caller-driven close (no in-flight scope) is the arm that makes the detach itself reject;
    // the wiring suite pins that one.
    await expect(detached).resolves.toBeUndefined();
    closeSpy.mockRestore();
  });

  it("J. the write hook is a store user: a write-only agent attaches and the teardown closes", async () => {
    await writeFile(join(workspace, "w.txt"), "hello\n", "utf-8");
    const token = useToken("write-only-agent");
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);

    // The hook speaks to the agent's scope through `on`; nothing else of Cordis is needed to
    // register the two listeners this case drives by hand.
    const listeners = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const agentCtx = {
      on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
        listeners.set(event, handler);
        return () => listeners.delete(event);
      },
    };
    const warnings: string[] = [];
    const rootCtx = { logger: { warn: (message: string) => warnings.push(message) } };
    registerWriteHook(rootCtx as never, agentCtx as never, localIO());

    const exec = {
      ...makeExec(workspace, token)({ file_path: "w.txt", content: "hello\n" }),
      name: "write",
    } as ToolExecution;

    const verdict = await listeners.get("tools/pre-execute")!(exec, async () => ({
      kind: "accept",
    }));
    expect(verdict).toEqual({ kind: "accept" });
    expect(warnings).toEqual([]);

    const decision = await listeners.get("tools/post-execute")!(
      exec,
      { isError: false, content: [{ type: "text", text: "wrote" }] },
      async () => ({ kind: "accept" }),
    );
    expect(decision).toMatchObject({ kind: "accept" });

    // No decorated tool body ran here: the hook's own attach is the ONLY owner, so a hook that
    // skipped the wrapper shows 0 and leaves the handle open after the detach.
    expect(ownerCount(storePath)).toBe(1);
    const detached = detachAgent(token);
    expect(handleIsOpen(store)).toBe(false);
    await detached;
  });
});
