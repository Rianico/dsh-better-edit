/**
 * EncodingMigrationConsent — the one vocabulary that says whether a write may
 * convert a legacy-encoded file to UTF-8, and to which UTF-8 shape.
 *
 * WHY a leaf module of its own (no imports): three seams read the consent — the
 * `edit` payload (contract), the config (store-config), and the save decision
 * (file-encoding-state) — plus the IO bridge, the mutation transaction and the
 * two governed writers. Declaring the vocabulary here keeps that reading one
 * ladder instead of four spellings, and keeps the config-side import ring from
 * re-closing around the save seam.
 *
 * The seam it constrains: READS stay codec-agnostic (a file may be admitted as
 * utf16le, windows-1251, GBK, … and served under its own decode), but every
 * WRITE leaves as a UTF-8 text write — the deployment exposes no byte seam
 * (ADR-0012 §#112). So a consent never names "the codec to write"; it names
 * whether this write may abandon the recorded codec, and which UTF-8 shape the
 * migrated bytes get: `"utf8"` (no BOM) or `"utf8bom"` (one leading EF BB BF).
 * `"refuse"` never converts.
 *
 * @module dsh-better-edit/encoding-consent
 */

/** Every per-call and config-level spelling, in one place. */
export const ENCODING_MIGRATION_CONSENTS = ["refuse", "utf8", "utf8bom"] as const;

export type EncodingMigrationConsent = (typeof ENCODING_MIGRATION_CONSENTS)[number];

/** The two consents that convert this file; the target is UTF-8 either way. */
export type EncodingMigrationTarget = Exclude<EncodingMigrationConsent, "refuse">;

/** No consent anywhere: a legacy file that cannot be written byte-faithfully is refused. */
export const ENCODING_MIGRATION_DEFAULT: EncodingMigrationConsent = "refuse";

/** Environment override for the `allowEncodingMigration` setting; must match the config key. */
export const ENCODING_MIGRATION_ENV_VAR = "DSH_BETTER_EDIT_ALLOW_ENCODING_MIGRATION";

/** Exact, case-sensitive guard for payload and config-file values. */
export function isEncodingMigrationConsent(value: unknown): value is EncodingMigrationConsent {
  return value === "refuse" || value === "utf8" || value === "utf8bom";
}

/** Trim then match case-insensitively; empty or out-of-enum → undefined (env convenience only). */
export function parseEnvEncodingMigrationConsent(
  raw: string | undefined,
): EncodingMigrationConsent | undefined {
  if (raw === undefined) return undefined;
  const candidate = raw.trim().toLowerCase();
  return isEncodingMigrationConsent(candidate) ? candidate : undefined;
}

/** The policy rungs an unset payload falls through to. Absent means "not configured here". */
export interface EncodingMigrationPolicy {
  allowEncodingMigration?: EncodingMigrationConsent;
  normalizeToUtf8?: boolean;
}

/**
 * The one precedence ladder: payload (when present) → `allowEncodingMigration` (when present) →
 * legacy `normalizeToUtf8 === true` → `"refuse"`.
 *
 * `normalizeToUtf8: true` is the pre-#209 spelling of `"utf8"` and stays honoured; `false` is
 * not a choice, it is the pre-#209 default, so it falls through to `"refuse"` instead of
 * overriding an explicit `allowEncodingMigration`.
 */
export function resolveEncodingMigrationConsent(
  payloadValue: EncodingMigrationConsent | undefined,
  policy: EncodingMigrationPolicy,
): EncodingMigrationConsent {
  if (payloadValue !== undefined) return payloadValue;
  if (policy.allowEncodingMigration !== undefined) return policy.allowEncodingMigration;
  if (policy.normalizeToUtf8 === true) return "utf8";
  return ENCODING_MIGRATION_DEFAULT;
}

/** Exhaustiveness guard: a new consent member must be handled at every switch that maps it. */
export function assertNeverEncodingMigrationConsent(value: never): never {
  throw new Error(`Unhandled encoding-migration consent: ${String(value)}`);
}
