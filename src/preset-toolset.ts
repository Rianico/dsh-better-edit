/**
 * Preset tool-policy gate: which hashline-owned tools one agent install may
 * register. The registry cannot enforce a preset's policy for this plugin —
 * scope restrictions filter only *inherited* tools, never a scope's own
 * registrations (Rianico/dsh-better-edit#110) — so the install consults the
 * composed preset's own layer instead.
 *
 * `read` is unconditional: it is the plugin's core capability and the source of
 * every anchor. Every mutating tool is installed only when the preset's layer
 * resolves the matching tool, which keeps `edit` paired with `read` and never
 * shadows a tool the preset did not compose.
 *
 * The probe is an optional-service seam: no `agentPresets` service, no composed
 * preset (preset-free composition), or no scope-read API (`acquireScope` on
 * 0.2.x, `standingKeyFor` on older registries) keeps today's unconditional
 * install, so a host that predates 0.2.1 keeps its pre-gate behavior.
 * @module dsh-better-edit/preset-toolset
 */

import type { Context } from "@deepseek-ai/cordis";

/** The hashline-owned tools one install may register. `read` is always installed. */
export interface HashlineToolset {
  /** The hashline `edit` (also gates `undo`). */
  edit: boolean;
  /** The governed `str_replace_editor` shadow (ADR-0015). */
  strReplaceEditor: boolean;
  /** `undo_last_edit` — follows {@link HashlineToolset.edit}, see {@link toolsetFor}. */
  undo: boolean;
  /** A preset that neither resolves `write` nor composed one needs no guard. */
  writeHook: boolean;
}

/** Today's install — the fallback for every composition the gate cannot read. */
export const UNCONDITIONAL_TOOLSET: HashlineToolset = {
  edit: true,
  strReplaceEditor: true,
  undo: true,
  writeHook: true,
};

const EDIT_SECTION = "tool:edit";
const UNDO_SECTION = "tool:undo_last_edit";

/**
 * Derive the toolset from one predicate over preset tool names. `undo` follows
 * `edit` because `undo_last_edit` reverts only hashline edits: installing it
 * beside no `edit` would advertise a history that can never exist.
 */
export function toolsetFor(resolves: (name: string) => boolean): HashlineToolset {
  const edit = resolves("edit");
  return {
    edit,
    strReplaceEditor: resolves("str_replace_editor"),
    undo: edit,
    writeHook: resolves("write"),
  };
}

/**
 * Keep only the guidance sections whose tool was installed. `tool:read` always
 * stays; the edit and undo sections follow their tools so the prompt never
 * advertises a catalog entry the agent does not have.
 */
export function sectionsForToolset<T extends { name: string }>(
  sections: readonly T[],
  toolset: HashlineToolset,
): T[] {
  return sections.filter((section) => {
    if (section.name === EDIT_SECTION) return toolset.edit;
    if (section.name === UNDO_SECTION) return toolset.undo;
    return true;
  });
}

/** The host surface the probe touches; `logger` is optional so a bare host works. */
export interface PresetProbeHost {
  get(service: string): object | undefined;
  logger?: { warn(message: string): void };
}

/** Opaque scope key, handed back to the registry unchanged (dsh `ScopeKey`). */
type ToolScopeKey = object;

/**
 * Minimal view of the optional `agentPresets` service (dsh-agent-presets).
 *
 * Both scope reads are ASYNCHRONOUS on every supported host — `acquireScope`
 * returns `Promise<{ key } & AsyncDisposable>` on
 * `dsh-agent-preset-registry@0.2.1-rc.2` / `0.2.2-rc.1`, and `standingKeyFor`
 * returns `Promise<ScopeKey>` on `dsh-agent-presets@0.1.5-rc.3`. The unions keep
 * a synchronous stub acceptable, but every value is awaited before use.
 */
interface PresetScopeService {
  composedPreset(agentCtx: Context): string | undefined;
  /** 0.2.x shape: a disposable lease whose `key` addresses the preset's layer. */
  acquireScope?(id?: string): PresetScopeLease | Promise<PresetScopeLease | undefined> | undefined;
  /** Pre-0.2.1 shape: the standing scope key itself, no lease to release. */
  standingKeyFor?(id?: string): ToolScopeKey | Promise<ToolScopeKey | undefined> | undefined;
}

