import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** Fault-injection flag: the mock below reads it when the install builds `edit`. */
const faults = vi.hoisted(() => ({ buildEditToolThrows: false }));

/** Every `createSelfHealWatcher` call, so the identity anchor can be audited. */
const watcherCalls = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));

vi.mock("../../src/tool-edit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tool-edit.js")>();
  return {
    ...actual,
    buildEditTool: (...args: Parameters<typeof actual.buildEditTool>) => {
      if (faults.buildEditToolThrows) throw new Error("edit tool factory exploded");
      return actual.buildEditTool(...args);
    },
  };
});

vi.mock("../../src/self-heal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/self-heal.js")>();
  return {
    ...actual,
    createSelfHealWatcher: (options: Parameters<typeof actual.createSelfHealWatcher>[0]) => {
      watcherCalls.options.push(options as unknown as Record<string, unknown>);
      return actual.createSelfHealWatcher(options);
    },
  };
});

import { apply } from "../../src/index.js";
import { setupTestHome } from "../support/fixtures.js";

/** The layer shape the DSH registry exposes through `tools.layers.scoped`. */
interface ScopedLayer {
  get(name: string): unknown;
  data: LayerData;
}

/** A layer data map that records deletes, so a blind reclaim is observable. */
class LayerData extends Map<string, unknown> {
  readonly deleteCalls: string[] = [];
  override delete(name: string): boolean {
    this.deleteCalls.push(name);
    return super.delete(name);
  }
}

interface RegisterFailure {
  name: string;
  message: string;
}

interface HostOptions {
  /** Withhold the preset-scope lease so `resolveToolset` stays pending. */
  presetPending?: boolean;
  /** Fail one `register` call with a non-collision error (no occupied entry). */
  registerFailure?: RegisterFailure;
}

interface Host {
  rootCtx: unknown;
  agent: { id: string };
  layer: ScopedLayer;
  layerData: LayerData;
  /** Names whose entry the install deleted; empty unless a reclaim ran. */
  deletedNames(): string[];
  registerCalls: string[];
  sections: Array<{ name: string }>;
  agentListeners: Map<string, () => void>;
  warnCalls: string[];
  rootListeners: Map<string, (payload: unknown) => void>;
  /** Run the effect cleanups Cordis would run on agent disposal. */
  disposeAgent(): void;
  /** Resolve the deferred preset lease (only meaningful with `presetPending`). */
  releaseScope(): void;
}

