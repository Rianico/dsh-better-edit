/**
 * dsh-better-edit — hash-anchored read/edit/undo_last_edit for
 * DeepSeek Harness, a dsh port of pi-hashline-edit-lsz.
 *
 * Cordis host-plane plugin (mounted by the bundle's cordis.patch.yml). On
 * `agent/created` it registers the hashline tools and prompt sections on
 * the AGENT's own scope layer, so they shadow the preset's built-in `read` /
 * `edit` for that agent (nearest layer wins in dsh's tool registry) and unwind
 * automatically when the agent is disposed. The built-in `write` stays in
 * place; scoped pre/post listeners reject copied same-line served anchors
 * before dispatch and append a fresh hashline preview after successful writes.
 *
 * The three `tool:*` guidance sections resolve per agent preset from override
 * files in the shared home (see `src/guidance.ts`); deployments without the
 * `agentPresets` service keep the compiled defaults unchanged.
 * @module dsh-better-edit
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import { ctxFsIO } from "./fs-bridge.js";
import { FsSandboxController } from "./sandbox.js";
import { buildReadTool } from "./tool-read.js";
import { buildEditTool } from "./tool-edit.js";
import { buildStrReplaceEditorTool } from "./tool-str-replace-editor.js";
import { buildUndoTool } from "./tool-undo.js";
import { registerWriteHook } from "./write-hook.js";
import { createSelfHealWatcher } from "./self-heal.js";
import {
  resolveToolset,
  sectionsForToolset,
  UNCONDITIONAL_TOOLSET,
  type HashlineToolset,
} from "./preset-toolset.js";
import { registerWithReclaim } from "./reclaim.js";
import { initHasher } from "./hashline/hash-assign.js";
import {
  composeSections,
  ensurePresetGuidance,
  GUIDANCE_SECTIONS,
  type GuidanceSection,
  type SectionOverride,
} from "./guidance.js";
import { configDir } from "./store/index.js";
import { ensureDefaultConfig } from "./store-config.js";
import { onAppStart, onSessionStart } from "./store/index.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-better-edit";

/**
 * Services the plugin's per-agent install touches: `tools` and `systemPrompt`
 * for the shadow registrations, `fs` for the IO bridge. Cordis refuses
 * property access to an undeclared service ("cannot get property X without
 * inject"), so these MUST be listed or every agent install fails at
 * session-start.
 */
export const inject = ["tools", "systemPrompt", "fs"];

/** One per-agent registration bundle, disposed with the agent. */
interface AgentTools {
  dispose(): void;
}

/**
 * Minimal shape of the optional `agentPresets` service (dsh-agent-presets).
 * Read via `ctx.get` — never injected — so a deployment composed without the
 * service keeps the compiled defaults and never touches the filesystem here.
 */
interface AgentPresetsService {
  composedPreset(agentCtx: Context): string | undefined;
}
/**
 * The harness's canonical slot for a guidance section, when the installed
 * `systemPrompt` registry exposes one (`getSectionOrder`, dsh 0.1.5+). Sections
 * without a canonical slot — `undo_last_edit` is plugin-owned — keep their
 * compiled default. A registry that predates the API keeps every default.
 */
function sectionOrderFor(rootCtx: Context): (section: GuidanceSection) => number {
  const systemPrompt = rootCtx.systemPrompt as {
    getSectionOrder?: (name: string) => number;
  };
  const getSectionOrder = systemPrompt.getSectionOrder;
  if (typeof getSectionOrder !== "function") return (section) => section.defaultOrder;
  return (section) => {
    if (section.orderName === undefined) return section.defaultOrder;
    try {
      return getSectionOrder.call(systemPrompt, section.orderName);
    } catch {
      // A registry that does not know the name keeps the compiled default.
      return section.defaultOrder;
    }
  };
}

/** The three sections as compiled, byte-identical to the pre-guidance install. */
function compiledDefaultSections(rootCtx: Context): SectionOverride[] {
  const orderFor = sectionOrderFor(rootCtx);
  return GUIDANCE_SECTIONS.map((section) => ({
    name: section.name,
    order: orderFor(section),
    text: section.renderDefault(),
  }));
}

/**
 * Resolve the three guidance sections for one agent. Without the `agentPresets`
 * service the fast path returns the compiled defaults untouched. With it, the
 * agent's preset id drives `composeSections` against the shared home; any
 * resolution failure degrades to compiled defaults so a bad override file can
 * never fail the install.
 */
