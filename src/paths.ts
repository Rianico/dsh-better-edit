/**
 * Paths — thin adapter over StoreTenancy + CanonicalPath.
 * Carries only what its consumers name: `resolveTarget`/`canonicalSync`
 * (canonical resolution, owned by CanonicalPath) and `toCwd` (workspace joins
 * over `expand`).
 *
 * Store facts (`configDir`, `hashStorePath`, `hashStoreDir`,
 * `legacyHashStorePath`, lifecycle hooks) are deliberately NOT re-exported
 * here: they live in `store-tenancy`/`store-lifecycle`, and re-exporting the
 * store barrel from this file closed the cycle
 * `paths → store/index → store-lifecycle → paths`. Name the owning leaf.
 * @module dsh-better-edit/paths
 */
import { isAbsolute } from "node:path";
import { resolve as resolvePath } from "node:path";
import { expand } from "./store-tenancy.js";

export { canonicalAsync as resolveTarget } from "./canonical-path.js";
export { canonicalSync } from "./canonical-path.js";

export function toCwd(filePath: string, cwd: string): string {
  const expanded = expand(filePath);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}
