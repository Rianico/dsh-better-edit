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
 * - Two more `BEGIN IMMEDIATE` sites exist on a store handle, but both are PRE-STORE
 *   only and can never nest under this owner: `snapshot-store/migrate.ts:67` (fresh
 *   handle during `openStore`) and `hash-store.ts:471` (`migrateForward`, during
 *   `buildStore`, before any store object exists). A grep-auditor counts three BEGIN
 *   sites in total; exactly one of them is reachable from a live store.
 *
 * Retry policy (shared `withBusyRetry`, store-retry): this owner retries the two
 * ACQUISITION points — `BEGIN IMMEDIATE` (lock acquisition) and `COMMIT` (lock
 * release; a busy COMMIT leaves the transaction open and is retryable). It does NOT
 * retry the body: statement-level retry belongs to the family that owns the
 * statement. `hash-store`'s `stmts` wrappers and `snapshot-store/index.ts` wrap each
 * `.run`, and `lineage-store.ts` wraps all ten of its own `.run` sites. Each
 * acquisition point therefore gets up to 4 attempts (`BUSY_RETRIES = 3` in
 * `store-retry.ts`) with the shared 100 ms backoff; the body is attempted once.
 * @module dsh-better-edit/snapshot-store/txn
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
  // Retry the ACQUISITION points only. Statement-level retry belongs to the family
  // that owns the statement (hash-store's `stmts` wrappers, snapshot-store/index.ts,
  // lineage-store.ts), so re-running the whole body here would multiply attempts 4x
  // and duplicate work the inner retry had already rolled back.
  withBusyRetry(() => {
    db.exec("BEGIN IMMEDIATE");
  });
  try {
    fn();
    // COMMIT is the lock release: a busy COMMIT leaves the transaction open.
    withBusyRetry(() => {
      db.exec("COMMIT");
    });
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      console.warn(rollbackError); // best-effort rollback; the original error propagates
    }
    throw error;
  }
}
