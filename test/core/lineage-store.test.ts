import { describe, expect, it, beforeAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { splitLines } from "../../src/utils.js";
import {
  CANON_VERSION,
  canonDigest,
  contentChecksum,
  initHasher,
} from "../../src/hashline/hash-assign.js";
import {
  createLineageStore,
  snapshotHashFor,
  type LineageStore,
  LineageCorruptError,
} from "../../src/snapshot-store/lineage-store.js";

beforeAll(async () => {
  await initHasher();
});

function open(): { db: DatabaseSync; lineage: LineageStore } {
  const db = new DatabaseSync(":memory:");
  return { db, lineage: createLineageStore(db) };
}

function hashesFor(content: string, tag: string): string[] {
  return splitLines(content).map((_, index) => `${tag}${index}`);
}

function idsOf(lineage: LineageStore, path: string, content: string): number[] {
  return lineage.lineageFor(path, snapshotHashFor(content)).map((row) => row.lineId);
}

function commit(
  lineage: LineageStore,
  path: string,
  content: string,
  tag: string,
  leases?: { sessionKey: string; rows: { position: number; hash: string | null }[] },
): string[] {
  const hashes = hashesFor(content, tag);
  lineage.commitSnapshot({ path, content, hashes, leases });
  return hashes;
}

describe("lineage-store — first snapshot and lineage shape", () => {
  it("assigns fresh ids in line order and records canon digests", () => {
    const { lineage } = open();
    const content = "alpha\nbeta\ngamma";
    const hashes = commit(lineage, "/a.ts", content, "A");
    const rows = lineage.lineageFor("/a.ts", snapshotHashFor(content));
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.lineNumber)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.lineId)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.canonHash)).toEqual(
      splitLines(content).map((line) => canonDigest(line)),
    );
    expect(rows.map((row) => row.anchor)).toEqual(hashes);
    expect(snapshotHashFor(content)).toBe(`${CANON_VERSION}:${contentChecksum(content)}`);
  });

  it("returns [] for an unknown snapshot", () => {
    const { lineage } = open();
    expect(lineage.lineageFor("/missing.ts", "2:deadbeef")).toEqual([]);
    expect(lineage.leaseFor("s", "/missing.ts", "AAA")).toBeUndefined();
  });
});

describe("lineage-store — pairing rules", () => {
  it("rule 1+4: pure edit inherits, changed line takes a fresh id, counter continues", () => {
    const { lineage } = open();
    commit(lineage, "/a.ts", "alpha\nbeta\ngamma", "A");
    commit(lineage, "/a.ts", "alpha\nBETA\ngamma", "B");
    expect(idsOf(lineage, "/a.ts", "alpha\nBETA\ngamma")).toEqual([1, 4, 3]);
    // Counter continued past the fresh block: next fresh id is 5.
    commit(lineage, "/a.ts", "alpha\nBETA\ngamma\ndelta", "C");
    expect(idsOf(lineage, "/a.ts", "alpha\nBETA\ngamma\ndelta")).toEqual([1, 4, 3, 5]);
  });

  it("rule 1: whitespace-only edit inherits every id", () => {
    const { lineage } = open();
    commit(lineage, "/a.ts", "alpha\nbeta\ngamma", "A");
    commit(lineage, "/a.ts", "alpha\n  beta\t\ngamma", "B");
    expect(idsOf(lineage, "/a.ts", "alpha\n  beta\t\ngamma")).toEqual([1, 2, 3]);
  });

  it("rule 2: moved lines keep their identity through unique canon matches", () => {
    const { lineage } = open();
    commit(lineage, "/m.ts", "alpha\nbeta", "A");
    commit(lineage, "/m.ts", "beta\nalpha", "B");
    expect(idsOf(lineage, "/m.ts", "beta\nalpha")).toEqual([2, 1]);
  });

  it("rule 4: inserted line takes a fresh id, neighbours inherit", () => {
    const { lineage } = open();
    commit(lineage, "/i.ts", "alpha\ngamma", "A");
    commit(lineage, "/i.ts", "alpha\nbeta\ngamma", "B");
    expect(idsOf(lineage, "/i.ts", "alpha\nbeta\ngamma")).toEqual([1, 3, 2]);
  });

  it("rule 2 over shifted numbers: deleted line, survivors inherit", () => {
    const { lineage } = open();
    commit(lineage, "/d.ts", "alpha\nbeta\ngamma", "A");
    commit(lineage, "/d.ts", "alpha\ngamma", "B");
    expect(idsOf(lineage, "/d.ts", "alpha\ngamma")).toEqual([1, 3]);
  });

  it("rule 3: duplicate canon resolves to the lowest unclaimed previous line", () => {
    const { lineage } = open();
    commit(lineage, "/t.ts", "b\na\na", "A");
    // Rule 1 cannot fire (previous line 1 is "b"); both previous "a" lines
    // are unclaimed, so the lowest (line 2, id 2) wins.
    commit(lineage, "/t.ts", "a", "B");
    expect(idsOf(lineage, "/t.ts", "a")).toEqual([2]);
  });
});