async function resolveAgentSections(rootCtx: Context, agent: Agent): Promise<SectionOverride[]> {
  const agentPresets = rootCtx.get("agentPresets") as AgentPresetsService | undefined;
  if (!agentPresets) return compiledDefaultSections(rootCtx);
  try {
    const presetId = agentPresets.composedPreset(agent.ctx);
    const sections = await composeSections(presetId, configDir(), sectionOrderFor(rootCtx));
    // Warn once per agent install (this runs once per agent, under the
    // WeakSet guard) about any malformed override we had to ignore.
    for (const section of sections) {
      if (section.malformed) {
        rootCtx.logger.warn(
          `dsh-better-edit: ignoring malformed guidance override ${section.malformed.file}: ${section.malformed.reason}; using compiled default`,
        );
      }
    }
    return sections;
  } catch (error) {
    rootCtx.logger.warn(
      `dsh-better-edit: guidance resolution failed for agent ${agent.id}, using compiled defaults: ${error instanceof Error ? error.message : String(error)}`,
    );
    return compiledDefaultSections(rootCtx);
  }
}

function installAgentTools(rootCtx: Context, agent: Agent): void {
  agent.ctx.effect(() => {
    let disposed = false;
    const disposers: Array<() => void> = [];
    const registerDisposer = (dispose: (() => void) | undefined): void => {
      if (!dispose) return;
      if (disposed) {
        try {
          dispose();
        } catch {
          // A registration that lost the teardown race is still released.
        }
        return;
      }
      disposers.push(dispose);
    };

    // `fs` is host-plane: use the plugin's own context (covered by
    // inject) rather than the agent's scoped one, whose fiber chain does
    // not declare it. The session's live directory still reaches the bridge
    // per call via `execCwd` (the `workingDirectory` service, falling back to
    // `exec.agent.session.header.cwd`).
    const toolsSvc = rootCtx.get("tools");
    const io = ctxFsIO(rootCtx.fs as FileSystem, rootCtx);
    const sandbox = new FsSandboxController(rootCtx);

    // Step 1: `read` is unconditional (Rianico/dsh-better-edit#110) and is
    // claimed synchronously inside `agent/created`, before any eager peer can
    // take the name. The owned definition stays in this closure: self-heal
    // verifies identity against it and must never read `layer.get("read")`,
    // which would ratify an intruder.
    const hashReadDef = buildReadTool(io);
    try {
      registerDisposer(
        registerWithReclaim({
          toolsSvc,
          agent,
          agentCtx: agent.ctx,
          name: "read",
          def: hashReadDef,
          logger: rootCtx.logger,
        }),
      );
    } catch (error) {
      rootCtx.logger.warn(
        `dsh-better-edit: failed to install synchronous read tool: ${error instanceof Error ? error.message : String(error)} (#123)`,
      );
    }

    // The composed preset's own tool policy decides which mutating tools this
    // agent gets. `agentPresets.acquireScope` is async in dsh 0.2.x, so these
    // registrations land after the first microtask; the guarded reclaim in
    // `registerWithReclaim` wins ownership back from peers that claimed a name
    // first.
    (async () => {
      let toolset: HashlineToolset;
      try {
        toolset = await resolveToolset(rootCtx, agent.ctx);
      } catch (error) {
        rootCtx.logger.warn(
          `dsh-better-edit: resolveToolset failed, using default: ${error instanceof Error ? error.message : String(error)} (#123)`,
        );
        toolset = UNCONDITIONAL_TOOLSET;
      }
      if (disposed) return;

      // Step 2: `edit`. Build and register are isolated: a factory fault must
      // not cost the later tools or the guidance sections.
      let hashEditDef: unknown;
      if (toolset.edit) {
        try {
          hashEditDef = buildEditTool(io, sandbox);
          registerDisposer(
            registerWithReclaim({
              toolsSvc,
              agent,
              agentCtx: agent.ctx,
              name: "edit",
              def: hashEditDef,
              logger: rootCtx.logger,
            }),
          );
        } catch (error) {
          rootCtx.logger.warn(
            `dsh-better-edit: failed to build/register edit: ${error instanceof Error ? error.message : String(error)} (#123)`,
          );
        }
      }
      if (disposed) return;

      // Step 3: governed shadow of the preset's built-in str_replace_editor
      // (ADR-0015): identical contract, encoding-governed mutations. Only a
      // preset that composed the built-in earns the shadow.
      let hashStrReplaceDef: unknown;
      if (toolset.strReplaceEditor) {
        try {
          hashStrReplaceDef = buildStrReplaceEditorTool(io, sandbox);
          registerDisposer(
            registerWithReclaim({
              toolsSvc,
              agent,
              agentCtx: agent.ctx,
              name: "str_replace_editor",
              def: hashStrReplaceDef,
              logger: rootCtx.logger,
            }),
          );
        } catch (error) {
          rootCtx.logger.warn(
            `dsh-better-edit: failed to build/register str_replace_editor: ${error instanceof Error ? error.message : String(error)} (#123)`,
          );
        }
      }
      if (disposed) return;

      // Step 4: `undo_last_edit`, built by the arity-pinned factory and routed
      // through the same guarded reclaim (issue #123).
      if (toolset.undo) {
        try {
          const hashUndoDef = buildUndoTool(io, sandbox);
          registerDisposer(
            registerWithReclaim({
              toolsSvc,
              agent,
              agentCtx: agent.ctx,
              name: "undo_last_edit",
              def: hashUndoDef,
              logger: rootCtx.logger,
            }),
          );
        } catch (error) {
          rootCtx.logger.warn(
            `dsh-better-edit: failed to register undo tool: ${error instanceof Error ? error.message : String(error)} (#123)`,
          );
        }
      }
      if (disposed) return;

      // Step 5: the write hook guards the preset's own built-in `write` and
      // auto-reads after it. It attaches event listeners rather than naming a
      // tool, so it carries no collision surface and needs no reclaim.
      if (toolset.writeHook) {
        try {
          registerDisposer(registerWriteHook(rootCtx, agent.ctx, io));
        } catch (error) {
          rootCtx.logger.warn(
            `dsh-better-edit: failed to register write hook: ${error instanceof Error ? error.message : String(error)} (#123)`,
          );
        }
      }
      if (disposed) return;

      // Step 6: self-heal receives the exact definitions installed above, so
      // the heal set can never drift from the installed set.
      try {
        registerDisposer(
          createSelfHealWatcher({
            agentId: agent.id,
            rootCtx,
            agent,
            agentCtx: agent.ctx,
            toolsSvc,
            hashReadDef,
            hashEditDef,
            hashStrReplaceDef,
          }),
        );
      } catch (error) {
        rootCtx.logger.warn(
          `dsh-better-edit: failed to initialize self-heal watcher: ${error instanceof Error ? error.message : String(error)} (#123)`,
        );
      }
      if (disposed) return;

      // Step 7: shadow the preset's built-in tool guidance with the hashline
      // contract. Same section names on the agent's own layer win over the
      // preset's; text and order come from the per-preset resolution, with the
      // harness's canonical tool slot as the default order.
      try {
        const sections = sectionsForToolset(await resolveAgentSections(rootCtx, agent), toolset);
        if (disposed) return;
        for (const section of sections) {
          registerDisposer(agent.ctx.systemPrompt.section(section));
        }
      } catch (error) {
        rootCtx.logger.warn(
          `dsh-better-edit: failed to register system prompt guidance: ${error instanceof Error ? error.message : String(error)} (#123)`,
        );
      }
    })().catch((error) => {
      rootCtx.logger.warn(
        `dsh-better-edit: unhandled async install failure: ${error instanceof Error ? error.message : String(error)} (#123)`,
      );
    });

    return () => {
      disposed = true;
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Best-effort teardown: one failing disposer must not strand the rest.
        }
      }
      disposers.length = 0;
    };
  });
}

