/**
 * Direct tests for the single re-entrant transaction owner
 * (`src/snapshot-store/txn.ts`). Every live-store writer delegates to it, so these
 * pin the contract itself rather than an incidental caller:
 *
 * 1. join — a nested call runs inside the outer unit instead of raising
 *    `cannot start a transaction within a transaction`;
 * 2. outer owns rollback — a nested throw rolls the whole unit back and propagates;
 * 3. inner does not roll back — a nested throw caught inside the outer `fn` still
 *    commits the outer work (the "inner callers never swallow; the outermost owner
 *    is the only one that rolls back" half of the documented contract);
 * 4. retry policy, against a plain-object fake — busy BEGIN, busy COMMIT, exhausted busy
 *    COMMIT, and a non-busy COMMIT error: exactly two acquisition points, at most 4
 *    attempts each, and the body attempted once.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { withTransaction, type TxnHandle } from "../../src/snapshot-store/txn.js";

function open(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (v TEXT)");
  return db;
}

function rows(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
}

/**
 * A plain-object `TxnHandle`: no cast, no mock library. It records every `exec` and can
 * be told to throw a busy error (`errcode: 5` — the code `store-retry.ts#isBusyError`
 * matches) on the first N `BEGIN IMMEDIATE` / `COMMIT` calls, or a non-busy error on
 * every `COMMIT`. `isTransaction` is a getter so the interface's `readonly` stays honest
 * while the closure owns the mutable state.
 */
function fakeHandle(
  options: { busyBegins?: number; busyCommits?: number; nonBusyCommitError?: Error } = {},
): { handle: TxnHandle; execs: string[] } {
  const execs: string[] = [];
  let busyBegins = options.busyBegins ?? 0;
  let busyCommits = options.busyCommits ?? 0;
  let inTransaction = false;
  const handle: TxnHandle = {
    get isTransaction(): boolean {
      return inTransaction;
    },
    exec(sql: string): void {
      execs.push(sql);
      if (sql === "BEGIN IMMEDIATE") {
        if (busyBegins > 0) {
          busyBegins--;
          throw busyError();
        }
        inTransaction = true;
        return;
      }
      if (sql === "COMMIT") {
        if (options.nonBusyCommitError !== undefined) throw options.nonBusyCommitError;
        if (busyCommits > 0) {
          busyCommits--;
          throw busyError();
        }
        inTransaction = false;
        return;
      }
      if (sql === "ROLLBACK") inTransaction = false;
    },
  };
  return { handle, execs };
}

/** SQLITE_BUSY, in the shape `store-retry.ts#isBusyError` matches. */
function busyError(): Error {
  return Object.assign(new Error("database is locked"), { errcode: 5 });
}
describe("store-txn — withTransaction re-entrancy contract", () => {
  it("join: a nested call runs inside the outer unit and does not raise", () => {
    const db = open();
    let innerSawOpenTransaction = false;
    withTransaction(db, () => {
      db.prepare("INSERT INTO t (v) VALUES (?)").run("outer");
      expect(db.isTransaction).toBe(true);
      withTransaction(db, () => {
        innerSawOpenTransaction = db.isTransaction;
        db.prepare("INSERT INTO t (v) VALUES (?)").run("inner");
      });
    });
    expect(innerSawOpenTransaction).toBe(true);
    expect(db.isTransaction).toBe(false);
    expect(rows(db)).toBe(2);
    db.close();
  });

  it("outer owns rollback: a nested throw rolls the whole unit back and propagates", () => {
    const db = open();
    expect(() =>
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?)").run("outer");
        withTransaction(db, () => {
          throw new Error("inner-boom");
        });
      }),
    ).toThrow("inner-boom");
    // Row contract first: the outer unit's write must be gone, not merely invisible.
    expect(rows(db)).toBe(0);
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it("inner does not roll back: catching the nested throw still commits the outer work", () => {
    const db = open();
    withTransaction(db, () => {
      db.prepare("INSERT INTO t (v) VALUES (?)").run("outer");
      try {
        withTransaction(db, () => {
          throw new Error("inner-boom");
        });
      } catch {
        // Swallowed by the CALLER of the nested call, never by the owner: the
        // nested branch has no ROLLBACK of its own.
      }
      db.prepare("INSERT INTO t (v) VALUES (?)").run("after");
    });
    expect(db.isTransaction).toBe(false);
    expect(rows(db)).toBe(2);
    db.close();
  });

  it("retries a busy COMMIT once and returns", () => {
    const { handle, execs } = fakeHandle({ busyCommits: 1 });
    let bodyRuns = 0;
    withTransaction(handle, () => {
      bodyRuns++;
    });
    expect(execs.filter((sql) => sql === "COMMIT")).toHaveLength(2);
    expect(bodyRuns).toBe(1); // the body is never retried
    expect(handle.isTransaction).toBe(false);
  });

  it("retries a busy BEGIN once", () => {
    const { handle, execs } = fakeHandle({ busyBegins: 1 });
    let bodyRuns = 0;
    withTransaction(handle, () => {
      bodyRuns++;
    });
    expect(execs.filter((sql) => sql === "BEGIN IMMEDIATE")).toHaveLength(2);
    expect(bodyRuns).toBe(1);
    expect(handle.isTransaction).toBe(false);
  });

  it("a non-busy COMMIT error propagates and the unit rolls back", () => {
    const boom = new Error("disk I/O error");
    const { handle, execs } = fakeHandle({ nonBusyCommitError: boom });
    expect(() => withTransaction(handle, () => {})).toThrow(boom);
    expect(execs).toEqual(["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
    expect(handle.isTransaction).toBe(false);
  });

  it("an exhausted busy COMMIT throws after 4 attempts and rolls back", () => {
    const { handle, execs } = fakeHandle({ busyCommits: Number.POSITIVE_INFINITY });
    expect(() => withTransaction(handle, () => {})).toThrow(/locked/i);
    expect(execs.filter((sql) => sql === "COMMIT")).toHaveLength(4);
    expect(execs.at(-1)).toBe("ROLLBACK");
    expect(handle.isTransaction).toBe(false);
  });
});
