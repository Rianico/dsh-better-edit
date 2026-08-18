/**
 * dsh-better-edit — hash-anchored read/edit/batch_edit/undo_last_edit for
 * DeepSeek Harness, a dsh port of pi-hashline-edit-lsz.
 *
 * Cordis host-plane plugin (mounted by the bundle's cordis.patch.yml). On
 * `agent/session-start` it registers the hashline tools and prompt sections on
 * the AGENT's own scope layer, so they shadow the preset's built-in `read` /
 * `edit` for that agent (nearest layer wins in dsh's tool registry) and unwind
 * automatically when the agent is disposed. The built-in `write` stays in
 * place; a scoped `tools/post-execute` listener appends the fresh hashline
 * preview to write results.
 *
 * The four `tool:*` guidance sections resolve per agent preset from override
 * files in the shared home (see `src/guidance.ts`); deployments without the
 * `agentPresets` service keep the compiled defaults unchanged.
 * @module dsh-better-edit
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import { ctxFsIO } from "./fs-bridge.js";
import { FsSandboxController } from "./sandbox.js";
import { registerReadTool } from "./tool-read.js";
import { registerEditTool } from "./tool-edit.js";
import { registerBatchEditTool } from "./tool-batch-edit.js";
import { registerUndoTool } from "./tool-undo.js";
import { registerWriteHook } from "./write-hook.js";

import { initHasher } from "./hashline/hasher.js";
import {
	composeSections,
	ensurePresetGuidance,
	GUIDANCE_SECTIONS,
	type SectionOverride,
} from "./guidance.js";
import { configDir } from "./paths.js";

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

/** The four sections as compiled, byte-identical to the pre-guidance install. */
function compiledDefaultSections(): SectionOverride[] {
	return GUIDANCE_SECTIONS.map((section) => ({
		name: section.name,
		order: section.defaultOrder,
		text: section.renderDefault(),
	}));
}

/**
 * Resolve the four guidance sections for one agent. Without the `agentPresets`
 * service the fast path returns the compiled defaults untouched. With it, the
 * agent's preset id drives `composeSections` against the shared home; any
 * resolution failure degrades to compiled defaults so a bad override file can
 * never fail the install.
 */
async function resolveAgentSections(
	rootCtx: Context,
	agent: Agent,
): Promise<SectionOverride[]> {
	const agentPresets = rootCtx.get(
		"agentPresets",
	) as AgentPresetsService | undefined;
	if (!agentPresets) return compiledDefaultSections();
	try {
		const presetId = agentPresets.composedPreset(agent.ctx);
		return await composeSections(presetId, configDir());
	} catch (error) {
		rootCtx.logger.warn(
			`dsh-better-edit: guidance resolution failed for agent ${agent.id}, using compiled defaults: ${error instanceof Error ? error.message : String(error)}`,
		);
		return compiledDefaultSections();
	}
}

function installAgentTools(rootCtx: Context, agent: Agent): void {
	agent.ctx.effect(async () => {
		// `fs` is host-plane: use the plugin's own context (covered by
		// inject) rather than the agent's scoped one, whose fiber chain does
		// not declare it. Session cwd still reaches the bridge per call via
		// exec.agent.session.header.cwd.
		const io = ctxFsIO(rootCtx.fs as FileSystem, rootCtx);
		const disposers: Array<() => void> = [];
		disposers.push(registerReadTool(rootCtx, agent.ctx, io));
		const sandbox = new FsSandboxController(rootCtx);
		disposers.push(registerEditTool(rootCtx, agent.ctx, io, sandbox));
		disposers.push(registerBatchEditTool(rootCtx, agent.ctx, io, sandbox));
		disposers.push(registerUndoTool(rootCtx, agent.ctx, io, sandbox));
		disposers.push(registerWriteHook(rootCtx, agent.ctx, io));

		// Shadow the preset's built-in tool guidance with the hashline
		// contract. Same section names on the agent's own layer win over the
		// preset's; text and order come from the per-preset resolution.
		const sections = await resolveAgentSections(rootCtx, agent);
		for (const section of sections) {
			disposers.push(agent.ctx.systemPrompt.section(section));
		}

		return () => {
			for (const dispose of disposers) dispose();
		};
	});
}

/** Mount the bundle: initialize the store, then install tools per agent. */
export function apply(rootCtx: Context): void {
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
	ensurePresetGuidance(configDir()).catch((error) => {
		rootCtx.logger.warn(
			`dsh-better-edit: guidance materialization failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	});

	const registered = new WeakSet<Agent>();
	rootCtx.on("agent/session-start", ({ agent }) => {
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
