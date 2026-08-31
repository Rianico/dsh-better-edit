/**
 * Store — deep module owning tenancy + lifecycle + path resolution.
 *
 * Single seam that answers "which store, where, and is it open?"
 * Tenancy (where DB lives) and lifecycle (central GC + row TTL + WAL)
 * are private details of this seam; hash-store keeps only schema +
 * row-family domain logic and imports path resolution from here.
 * StoreConfig remains the config complement seam but its path is
 * resolved via this Store seam.
 *
 * YAGNI-gated: DB plumbing (openDb/buildStore/quarantine/busy-retry/
 * WAL/legacy JSON migration) stays in hash-store for now and is
 * re-exported here for testability without importing domain helpers
 * — full plumbing move is deferred to avoid contract risk. Old
 * store-tenancy/store-lifecycle files are kept as compat shims
 * re-exporting from this seam (reversible).
 *
 * @module dsh-better-edit/store
 */

// Tenancy — re-export as seam ownership (private details, public via Store)
export {
  tenancyFor,
  configDir,
  hashStorePath,
  hashStoreDir,
  legacyHashStorePath,
  loadConfig,
  _resetConfigCache,
  expand,
} from "../store-tenancy.js";
export type { Tenancy, StoreConfig } from "../store-tenancy.js";

// Lifecycle — re-export as seam ownership
export {
  onStoreOpen,
  onAppStart,
  onSessionStart,
  setStoresGetter,
  runCentralJanitorIfDue,
  _resetLifecycleForTests,
} from "../store-lifecycle.js";

// StoreConfig path helper — canonical Store seam entry for config consumers
export { loadConfig as loadStoreConfig } from "../store-config.js";

// Hash-store plumbing re-exported for testability without domain coupling
// (future: move openDb/buildStore/quarantine/busy-retry here)
export {
  isCorruptionError,
  loadHashStore,
  shutdownHashStore,
  withStore,
  findSnapshotPathsByHashes,
  upsertSnapshotFor,
} from "../hash-store.js";
export type { HashStore, InternalHashStore, ServedPersistence } from "../hash-store.js";
