/**
 * Paths — thin adapter over StoreTenancy + CanonicalPath.
 * Public API preserved for compat: configDir, hashStorePath, hashStoreDir,
 * legacyHashStorePath, resolveTarget, toCwd.
 * Deep tenancy lives in StoreTenancy; canonical resolution in CanonicalPath.
 * @module dsh-better-edit/paths
 */
import { isAbsolute } from "node:path";
import { resolve as resolvePath } from "node:path";
import { expand } from "./store-tenancy.js";

export * from "./store-tenancy.js";
export { canonicalAsync as resolveTarget } from "./canonical-path.js";
export { canonicalSync } from "./canonical-path.js";

export function toCwd(filePath: string, cwd: string): string {
  const expanded = expand(filePath);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}
