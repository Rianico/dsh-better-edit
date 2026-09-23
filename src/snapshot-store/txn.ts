/**
 * The single re-entrant transaction owner for the store's `DatabaseSync` handle.
 *
 * Why one owner: SQLite throws `cannot start a transaction within a transaction`
 * on a nested `BEGIN`. Every writer reachable from a live store therefore routes
 * through this function, and the nesting contract below is the whole policy.
 *
 * Nesting contract:
 * - Exactly one `BEGIN IMMEDIATE` site is reachable from a live store: the
 *   non-nested branch of this function. `hash-store`'s `withStore` / undo pair
 *   and `lineage-store`'s `commitSnapshot` all delegate here.
 * - A nested caller (same handle already inside a transaction) joins the outer
 *   unit: `fn` runs directly, with no BEGIN / COMMIT / ROLLBACK of its own.
 * - A nested failure propagates to the outermost owner, which is the only place
 *   that rolls back. Inner callers never swallow the error — swallowing would let
 *   the outer COMMIT persist a half-written pair.
 * - `snapshot-store/migrate.ts` keeps its own `BEGIN IMMEDIATE`: it runs on a
 *   fresh handle during `openStore`, before any store object exists, so it can
 *   never nest under this owner.
 *
 * Retry policy is the shared `withBusyRetry` (store-retry), applied to the
 * `BEGIN IMMEDIATE` acquisition only: statements inside `fn` retry themselves,
 * so retrying the body here would multiply attempts and duplicate work.
 * @module dsh-better-edit/snapshot-store/txn
 */
import { DatabaseSync } from "node:sqlite";
import { withBusyRetry } from "../store-retry.js";

/** Run `fn` in one transaction on `db`, or join the transaction already open on it. */
export function withTransaction(db: DatabaseSync, fn: () => void): void {
  if (db.isTransaction) {
    fn();
    return;
  }
  // Retry the ACQUISITION only. Every statement inside `fn` carries its own
  // `withBusyRetry` (the store's row-family wrappers), so re-running the whole
  // body on an already-exhausted busy error would multiply attempts 4x and
  // duplicate side effects that the inner retry had already rolled back.
  withBusyRetry(() => {
    db.exec("BEGIN IMMEDIATE");
  });
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      console.warn(rollbackError); // best-effort rollback; the original error propagates
    }
    throw error;
  }
}
