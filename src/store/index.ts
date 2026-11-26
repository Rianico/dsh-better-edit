/**
 * Store — seam VIEW over tenancy + lifecycle + path resolution.
 *
 * Single seam that answers "which store, where, and is it open?" for its
 * consumers. This file owns no behaviour: every export below is a re-export
 * of code owned by a leaf module.
 *
 * Ownership direction, stated once and not to be inverted:
 * `store-config` → `store-tenancy` → this barrel, and `hash-store` → this
 * barrel. The leaves hold the code — `store-tenancy` resolves where the DB
 * lives and imports `loadConfig` FROM `store-config`, which resolves its own
 * path through `resolveDshHome` — while this file is the view they surface
 * through.
 *
 * YAGNI-gated: DB plumbing (openDb/buildStore/quarantine/busy-retry/
 * WAL/legacy JSON migration) stays in hash-store for now and is
 * re-exported here for testability without importing domain helpers
 * — full plumbing move is deferred to avoid contract risk.
 *
 * @module dsh-better-edit/store
 */

// Tenancy — re-exported from its owner (`store-tenancy`), surfaced here
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

// Lifecycle — re-exported from its owner (`store-lifecycle`)
export {
  onStoreOpen,
  onAppStart,
  onSessionStart,
  setStoresGetter,
  runCentralJanitorIfDue,
  _resetLifecycleForTests,
} from "../store-lifecycle.js";

// Hash-store plumbing re-exported for testability without domain coupling
// (future: move openDb/buildStore/quarantine/busy-retry here)
export {
  isCorruptionError,
  loadHashStore,
  releaseHashStore,
  shutdownHashStore,
  withStore,
  upsertSnapshotFor,
} from "../hash-store.js";
export type { HashStore, InternalHashStore, ServedPersistence } from "../hash-store.js";
