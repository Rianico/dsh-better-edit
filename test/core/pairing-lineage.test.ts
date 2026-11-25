import { describe, expect, it } from "vitest";
import { pairLineage, pairSnapshots } from "../../src/snapshot-store/pairing.js";

/** Canon descriptors in line order, 1-based — the pairing engine's descriptor shape. */
function descs(canons: string[]): { lineNumber: number; canonHash: string }[] {
  return canons.map((canonHash, index) => ({ lineNumber: index + 1, canonHash }));
}

function asPairs(pairing: Map<number, number>): [number, number][] {
  return [...pairing.entries()];
}

describe("pairLineage — checksum-miss alignment entry (T1)", () => {
  it("pairs the surviving twin of a deleted duplicate by the unique pins around it", () => {
    // x a y a z -> x y a z: the FIRST twin is deleted, so the second `a` keeps its coordinate.
    expect(
      asPairs(pairLineage(descs(["X", "A", "Y", "A", "Z"]), descs(["X", "Y", "A", "Z"]))),
    ).toEqual([
      [1, 1],
      [3, 2],
      [4, 3],
      [5, 4],
    ]);
  });

  it("retires an ambiguous homogeneous shrink instead of guessing which copy survived", () => {
    // a a a b -> a a b: `b` is the only forced pin; the 3-to-2 duplicate run is ambiguous, so it
    // stays UNPAIRED and those anchors retire (the ordinal carry is T2's rule, not T1's).
    expect(asPairs(pairLineage(descs(["A", "A", "A", "B"]), descs(["A", "A", "B"])))).toEqual([
      [4, 3],
    ]);
  });

  it("pairs an identical line set completely", () => {
    expect(asPairs(pairLineage(descs(["A", "B", "C"]), descs(["A", "B", "C"])))).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("returns an empty pairing when either side is empty", () => {
    expect(pairLineage([], descs(["A"])).size).toBe(0);
    expect(pairLineage(descs(["A"]), []).size).toBe(0);
  });

  it("halts on an exhausted scan budget instead of guessing", () => {
    const prev = descs(["H", "A", "B", "T"]);
    const curr = descs(["H", "B", "A", "T"]);

    expect(pairLineage(prev, curr, { scanBudget: 1 }).size).toBe(0);
    expect(asPairs(pairLineage(prev, curr))).toEqual([
      [1, 1],
      [4, 4],
    ]);
  });

  it("is monotonic: prev line order follows curr line order", () => {
    const pairing = pairLineage(descs(["H", "A", "A", "T"]), descs(["H", "A", "T", "A"]));

    let lastCurr = 0;
    for (const [prevLine, currLine] of pairing) {
      expect(prevLine).toBeGreaterThan(0);
      expect(currLine).toBeGreaterThan(lastCurr);
      lastCurr = currLine;
    }
  });

  it("owns no rule of its own yet: it is the pin-bounded engine on the same descriptors", () => {
    const prev = descs(["H", "A", "A", "T"]);
    const curr = descs(["H", "A", "T", "A"]);

    expect(asPairs(pairLineage(prev, curr))).toEqual(asPairs(pairSnapshots(prev, curr)));
  });
});
