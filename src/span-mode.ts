/**
 * SpanMode — the one member of the config surface the served-span policy names.
 *
 * WHY a module of its own: the resolver owns the served-span policy for edit
 * payloads — "hint" (default) serves the span for verification, "strict"
 * rejects an edit whose span drifted. It stays a leaf (no imports) so later
 * tickets read `loadConfig().spanMode` instead of re-parsing YAML or env, and
 * no config-side import ring can re-close around it.
 *
 * @module dsh-better-edit/span-mode
 */

export type SpanMode = "hint" | "strict";

export const SPAN_MODE_ENV_VAR = "DSH_BETTER_EDIT_SPAN_MODE";
export const SPAN_MODE_DEFAULT: SpanMode = "hint";

export function isSpanMode(value: unknown): value is SpanMode {
  return value === "hint" || value === "strict";
}

/** Trim then match case-sensitively; anything else (including empty/undefined) → undefined. */
export function parseSpanMode(raw: string | undefined): SpanMode | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return isSpanMode(trimmed) ? trimmed : undefined;
}
