/**
 * Store — seam VIEW over tenancy + lifecycle + path resolution.
 *
 * Single seam that answers "which store, where, and is it open?" for its
 * consumers. This file owns no behaviour: every export below is a re-export
 * of code owned by a leaf module.
 *
 * Ownership direction, stated once and not to be inverted:
 */

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

export {
  onStoreOpen,
  onAppStart,
  onSessionStart,
  setStoresGetter,
  runCentralJanitorIfDue,
  _resetLifecycleForTests,
} from "../store-lifecycle.js";

export {
  isCorruptionError,
  loadHashStore,
  shutdownHashStore,
  withStore,
  upsertSnapshotFor,
} from "../hash-store.js";
export type { HashStore, InternalHashStore, ServedPersistence } from "../hash-store.js";
