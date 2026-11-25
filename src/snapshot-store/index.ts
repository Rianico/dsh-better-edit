/**
 * The snapshot family's module entry.
 *
 * The legacy `snapshots` table is a v6 SHELL (ADR-0016): kept at its exact v6 shape for a v6
 * process, never read or written by v7. v7 snapshots live in `file_snapshots` + `line_lineage`
 * (`./lineage-store.js`), keyed by the epoch-carrying `snapshot_hash`.
 *
 * This entry owns the hash-list validator shared by every row family and the retention surface
 * (`./vacuum.js`, re-exported so consumers never reach into the eviction module directly). See
 * `./vacuum.js` for the policy constants.
 * @module dsh-better-edit/snapshot-store
 */
import { HASH_RE } from "../hashline/hash-assign.js";

export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  return true;
}

// WHY: the vacuum budgets are the store's retention policy constants, so the module entry keeps
// them on the public surface; consumers must never reach into the eviction module directly.
export { reportVacuum, vacuumSnapshots } from "./vacuum.js";
export type { VacuumOptions, VacuumResult } from "./vacuum.js";
export {
  VACUUM_GLOBAL_BUDGET_BYTES,
  VACUUM_SOFT_OVERFLOW_BYTES,
  VACUUM_PER_PATH_BUDGET_BYTES,
  VACUUM_MAX_SNAPSHOTS_PER_PATH,
  VACUUM_MIN_SNAPSHOTS_PER_PATH,
  VACUUM_LINEAGE_BYTES_PER_LINE,
  VACUUM_RETIRED_PIN_MS,
  REPORT_CONTEXT_CAP,
} from "./vacuum.js";
// The checksum-miss alignment reads the prior lineage through the store surface; the module entry
// re-exports its row shape so consumers never reach into the lineage module directly.
export type { LineageRow } from "./lineage-store.js";