/** Two microtask ticks — the self-heal restore runs in a queued microtask. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
}

/** Let detached async install work reach its next await/timer boundary. */
async function drain(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Wait until the install quiesces. `read` registers synchronously; the
 * preset-gated tools and the guidance sections land from a detached async
 * install IIFE (Rianico/dsh-better-edit#123), which the effect promise no longer
 * covers. The guidance sections are the install's last step, so their arrival
 * marks completion.
 */
async function settle(host: Host): Promise<void> {
  const deadline = Date.now() + 2000;
  while (host.sections.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await drain(1);
}

/**
 * A stub host modelled on DSH `NamedEntries`: one agent-scoped layer whose
 * `insert` throws on a duplicate name in the same scope, plus a preset layer
 * reachable only through the lease key.
 */
function createHost(options: HostOptions = {}): Host {
  const layerData = new LayerData();
  const layer: ScopedLayer = {
    get: (name: string) => layerData.get(name),
    data: layerData,
  };
  const agent: { id: string; ctx?: unknown } = { id: "agent-isolation" };
  const scoped = new Map<unknown, { tools: ScopedLayer }>([[agent, { tools: layer }]]);

  const presetTools = new Map<string, unknown>([
    ["read", { name: "preset-read" }],
    ["edit", { name: "preset-edit" }],
    ["str_replace_editor", { name: "preset-str-replace-editor" }],
    ["write", { name: "preset-write" }],
  ]);
  const presetKey = { preset: "standard" };

  let releaseScope = (_lease: unknown): void => {};
  const pendingScope = new Promise<unknown>((resolve) => {
    releaseScope = resolve;
  });

  const toolsSvc = {
    get(name: string, scope?: unknown) {
      return scope === presetKey ? presetTools.get(name) : layer.get(name);
    },
    layers: { scoped },
  };
  const presets = options.presetPending
    ? {
        composedPreset: () => "standard",
        acquireScope: () => pendingScope,
      }
    : undefined;

  const registerCalls: string[] = [];
  const register = vi.fn((def: { name: string }) => {
    registerCalls.push(def.name);
    if (options.registerFailure?.name === def.name) {
      throw new Error(options.registerFailure.message);
    }
    if (layerData.has(def.name)) {
      throw new Error(`tool "${def.name}" is already registered in this scope`);
    }
    layerData.set(def.name, def);
    return () => {
      layerData.delete(def.name);
    };
  });

  const sections: Array<{ name: string }> = [];
  const agentListeners = new Map<string, () => void>();
  const agentCleanups: Array<() => void> = [];
  const agentCtx = {
    tools: { register },
    systemPrompt: {
      section(section: { name: string }) {
        sections.push(section);
        return () => {
          const index = sections.indexOf(section);
          if (index >= 0) sections.splice(index, 1);
        };
      },
    },
    on(event: string, handler: () => void) {
      agentListeners.set(event, handler);
      return () => {
        agentListeners.delete(event);
      };
    },
    effect(fn: () => unknown) {
      const cleanup = fn();
      if (typeof cleanup === "function") agentCleanups.push(cleanup as () => void);
      return () => {
        for (const run of agentCleanups) run();
      };
    },
  };
  agent.ctx = agentCtx;

  const warnCalls: string[] = [];
  const rootListeners = new Map<string, (payload: unknown) => void>();
  const rootCtx = {
    logger: {
      warn(message: string) {
        warnCalls.push(message);
      },
      error(message: string) {
        warnCalls.push(message);
      },
      info() {},
      debug() {},
    },
    get(service: string) {
      if (service === "tools") return toolsSvc;
      if (service === "agentPresets") return presets;
      return undefined;
    },
    fs: { sandboxMode: undefined },
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
    layerData,
    deletedNames: () => [...layerData.deleteCalls],
    registerCalls,
    sections,
    agentListeners,
    warnCalls,
    rootListeners,
    disposeAgent() {
      for (const run of agentCleanups) run();
    },
    releaseScope() {
      releaseScope({ key: presetKey, [Symbol.asyncDispose]: async () => {} });
    },
  };
}

/** Mount the plugin on the stub host exactly as the harness does. */
function mount(host: Host): void {
  apply(host.rootCtx as never);
  host.rootListeners.get("agent/created")!({ agent: host.agent });
}

function registeredNames(host: Host): string[] {
  return [...host.layerData.keys()].sort();
}

function hasWarn(host: Host, ...fragments: string[]): boolean {
  return host.warnCalls.some((message) =>
    fragments.every((fragment) => message.includes(fragment)),
  );
}

describe("agent-layer tool install isolation (#123)", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const home = await setupTestHome();
    cleanup = home.cleanup;
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("S1 reclaims a peer-claimed edit and undo_last_edit and finishes the install", async () => {
    const host = createHost();
    const peerEdit = { name: "peer-edit" };
    const peerUndo = { name: "peer-undo" };
    host.layerData.set("edit", peerEdit);
    host.layerData.set("undo_last_edit", peerUndo);

    mount(host);
    await settle(host);

    expect(registeredNames(host)).toEqual(["edit", "read", "str_replace_editor", "undo_last_edit"]);
    expect(host.layer.get("edit")).not.toBe(peerEdit);
    expect(host.layer.get("edit")).toMatchObject({ name: "edit" });
    expect(host.layer.get("undo_last_edit")).not.toBe(peerUndo);
    expect(host.layer.get("undo_last_edit")).toMatchObject({ name: "undo_last_edit" });

    // Both contested names are reclaimed through the shared primitive, each
    // with a warning that cites the issue.
    expect(hasWarn(host, 'reclaimed contested tool "edit"', "#123")).toBe(true);
    expect(hasWarn(host, 'reclaimed contested tool "undo_last_edit"', "#123")).toBe(true);

    // The rest of the install completes: write hook listeners, self-heal
    // watcher, and the guidance sections.
    expect(host.agentListeners.has("tools/pre-execute")).toBe(true);
    expect(host.agentListeners.has("tools/post-execute")).toBe(true);
    expect(host.agentListeners.has("tools/change")).toBe(true);
    expect(host.sections.map((section) => section.name)).toEqual([
      "tool:read",
      "tool:edit",
      "tool:undo_last_edit",
    ]);
  });

  it("S2 disposes the install when the agent dies while preset resolution is pending", async () => {
    const host = createHost({ presetPending: true });

    mount(host);
    // `read` is claimed synchronously, inside `agent/created`.
    expect(host.layer.get("read")).toBeDefined();
    const registrationsBeforeDispose = host.registerCalls.length;

    host.disposeAgent();
    // The synchronous cleanup releases the read registration immediately.
    expect(host.layer.get("read")).toBeUndefined();

    // The pending toolset resolves after the agent is gone: the `disposed` gate
    // discards the rest of the install, so nothing leaks into the dead scope.
    host.releaseScope();
    await drain();

    expect(host.registerCalls.length).toBe(registrationsBeforeDispose);
    expect(registeredNames(host)).toEqual([]);
    expect(host.sections).toEqual([]);
    expect(host.warnCalls).toEqual([]);
  });

  it("S3 never reclaims on a non-collision failure and leaves the peer layer alone", async () => {
    const host = createHost({
      registerFailure: { name: "edit", message: "invalid tool definition: bad schema" },
    });
    const peer = { name: "peer-unrelated" };
    host.layerData.set("unrelated_peer", peer);

    mount(host);
    await settle(host);

    // No occupied entry and no collision signal: the guarded reclaim must not
    // run, and the unrelated peer definition stays untouched.
    expect(host.deletedNames()).toEqual([]);
    expect(host.layer.get("unrelated_peer")).toBe(peer);
    expect(host.layer.get("edit")).toBeUndefined();
    expect(hasWarn(host, "non-collision error", "#123")).toBe(true);

    // Fault isolation: the remaining tools and the guidance still install.
    expect(registeredNames(host)).toEqual([
      "read",
      "str_replace_editor",
      "undo_last_edit",
      "unrelated_peer",
    ]);
    expect(host.sections.map((section) => section.name)).toEqual([
      "tool:read",
      "tool:edit",
      "tool:undo_last_edit",
    ]);
  });

  it("S4 isolates a factory fault: the remaining tools and guidance still install", async () => {
    faults.buildEditToolThrows = true;
    try {
      const host = createHost();
      mount(host);
      await settle(host);

      expect(hasWarn(host, "failed to build/register edit", "#123")).toBe(true);
      expect(registeredNames(host)).toEqual(["read", "str_replace_editor", "undo_last_edit"]);
      expect(host.sections.map((section) => section.name)).toEqual([
        "tool:read",
        "tool:edit",
        "tool:undo_last_edit",
      ]);
      expect(host.agentListeners.has("tools/change")).toBe(true);
      expect(host.agentListeners.has("tools/pre-execute")).toBe(true);
    } finally {
      faults.buildEditToolThrows = false;
    }
  });

  it("self-heal keeps the owned read definition, not whatever the layer holds", async () => {
    const host = createHost();
    mount(host);
    await settle(host);

    const lastOptions = watcherCalls.options[watcherCalls.options.length - 1];
    expect(lastOptions).toBeDefined();
    if (!lastOptions) throw new Error("self-heal watcher was not created");

    const ownedRead = lastOptions.hashReadDef;
    expect(ownedRead).toBe(host.layer.get("read"));

    // Replace the read entry with an intruder. A watcher that re-read
    // `layer.get("read")` would ratify the intruder and never heal; this one
    // restores the definition the install built.
    const intruder = { name: "intruder-read" };
    host.layerData.set("read", intruder);
    host.agentListeners.get("tools/change")!();
    await flushMicrotasks();

    expect(host.layer.get("read")).not.toBe(intruder);
    expect(host.layer.get("read")).toBe(ownedRead);
  });
});