describe("lineage-store — adopt on re-commit", () => {
  it("leaves the counter and lineage byte-identical, still grants leases", () => {
    const { lineage } = open();
    const content = "alpha\nbeta\ngamma";
    const hashes = commit(lineage, "/a.ts", content, "A");
    const before = JSON.stringify(lineage.lineageFor("/a.ts", snapshotHashFor(content)));
    lineage.commitSnapshot({
      path: "/a.ts",
      content,
      hashes,
      leases: { sessionKey: "s2", rows: [{ position: 1, hash: hashes[1]! }] },
    });
    expect(JSON.stringify(lineage.lineageFor("/a.ts", snapshotHashFor(content)))).toBe(before);
    // The adopted re-commit consumed no ids: the next fresh id is still 4.
    commit(lineage, "/a.ts", "alpha\nBETA\ngamma", "B");
    expect(idsOf(lineage, "/a.ts", "alpha\nBETA\ngamma")).toEqual([1, 4, 3]);
    // ...and the adopt path still granted the lease.
    const lease = lineage.leaseFor("s2", "/a.ts", hashes[1]!);
    expect(lease?.lineId).toBe(2);
    expect(lease?.lineNumber).toBe(2);
  });
});

describe("lineage-store — lease grant", () => {
  it("resolves rows to the served span", () => {
    const { lineage } = open();
    const content = "alpha\nbeta";
    const hashes = hashesFor(content, "A");
    lineage.commitSnapshot({
      path: "/a.ts",
      content,
      hashes,
      leases: {
        sessionKey: "s1",
        rows: [
          { position: 0, hash: hashes[0]! },
          { position: 1, hash: hashes[1]! },
        ],
      },
    });
    const first = lineage.leaseFor("s1", "/a.ts", hashes[0]!);
    expect(first).toEqual({
      lineId: 1,
      canonHash: canonDigest("alpha"),
      snapshotHash: snapshotHashFor(content),
      lineNumber: 1,
      retiredAt: null,
    });
    expect(lineage.leaseFor("s1", "/a.ts", hashes[1]!)?.lineNumber).toBe(2);
  });

  it("unknown anchors and null hashes grant nothing", () => {
    const { db, lineage } = open();
    const content = "alpha\nbeta";
    const hashes = hashesFor(content, "A");
    lineage.commitSnapshot({
      path: "/a.ts",
      content,
      hashes,
      leases: {
        sessionKey: "s1",
        rows: [
          { position: 0, hash: "ZZZ" },
          { position: 1, hash: null },
          { position: 0, hash: hashes[0]! },
        ],
      },
    });
    expect(lineage.leaseFor("s1", "/a.ts", "ZZZ")).toBeUndefined();
    const count = (db.prepare("SELECT COUNT(*) AS n FROM served_leases").get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it("a repeated anchor inside one batch keeps the last serve", () => {
    const { lineage } = open();
    const content = "alpha\nbeta\ngamma";
    const hashes = hashesFor(content, "A");
    lineage.commitSnapshot({
      path: "/a.ts",
      content,
      hashes,
      leases: {
        sessionKey: "s1",
        rows: [
          { position: 0, hash: hashes[0]! },
          { position: 2, hash: hashes[0]! },
        ],
      },
    });
    expect(lineage.leaseFor("s1", "/a.ts", hashes[0]!)?.lineNumber).toBe(3);
  });

  it("re-serve revives: retired_at resets to NULL", () => {
    const { db, lineage } = open();
    const content = "alpha\nbeta";
    const hashes = hashesFor(content, "A");
    lineage.commitSnapshot({
      path: "/a.ts",
      content,
      hashes,
      leases: { sessionKey: "s1", rows: [{ position: 0, hash: hashes[0]! }] },
    });
    db.exec(
      `UPDATE served_leases SET retired_at = 7 WHERE session_id = 's1' AND file_path = '/a.ts'`,
    );
    expect(lineage.leaseFor("s1", "/a.ts", hashes[0]!)?.retiredAt).toBe(7);
    lineage.commitSnapshot({
      path: "/a.ts",
      content,
      hashes,
      leases: { sessionKey: "s1", rows: [{ position: 0, hash: hashes[0]! }] },
    });
    expect(lineage.leaseFor("s1", "/a.ts", hashes[0]!)?.retiredAt).toBeNull();
  });
});

describe("lineage-store — atomicity (fault injection)", () => {
  it("a lease-write failure leaves no snapshot or lineage behind", () => {
    const { db, lineage } = open();
    db.exec(
      "CREATE TRIGGER t2b_fail BEFORE INSERT ON served_leases " +
        "BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );
    const content = "alpha\nbeta";
    const hashes = hashesFor(content, "A");
    expect(() =>
      lineage.commitSnapshot({
        path: "/a.ts",
        content,
        hashes,
        leases: { sessionKey: "s1", rows: [{ position: 0, hash: hashes[0]! }] },
      }),
    ).toThrow("injected");
    const snapshots = (
      db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }
    ).n;
    const lineageRows = (
      db.prepare("SELECT COUNT(*) AS n FROM line_lineage").get() as { n: number }
    ).n;
    expect(snapshots).toBe(0);
    expect(lineageRows).toBe(0);
  });
});

describe("lineage-store — input validation", () => {
  it("length mismatch throws before any write", () => {
    const { db, lineage } = open();
    expect(() =>
      lineage.commitSnapshot({ path: "/x.ts", content: "a\nb\nc", hashes: ["H1", "H2"] }),
    ).toThrow("2 hashes for 3 lines");
    const snapshots = (
      db.prepare("SELECT COUNT(*) AS n FROM file_snapshots").get() as { n: number }
    ).n;
    const lineageRows = (
      db.prepare("SELECT COUNT(*) AS n FROM line_lineage").get() as { n: number }
    ).n;
    const counters = (
      db.prepare("SELECT COUNT(*) AS n FROM line_id_counters").get() as { n: number }
    ).n;
    expect(snapshots).toBe(0);
    expect(lineageRows).toBe(0);
    expect(counters).toBe(0);
  });
});

describe("lineage-store — adopt refreshes anchors, never identity", () => {
  it("same content with a new assignment updates anchors only", () => {
    const { db, lineage } = open();
    const content = "alpha\nbeta\ngamma";
    const h1 = ["A0", "A1", "A2"];
    const h2 = ["B0", "B1", "B2"];
    lineage.commitSnapshot({ path: "/r.ts", content, hashes: h1 });
    const before = lineage.lineageFor("/r.ts", snapshotHashFor(content));
    expect(before.map((row) => row.anchor)).toEqual(h1);
    const counterBefore = db.prepare("SELECT * FROM line_id_counters WHERE path = ?").get("/r.ts");
    lineage.commitSnapshot({ path: "/r.ts", content, hashes: h2 });
    const after = lineage.lineageFor("/r.ts", snapshotHashFor(content));
    expect(after.map((row) => row.anchor)).toEqual(h2);
    expect(after.map((row) => row.lineId)).toEqual(before.map((row) => row.lineId));
    expect(after.map((row) => row.canonHash)).toEqual(before.map((row) => row.canonHash));
    expect(after.map((row) => row.lineNumber)).toEqual([1, 2, 3]);
    expect(db.prepare("SELECT * FROM line_id_counters WHERE path = ?").get("/r.ts")).toEqual(
      counterBefore,
    );
  });

  it("identical adopt writes nothing (compare-then-update)", () => {
    const { db, lineage } = open();
    const content = "alpha\nbeta";
    lineage.commitSnapshot({ path: "/c.ts", content, hashes: ["A0", "A1"] });
    const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    lineage.commitSnapshot({ path: "/c.ts", content, hashes: ["A0", "A1"] });
    expect(changes() - before).toBe(0);
    lineage.commitSnapshot({ path: "/c.ts", content, hashes: ["A0", "B1"] });
    expect(changes() - before).toBe(1);
  });

  it("adopt with emptied lineage throws instead of silently no-oping", () => {
    const { db, lineage } = open();
    const content = "alpha\nbeta";
    lineage.commitSnapshot({ path: "/e.ts", content, hashes: ["A0", "A1"] });
    db.exec("DELETE FROM line_lineage");
    expect(() => lineage.commitSnapshot({ path: "/e.ts", content, hashes: ["B0", "B1"] })).toThrow(
      LineageCorruptError,
    );
  });

  it("leases granted with reassignment resolve by anchor through the refreshed lineage", () => {
    const { lineage } = open();
    const content = "alpha\nbeta";
    lineage.commitSnapshot({ path: "/h.ts", content, hashes: ["A0", "A1"] });
    // Two commits: H1, then H2 carrying the leases — refresh and grant couple in
    // one transaction. The served position (0) deliberately disagrees with the
    // anchor's line (2): a position-based grant would resolve line 1 instead.
    lineage.commitSnapshot({
      path: "/h.ts",
      content,
      hashes: ["B0", "B1"],
      leases: {
        sessionKey: "s",
        rows: [
          { position: 0, hash: "B1" },
          { position: 1, hash: "A1" },
        ],
      },
    });
    const lease = lineage.leaseFor("s", "/h.ts", "B1");
    expect(lease).toBeDefined();
    expect(lease?.lineId).toBe(2);
    expect(lease?.canonHash).toBe(canonDigest("beta"));
    expect(lease?.lineNumber).toBe(1);
    // The stale H1 row was attempted in this very batch and granted nothing.
    expect(lineage.leaseFor("s", "/h.ts", "A1")).toBeUndefined();
  });

  it("sparse stored lineage throws instead of silently no-oping", () => {
    const { db, lineage } = open();
    const content = "alpha\nbeta";
    lineage.commitSnapshot({ path: "/s.ts", content, hashes: ["A0", "A1"] });
    // Corrupt out-of-band: keep the row count but shift numbering (1,2 -> 11,12).
    db.exec("UPDATE line_lineage SET line_number = line_number + 10");
    expect(() => lineage.commitSnapshot({ path: "/s.ts", content, hashes: ["B0", "B1"] })).toThrow(
      "out of order",
    );
  });
});

describe("lineage-store — retirement on snapshot resolution", () => {
  it("leases absent from the resolved snapshot retire; survivors stay live", () => {
    const { lineage } = open();
    const contentA = "alpha\nbeta\ngamma";
    const contentB = "alpha\ngamma";
    lineage.commitSnapshot({
      path: "/p.ts",
      content: contentA,
      hashes: ["A0", "A1", "A2"],
      leases: {
        sessionKey: "s",
        rows: [
          { position: 0, hash: "A0" },
          { position: 1, hash: "A1" },
          { position: 2, hash: "A2" },
        ],
      },
    });
    // Edit drops the beta line: pure snapshot commit, no new leases — the grant
    // and the retirement couple in the one transaction either way.
    lineage.commitSnapshot({ path: "/p.ts", content: contentB, hashes: ["B0", "B2"] });
    const beta = lineage.leaseFor("s", "/p.ts", "A1");
    expect(beta).toBeDefined();
    expect(beta?.retiredAt).not.toBeNull();
    expect(lineage.leaseFor("s", "/p.ts", "A0")?.retiredAt).toBeNull();
    expect(lineage.leaseFor("s", "/p.ts", "A2")?.retiredAt).toBeNull();
  });

  it("a retire-write failure rolls back the whole snapshot commit", () => {
    const { db, lineage } = open();
    lineage.commitSnapshot({
      path: "/q.ts",
      content: "alpha\nbeta",
      hashes: ["A0", "A1"],
      leases: { sessionKey: "s", rows: [{ position: 1, hash: "A1" }] },
    });
    db.exec(
      "CREATE TRIGGER t2b_retire BEFORE UPDATE OF retired_at ON served_leases " +
        "BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );
    // Dropping beta must retire A1's lease: the trigger aborts the retire, so
    // the B snapshot must be absent — atomicity, not best-effort.
    expect(() =>
      lineage.commitSnapshot({ path: "/q.ts", content: "alpha", hashes: ["B0"] }),
    ).toThrow("injected");
    const snaps = (
      db
        .prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE snapshot_hash = ?")
        .get(snapshotHashFor("alpha")) as { n: number }
    ).n;
    expect(snaps).toBe(0);
  });
});
