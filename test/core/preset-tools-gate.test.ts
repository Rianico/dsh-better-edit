import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apply } from "../../src/index.js";
import {
  resolveToolset,
  sectionsForToolset,
  toolsetFor,
  UNCONDITIONAL_TOOLSET,
  type HashlineToolset,
} from "../../src/preset-toolset.js";
import { createSelfHealWatcher } from "../../src/self-heal.js";
import { setupTestHome } from "../support/fixtures.js";

/** Two microtask ticks — the self-heal restore runs in a queued microtask. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
}

type HostMode =
  | "service"
  | "preset-free"
  | "preset"
  | "legacy"
  | "no-scope-api"
  | "keyless-lease"
  | "rejects"
  | "sync";

interface PresetFixture {
  id: string;
  tools: readonly string[];
}

interface Host {
  rootCtx: unknown;
  agent: { id: string };
  registrations: Map<string, unknown>;
  sections: Array<{ name: string; order: number; text: string }>;
  agentListeners: Map<string, () => void>;
  rootListeners: Map<string, (payload: unknown) => void>;
  acquiredIds: string[];
  standingIds: string[];
  leaseDisposals: number;
  warnCalls: string[];
  settled(): Promise<void>;
}

/**
 * A stub host: one agent, one preset, a scope-layered tool registry whose
 * `get(name, scope)` answers from the preset layer, and an `agentPresets`
 * service whose scope-read shape the case chooses.
 */