/** Mount the bundle: initialize the store, then install tools per agent. */
export function apply(rootCtx: Context): void {
  // Central lifecycle janitor — throttled 24h, never deletes live hash (mtime hot)
  // Runs once at app start and on each session-start (central mode only)
  queueMicrotask(() => {
    onAppStart().catch((e) =>
      rootCtx.logger.warn(
        `dsh-better-edit: central janitor failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  });
  // Warm the hasher once; the per-workspace stores are opened lazily on the
  // first tool call in each workspace (there is no shared store to prune at
  // boot anymore).
  initHasher().catch((error) => {
    rootCtx.logger.warn(
      `dsh-better-edit: hasher warm-up failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  // Seed each shipped preset's guidance directory once, so users have
  // editable per-preset overrides (idempotent: never rewrites existing
  // files). A failure must never fail the boot.
  ensureDefaultConfig().catch((error) => {
    rootCtx.logger.warn(
      `dsh-better-edit: default config materialization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  ensurePresetGuidance(configDir(), (message) => rootCtx.logger.warn(message)).catch((error) => {
    rootCtx.logger.warn(
      `dsh-better-edit: guidance materialization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const registered = new WeakSet<Agent>();
  rootCtx.on("agent/created", ({ agent }) => {
    // throttled central janitor on session-start (inside same handler to avoid extra listener)
    onSessionStart().catch((e) =>
      rootCtx.logger.warn(
        `dsh-better-edit: central janitor failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
    if (registered.has(agent)) return;
    registered.add(agent);
    try {
      installAgentTools(rootCtx, agent);
    } catch (error) {
      rootCtx.logger.warn(
        `dsh-better-edit: failed to install tools for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

export type { AgentTools };
