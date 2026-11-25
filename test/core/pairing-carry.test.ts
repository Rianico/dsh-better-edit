import { beforeAll, describe, expect, it } from "vitest";
import { pairLineage, pairSnapshots, type LineageLine } from "../../src/snapshot-store/pairing.js";
import { canonDigest, initHasher, rawDigest } from "../../src/hashline/hash-assign.js";

// #199: this spec is pure, so its first digest runs before the async xxhash-wasm init would
// otherwise settle on a cold runner. Await the seam explicitly, as every hashing spec does.
beforeAll(async () => {
  await initHasher();
});

/** Line-order descriptors carrying both pairing digests, as the checksum-miss alignment builds them. */
function lineage(lines: string[]): LineageLine[] {
  return lines.map((line, index) => ({
    lineNumber: index + 1,
    canonHash: canonDigest(line),
    rawHash: rawDigest(line),
  }));
}

/** Canon descriptors only — a legacy row, which carries no raw evidence. */
function legacy(lines: string[]): LineageLine[] {
  return lines.map((line, index) => ({ lineNumber: index + 1, canonHash: canonDigest(line) }));
}

function sortedPairs(pairing: Map<number, number>): [number, number][] {
  return [...pairing.entries()].sort((a, b) => a[0] - b[0]);
}

describe("pairLineage — homogeneous-run ordinal carry", () => {
  it("carries the bare 3-to-4 run: every survivor keeps its own coordinate", () => {
    expect(
      sortedPairs(pairLineage(lineage(["x", "x", "x"]), lineage(["x", "x", "x", "x"]))),
    ).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("carries a 4-to-2 shrink by ordinal and retires the overflow", () => {
    const prev = lineage(["head", "  }", "  }", "  }", "  }", "tail"]);
    const curr = lineage(["head", "  }", "  }", "tail"]);

    expect(sortedPairs(pairLineage(prev, curr))).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [6, 4],
    ]);
  });

  it("carries a 2-to-4 growth by ordinal and leaves the tail unpaired", () => {
    const prev = lineage(["head", "  }", "  }", "tail"]);
    const curr = lineage(["head", "  }", "  }", "  }", "  }", "tail"]);

    expect(sortedPairs(pairLineage(prev, curr))).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 6],
    ]);
  });

  it("never carries across an indentation change — canon equal, raw bytes not", () => {
    const prev = lineage(["head", "  }", "    }", "tail"]);
    const curr = lineage(["head", "    }", "tail"]);

    // The canon folds the edge run, so only the raw digest separates the two spellings.
    expect(canonDigest("  }")).toBe(canonDigest("    }"));
    expect(sortedPairs(pairLineage(prev, curr))).toEqual([
      [1, 1],
      [4, 3],
    ]);
  });

  it("fails closed when a legacy prior row has no raw digest", () => {
    expect(
      sortedPairs(
        pairLineage(legacy(["head", "  }", "  }", "tail"]), lineage(["head", "  }", "tail"])),
      ),
    ).toEqual([
      [1, 1],
      [4, 3],
    ]);
  });

  it("fills only gaps — every engine pair survives the carry", () => {
    const fixtures: [LineageLine[], LineageLine[]][] = [
      [lineage(["H", "x", "x", "x", "T"]), lineage(["H", "x", "x", "T"])],
      [lineage(["H", "x", "x", "T"]), lineage(["H", "x", "x", "x", "x", "T"])],
      [lineage(["A", "B", "B", "C"]), lineage(["A", "B", "C"])],
    ];

    for (const [prev, curr] of fixtures) {
      const carried = pairLineage(prev, curr);
      for (const [prevLine, currLine] of pairSnapshots(prev, curr)) {
        expect(carried.get(prevLine)).toBe(currLine);
      }
    }
  });

  it("keeps the pairing monotonic after the carry", () => {
    const pairing = pairLineage(lineage(["H", "x", "x", "x", "T"]), lineage(["H", "x", "T"]));

    // Monotonicity is a property of the pair set, not of Map insertion order: the carry appends
    // its gap pairs after the engine's, so only the prev-sorted view is ascending in curr.
    const ordered = [...pairing.entries()].sort((a, b) => a[0] - b[0]);
    let lastCurr = 0;
    for (const [prevLine, currLine] of ordered) {
      expect(prevLine).toBeGreaterThan(0);
      expect(currLine).toBeGreaterThan(lastCurr);
      lastCurr = currLine;
    }
  });

  it("behaves exactly like the engine when the prior side has no raw evidence", () => {
    const prev = legacy(["A", "A", "B"]);
    const curr = lineage(["A", "B"]);

    expect(sortedPairs(pairLineage(prev, curr))).toEqual(sortedPairs(pairSnapshots(prev, curr)));
  });
});