/** The `acquireScope` lease; only its key and its release hook are read here. */
interface PresetScopeLease {
  key?: ToolScopeKey;
}

/** Minimal view of the tool registry: `get(name, scope)` resolves one scope's view. */
interface ToolRegistryLike {
  get(name: string, scope?: ToolScopeKey): object | undefined;
}

interface PresetScope {
  key: ToolScopeKey;
  release(): Promise<void>;
}

const ASYNC_DISPOSE: symbol | undefined = (Symbol as { asyncDispose?: symbol }).asyncDispose;

function warn(host: PresetProbeHost, message: string): void {
  try {
    host.logger?.warn(message);
  } catch {
    // Diagnostics must never fail an install.
  }
}

/**
 * Resolve the toolset for one agent from its composed preset. Every failure —
 * a missing service, an unreadable preset, a rejected scope read, or a throwing
 * registry — falls back to {@link UNCONDITIONAL_TOOLSET} (and warns), never to a
 * smaller set: the gate may only ever remove a tool it has positively seen the
 * preset decline.
 */
export async function resolveToolset(
  host: PresetProbeHost,
  agentCtx: Context,
): Promise<HashlineToolset> {
  try {
    return (await probePreset(host, agentCtx)) ?? UNCONDITIONAL_TOOLSET;
  } catch (error) {
    warn(
      host,
      `dsh-better-edit: preset tool policy probe failed, installing the full tool set: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return UNCONDITIONAL_TOOLSET;
  }
}

/** `undefined` means "no usable preset policy" — the caller installs today's set. */
async function probePreset(
  host: PresetProbeHost,
  agentCtx: Context,
): Promise<HashlineToolset | undefined> {
  const presets = host.get("agentPresets") as PresetScopeService | undefined;
  if (!presets || typeof presets.composedPreset !== "function") return undefined;
  const presetId = presets.composedPreset(agentCtx);
  // Preset-free composition: nothing composed the agent plane, so there is no
  // preset policy to honour.
  if (typeof presetId !== "string" || presetId.length === 0) return undefined;
  const tools = host.get("tools") as ToolRegistryLike | undefined;
  if (!tools || typeof tools.get !== "function") return undefined;
  const scope = await readPresetScope(presets, presetId, host);
  if (scope === undefined) return undefined;
  try {
    return toolsetFor((name) => tools.get(name, scope.key) !== undefined);
  } finally {
    // Exactly one release, and only for a lease whose key was usable.
    await scope.release();
  }
}

/**
 * Feature-detect the scope read: `acquireScope` (0.2.x, leased) first, then
 * `standingKeyFor` (older, unleased). Neither means a pre-gate host. Both are
 * awaited — on every supported host they resolve a promise, and reading `.key`
 * off an unresolved promise would silently degrade the gate to the full set.
 */
async function readPresetScope(
  presets: PresetScopeService,
  presetId: string,
  host: PresetProbeHost,
): Promise<PresetScope | undefined> {
  if (typeof presets.acquireScope === "function") {
    const lease = await presets.acquireScope(presetId);
    // A lease without a key is unusable: fall through (and release nothing,
    // since no probe ever ran under it).
    if (lease !== undefined && lease.key !== undefined) {
      const key = lease.key;
      return { key, release: () => disposeLease(lease, host) };
    }
  }
  if (typeof presets.standingKeyFor === "function") {
    const key = await presets.standingKeyFor(presetId);
    if (key !== undefined) return { key, release: async () => {} };
  }
  return undefined;
}

/**
 * Release an `acquireScope` lease. Best effort by design: the probe answer
 * already stands, so a failed release must not change which tools install.
 */
async function disposeLease(lease: PresetScopeLease, host: PresetProbeHost): Promise<void> {
  if (ASYNC_DISPOSE === undefined) return;
  const dispose = (lease as Record<symbol, (() => unknown) | undefined>)[ASYNC_DISPOSE];
  if (typeof dispose !== "function") return;
  try {
    await dispose.call(lease);
  } catch (error) {
    warn(
      host,
      `dsh-better-edit: releasing the preset scope lease failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