function createHost(options: {
  mode: HostMode;
  preset?: PresetFixture;
  toolsGetThrows?: boolean;
}): Host {
  const registrations = new Map<string, unknown>();
  const agentLayer = {
    get: (name: string) => registrations.get(name),
    data: registrations,
  };
  const scopedLayers = new Map<unknown, { tools: typeof agentLayer }>();
  const agent: { id: string; ctx?: unknown } = { id: "agent-1" };
  scopedLayers.set(agent, { tools: agentLayer });

  const presetTools = new Map<string, unknown>(
    (options.preset?.tools ?? []).map((name) => [name, { name: `preset-${name}` }]),
  );
  const presetKey = { preset: options.preset?.id };

  const toolsSvc = {
    get(name: string, scope?: unknown) {
      if (options.toolsGetThrows) throw new Error("registry exploded");
      if (scope === presetKey) return presetTools.get(name);
      return agentLayer.get(name);
    },
    layers: { scoped: scopedLayers },
  };

  const acquiredIds: string[] = [];
  const standingIds: string[] = [];
  let leaseDisposals = 0;
  const lease = {
    key: presetKey,
    async [Symbol.asyncDispose]() {
      leaseDisposals += 1;
    },
  };
  const presetsSvc =
    options.mode === "service"
      ? undefined
      : {
          composedPreset: () => (options.mode === "preset-free" ? undefined : options.preset!.id),
          ...(options.mode === "preset" ||
          options.mode === "no-scope-api" ||
          options.mode === "keyless-lease" ||
          options.mode === "rejects"
            ? {
                async acquireScope(id?: string) {
                  acquiredIds.push(id ?? "");
                  if (options.mode === "rejects") throw new Error("preset registry unavailable");
                  if (options.mode === "no-scope-api") return undefined;
                  if (options.mode === "keyless-lease") return {};
                  return lease;
                },
              }
            : {}),
          ...(options.mode === "legacy"
            ? {
                async standingKeyFor(id?: string) {
                  standingIds.push(id ?? "");
                  return presetKey;
                },
              }
            : {}),
          ...(options.mode === "sync"
            ? {
                standingKeyFor(id?: string) {
                  standingIds.push(id ?? "");
                  return presetKey;
                },
              }
            : {}),
        };

  const sections: Array<{ name: string; order: number; text: string }> = [];
  const agentListeners = new Map<string, () => void>();
  const rootListeners = new Map<string, (payload: unknown) => void>();
  const effects: Array<Promise<unknown>> = [];

  const agentCtx = {
    tools: {
      register(def: { name: string }) {
        registrations.set(def.name, def);
        return () => registrations.delete(def.name);
      },
    },
    systemPrompt: {
      section(section: { name: string; order: number; text: string }) {
        sections.push(section);
        return () => {};
      },
      getSectionOrder: () => 1000,
    },
    on(event: string, handler: () => void) {
      agentListeners.set(event, handler);
      return () => agentListeners.delete(event);
    },
    effect(fn: () => unknown) {
      effects.push(Promise.resolve().then(fn));
      return () => {};
    },
  };
  agent.ctx = agentCtx;

  const warnCalls: string[] = [];
  const rootCtx = {
    logger: {
      warn(message: string) {
        warnCalls.push(message);
      },
      error() {},
      info() {},
      debug() {},
    },
    get(service: string) {
      if (service === "tools") return toolsSvc;
      if (service === "agentPresets") return presetsSvc;
      return undefined;
    },
    on(event: string, handler: (payload: unknown) => void) {
      rootListeners.set(event, handler);
      return () => rootListeners.delete(event);
    },
    fs: { sandboxMode: undefined },
    systemPrompt: { getSectionOrder: () => 1000 },
  };

  return {
    rootCtx,
    agent,
    registrations,
    sections,
    agentListeners,
    rootListeners,
    acquiredIds,
    standingIds,
    get leaseDisposals() {
      return leaseDisposals;
    },
    warnCalls,
    async settled() {
      await Promise.all(effects);
      const deadline = Date.now() + 2000;
      while (sections.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

/** Mount the plugin on a stub host exactly as the harness does. */
async function mount(options: Parameters<typeof createHost>[0]): Promise<Host> {
  const host = createHost(options);
  apply(host.rootCtx as never);
  host.rootListeners.get("agent/created")!({ agent: host.agent });
  await host.settled();
  return host;
}

function registeredNames(host: Host): string[] {
  return [...host.registrations.keys()].sort();
}

describe("preset toolset policy (probe seam)", () => {
  it("falls back to the unconditional set without the agentPresets service", async () => {
    const host = createHost({ mode: "service" });
    await expect(resolveToolset(host.rootCtx as never, {} as never)).resolves.toEqual(
      UNCONDITIONAL_TOOLSET,
    );
  });

  it("falls back to the unconditional set for a preset-free composition", async () => {
    const host = createHost({ mode: "preset-free" });
    await expect(resolveToolset(host.rootCtx as never, {} as never)).resolves.toEqual(
      UNCONDITIONAL_TOOLSET,
    );
  });

  it("falls back to the unconditional set when no scope-read API exists (pre-0.2.1)", async () => {
    const host = createHost({ mode: "no-scope-api", preset: { id: "standard", tools: ["read"] } });
    await expect(resolveToolset(host.rootCtx as never, {} as never)).resolves.toEqual(
      UNCONDITIONAL_TOOLSET,
    );
  });

  it("awaits the async acquireScope lease (production shape) and releases it once", async () => {
    const host = createHost({
      mode: "preset",
      preset: { id: "readonly", tools: ["read"] },
    });
    const toolset = await resolveToolset(host.rootCtx as never, {} as never);
    expect(toolset).toEqual({
      edit: false,
      strReplaceEditor: false,
      undo: false,
      writeHook: false,
    });
    expect(host.acquiredIds).toEqual(["readonly"]);
    expect(host.leaseDisposals).toBe(1);
  });

  it("awaits the async standingKeyFor of the older registry shape", async () => {
    const host = createHost({
      mode: "legacy",
      preset: { id: "standard", tools: ["read", "edit", "write"] },
    });
    await expect(resolveToolset(host.rootCtx as never, {} as never)).resolves.toEqual({
      edit: true,
      strReplaceEditor: false,
      undo: true,
      writeHook: true,
    });
    expect(host.standingIds).toEqual(["standard"]);
  });

  it("still accepts a synchronous scope read", async () => {
    const host = createHost({
      mode: "sync",
      preset: { id: "standard", tools: ["read", "edit"] },
    });
    await expect(resolveToolset(host.rootCtx as never, {} as never)).resolves.toEqual({
      edit: true,
      strReplaceEditor: false,
      undo: true,
      writeHook: false,
    });
    expect(host.standingIds).toEqual(["standard"]);
  });

  it("fails open and releases nothing when the scope read rejects", async () => {
    const host = createHost({
      mode: "rejects",
      preset: { id: "standard", tools: ["read"] },
    });
    await expect(resolveToolset(host.rootCtx as never, {} as never)).resolves.toEqual(
      UNCONDITIONAL_TOOLSET,
    );
    expect(host.warnCalls.some((message) => message.includes("preset tool policy"))).toBe(true);
    expect(host.leaseDisposals).toBe(0);
  });

  it("releases no lease it could not use", async () => {
    const host = createHost({
      mode: "keyless-lease",
      preset: { id: "standard", tools: ["read"] },
    });
    await expect(resolveToolset(host.rootCtx as never, {} as never)).resolves.toEqual(
      UNCONDITIONAL_TOOLSET,
    );
    expect(host.leaseDisposals).toBe(0);
  });

  it("fails open to the unconditional set when the registry throws", async () => {
    const host = createHost({
      mode: "preset",
      preset: { id: "readonly", tools: ["read"] },
      toolsGetThrows: true,
    });
    await expect(resolveToolset(host.rootCtx as never, {} as never)).resolves.toEqual(
      UNCONDITIONAL_TOOLSET,
    );
    expect(host.warnCalls.some((message) => message.includes("preset tool policy"))).toBe(true);
  });

  it("undo follows edit and str_replace_editor is probed by name", () => {
    const toolset = toolsetFor((name) => ["read", "edit", "str_replace_editor"].includes(name));
    expect(toolset).toEqual({
      edit: true,
      strReplaceEditor: true,
      undo: true,
      writeHook: false,
    });
  });

  it("drops the edit and undo guidance sections when those tools are absent", () => {
    const sections = [
      { name: "tool:read", order: 1100, text: "read" },
      { name: "tool:edit", order: 1300, text: "edit" },
      { name: "tool:undo_last_edit", order: 1310, text: "undo" },
    ];
    const readOnly: HashlineToolset = {
      edit: false,
      strReplaceEditor: false,
      undo: false,
      writeHook: false,
    };
    expect(sectionsForToolset(sections, readOnly).map((section) => section.name)).toEqual([
      "tool:read",
    ]);
    expect(
      sectionsForToolset(sections, UNCONDITIONAL_TOOLSET).map((section) => section.name),
    ).toEqual(["tool:read", "tool:edit", "tool:undo_last_edit"]);
  });
});

describe("preset toolset policy (install gate)", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const home = await setupTestHome();
    cleanup = home.cleanup;
  });
  afterAll(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await cleanup?.();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  it("read-only preset installs exactly the hashline read and no edit guidance", async () => {
    const host = await mount({ mode: "preset", preset: { id: "readonly", tools: ["read"] } });
    expect(registeredNames(host)).toEqual(["read"]);
    expect(host.sections.map((section) => section.name)).toEqual(["tool:read"]);
    expect(host.agentListeners.has("tools/pre-execute")).toBe(false);
    expect(host.agentListeners.has("tools/post-execute")).toBe(false);
  });

  it("read+edit preset installs read, edit, undo_last_edit and no str_replace_editor", async () => {
    const host = await mount({
      mode: "preset",
      preset: { id: "standard", tools: ["read", "edit"] },
    });
    expect(registeredNames(host)).toEqual(["edit", "read", "undo_last_edit"]);
    expect(host.sections.map((section) => section.name)).toEqual([
      "tool:read",
      "tool:edit",
      "tool:undo_last_edit",
    ]);
  });

  it("read+write preset keeps only the hashline read and the write hook", async () => {
    const host = await mount({
      mode: "preset",
      preset: { id: "writer", tools: ["read", "write"] },
    });
    expect(registeredNames(host)).toEqual(["read"]);
    expect(host.agentListeners.has("tools/pre-execute")).toBe(true);
    expect(host.agentListeners.has("tools/post-execute")).toBe(true);
  });

  it("install respects the legacy standingKeyFor scope read", async () => {
    const host = await mount({
      mode: "legacy",
      preset: { id: "standard", tools: ["read", "edit", "str_replace_editor"] },
    });
    expect(registeredNames(host)).toEqual(["edit", "read", "str_replace_editor", "undo_last_edit"]);
  });

  it("a tools/change on a read-only preset does not resurrect edit or str_replace_editor", async () => {
    const host = await mount({ mode: "preset", preset: { id: "readonly", tools: ["read"] } });
    host.agentListeners.get("tools/change")!();
    await flushMicrotasks();
    expect(registeredNames(host)).toEqual(["read"]);
    expect(host.warnCalls).toEqual([]);
  });

  it("a preset-free composition installs the same four tools as today", async () => {
    const host = await mount({ mode: "preset-free" });
    expect(registeredNames(host)).toEqual(["edit", "read", "str_replace_editor", "undo_last_edit"]);
  });

  it("a host without the agentPresets service installs the same four tools as today", async () => {
    const host = await mount({ mode: "service" });
    expect(registeredNames(host)).toEqual(["edit", "read", "str_replace_editor", "undo_last_edit"]);
  });
});

describe("self-heal gift set follows the installed set", () => {
  function createWatcher(options: { editDef?: object; strReplaceDef?: object }) {
    const readDef = { name: "read" };
    const toolMap = new Map<string, unknown>([["read", readDef]]);
    if (options.editDef) toolMap.set("edit", options.editDef);
    if (options.strReplaceDef) toolMap.set("str_replace_editor", options.strReplaceDef);
    const layer = { get: (name: string) => toolMap.get(name), data: toolMap };
    const agent = { id: "agent-1" };
    const scoped = new Map<unknown, { tools: typeof layer }>([[agent, { tools: layer }]]);
    const warnCalls: string[] = [];
    const rootCtx = {
      logger: {
        warn(message: string) {
          warnCalls.push(message);
        },
        error() {},
      },
      get() {
        return undefined;
      },
    };
    let changeHandler: (() => void) | undefined;
    const agentCtx = {
      tools: {
        register(def: unknown) {
          const definition = def as { name: string };
          toolMap.set(definition.name, def);
          return () => toolMap.delete(definition.name);
        },
      },
      on(_event: string, handler: () => void) {
        changeHandler = handler;
        return () => {
          changeHandler = undefined;
        };
      },
    };
    createSelfHealWatcher({
      agentId: agent.id,
      rootCtx,
      agent,
      agentCtx: agentCtx as never,
      toolsSvc: { layers: { scoped } },
      hashReadDef: readDef,
      hashEditDef: options.editDef,
      hashStrReplaceDef: options.strReplaceDef,
      healMinIntervalMs: 0,
    });
    return { toolMap, readDef, warnCalls, trigger: () => changeHandler!() };
  }

  it("never heals an edit the preset gate declined", async () => {
    const { toolMap, warnCalls, trigger } = createWatcher({});
    toolMap.set("edit", { name: "builtin-edit" });
    toolMap.set("str_replace_editor", { name: "builtin-str-replace" });
    trigger();
    await flushMicrotasks();
    expect(toolMap.get("edit")).toEqual({ name: "builtin-edit" });
    expect(toolMap.get("str_replace_editor")).toEqual({ name: "builtin-str-replace" });
    expect(warnCalls).toEqual([]);
  });

  it("still heals a read takeover while edit is declined", async () => {
    const { toolMap, readDef, warnCalls, trigger } = createWatcher({});
    toolMap.set("read", { name: "builtin-read" });
    trigger();
    await flushMicrotasks();
    expect(toolMap.get("read")).toBe(readDef);
    expect(warnCalls.some((m) => m.includes("restored hash-anchored read"))).toBe(true);
  });
});
