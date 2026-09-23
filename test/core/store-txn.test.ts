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
 *    is the only one that rolls back" half of the documented contract).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { withTransaction } from "../../src/snapshot-store/txn.js";

function open(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (v TEXT)");
  return db;
}

function rows(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
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
});
