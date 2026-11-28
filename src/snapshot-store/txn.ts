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
 */
import { withBusyRetry } from "../store-retry.js";

/**
 * The port this owner needs — and nothing more. `DatabaseSync` satisfies it
 * structurally, so every caller is unchanged. Narrowness is the point: the owner
 * cannot prepare statements, read rows, or close handles, and the retry policy can
 * be driven by a plain-object fake instead of a real handle.
 */
export interface TxnHandle {
  readonly isTransaction: boolean;
  exec(sql: string): void;
}

/** Run `fn` in one transaction on `db`, or join the transaction already open on it. */
export function withTransaction(db: TxnHandle, fn: () => void): void {
  if (db.isTransaction) {
    fn();
    return;
  }
  withBusyRetry(() => {
    db.exec("BEGIN IMMEDIATE");
  });
  try {
    fn();
    withBusyRetry(() => {
      db.exec("COMMIT");
    });
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      console.warn(rollbackError);
    }
    throw error;
  }
}
