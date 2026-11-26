import { beforeAll, describe, expect, it } from "vitest";
import { genDiff } from "../../src/edit-diff.js";
import { lineHashesPure, initHasher } from "../../src/hashline/index.js";

beforeAll(async () => {
  await initHasher();
});

const rowFor = (diff: string, text: string): string | undefined =>
  diff.split("\n").find((line) => line.endsWith(`│${text}`));

const isUntouchedMarker = (line: string): boolean =>
  /^ \.\.\. \[\d+ lines untouched\] \.\.\.$/.test(line);
const isDeletedMarker = (line: string): boolean =>
  /^ - \.\.\. \[\d+ lines deleted\] \.\.\.$/.test(line);
const markers = (diff: string): number =>
  diff
    .split("\n")
    .filter((line) => line === " ..." || isUntouchedMarker(line) || isDeletedMarker(line)).length;

describe("genDiff gap trimming (#166)", () => {
  it("renders a 6-line middle gap whole at context 4 with true anchors after the gap", () => {
    const gap = ["g1", "g2", "g3", "g4", "g5", "g6"];
    const oldContent = ["a", "b", ...gap, "c", "d"].join("\n") + "\n";
    const newContent = ["a", "B", ...gap, "C", "d"].join("\n") + "\n";
    const hashes = lineHashesPure(newContent);

    const { diff } = genDiff(oldContent, newContent, 4, hashes);

    expect(markers(diff)).toBe(0);
    expect(rowFor(diff, "b")).toBe("-   │b");
    expect(rowFor(diff, "B")).toBe(`+${hashes[1]}│B`);
    gap.forEach((line, i) => {
      expect(rowFor(diff, line)).toBe(` ${hashes[i + 2]}│${line}`);
    });
    expect(rowFor(diff, "c")).toBe("-   │c");
    expect(rowFor(diff, "C")).toBe(`+${hashes[8]}│C`);
    expect(rowFor(diff, "d")).toBe(` ${hashes[9]}│d`);
  });

  it("renders a 2-line middle gap whole at context 1 with aligned anchors", () => {
    const oldContent = ["a", "b", "g1", "g2", "c", "d"].join("\n") + "\n";
    const newContent = ["a", "B", "g1", "g2", "C", "d"].join("\n") + "\n";
    const hashes = lineHashesPure(newContent);

    const { diff } = genDiff(oldContent, newContent, 1, hashes);

    expect(markers(diff)).toBe(0);
    expect(rowFor(diff, "g1")).toBe(` ${hashes[2]}│g1`);
    expect(rowFor(diff, "g2")).toBe(` ${hashes[3]}│g2`);
    expect(rowFor(diff, "C")).toBe(`+${hashes[4]}│C`);
    expect(rowFor(diff, "d")).toBe(` ${hashes[5]}│d`);
  });

  it("renders a gap of exactly 2×context whole", () => {
    const gap = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"];
    const oldContent = ["a", "b", ...gap, "c", "d"].join("\n") + "\n";
    const newContent = ["a", "B", ...gap, "C", "d"].join("\n") + "\n";
    const hashes = lineHashesPure(newContent);

    const { diff } = genDiff(oldContent, newContent, 4, hashes);

    expect(markers(diff)).toBe(0);
    expect(rowFor(diff, "g8")).toBe(` ${hashes[9]}│g8`);
    expect(rowFor(diff, "C")).toBe(`+${hashes[10]}│C`);
    expect(rowFor(diff, "d")).toBe(` ${hashes[11]}│d`);
  });

  it("collapses a gap of 2×context+1 behind a single marker and keeps later anchors aligned", () => {
    const gap = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9"];
    const oldContent = ["a", "b", ...gap, "c", "d"].join("\n") + "\n";
    const newContent = ["a", "B", ...gap, "C", "d"].join("\n") + "\n";
    const hashes = lineHashesPure(newContent);

    const { diff, servedRows } = genDiff(oldContent, newContent, 4, hashes);

    expect(markers(diff)).toBe(1);
    expect(diff.split("\n")).toContain(" ... [1 lines untouched] ...");
    expect(rowFor(diff, "g1")).toBe(` ${hashes[2]}│g1`);
    expect(rowFor(diff, "g4")).toBe(` ${hashes[5]}│g4`);
    expect(rowFor(diff, "g5")).toBeUndefined();
    expect(rowFor(diff, "g6")).toBe(` ${hashes[7]}│g6`);
    expect(rowFor(diff, "g9")).toBe(` ${hashes[10]}│g9`);
    expect(rowFor(diff, "C")).toBe(`+${hashes[11]}│C`);
    expect(rowFor(diff, "d")).toBe(` ${hashes[12]}│d`);

    const renderedPositions = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12];
    expect(servedRows.map((r) => r.position)).toEqual(renderedPositions);
    expect(servedRows.every((r) => r.hash === hashes[r.position])).toBe(true);
    expect(servedRows.some((r) => r.hash === hashes[6])).toBe(false);
    expect(servedRows.some((r) => r.position === 6)).toBe(false);
    expect(servedRows.some((r) => r.position === 11 && r.hash === hashes[11])).toBe(true);
  });

  it("renders a middle gap marker-only at context 0 with exact skip accounting (#170)", () => {
    const gap = ["g1", "g2", "g3", "g4", "g5"];
    const oldContent = ["a", "b", ...gap, "c", "d"].join("\n") + "\n";
    const newContent = ["a", "B", ...gap, "C", "d"].join("\n") + "\n";
    const newHashes = lineHashesPure(newContent);
    const oldHashes = lineHashesPure(oldContent);

    const { diff, servedRows } = genDiff(oldContent, newContent, 0, newHashes, oldHashes);

    expect(diff).toBe(
      [
        " ...",
        `-${oldHashes[1]}│b`,
        `+${newHashes[1]}│B`,
        " ... [5 lines untouched] ...",
        `-${oldHashes[7]}│c`,
        `+${newHashes[7]}│C`,
      ].join("\n"),
    );
    gap.forEach((line) => expect(rowFor(diff, line)).toBeUndefined());
    expect(rowFor(diff, "d")).toBeUndefined();
    expect(servedRows).toEqual([
      { position: 1, hash: newHashes[1] },
      { position: 7, hash: newHashes[7] },
    ]);
  });

  it("trims a trailing gap to contextLines without any marker", () => {
    const tail = ["t1", "t2", "t3", "t4", "t5", "t6"];
    const oldContent = ["a", ...tail].join("\n") + "\n";
    const newContent = ["A", ...tail].join("\n") + "\n";
    const hashes = lineHashesPure(newContent);

    const { diff } = genDiff(oldContent, newContent, 2, hashes);

    expect(markers(diff)).toBe(0);
    expect(rowFor(diff, "t1")).toBe(` ${hashes[1]}│t1`);
    expect(rowFor(diff, "t2")).toBe(` ${hashes[2]}│t2`);
    expect(rowFor(diff, "t3")).toBeUndefined();
    expect(rowFor(diff, "t6")).toBeUndefined();
  });

  it("keeps anchors aligned across a small gap followed by a collapsed gap", () => {
    const small = ["g1", "g2", "g3", "g4", "g5"];
    const big = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"];
    const oldContent = ["a", "b", ...small, "c", ...big, "d", "e"].join("\n") + "\n";
    const newContent = ["a", "B", ...small, "C", ...big, "D", "e"].join("\n") + "\n";
    const hashes = lineHashesPure(newContent);

    const { diff } = genDiff(oldContent, newContent, 4, hashes);

    expect(markers(diff)).toBe(1);
    expect(rowFor(diff, "B")).toBe(`+${hashes[1]}│B`);
    small.forEach((line, i) => {
      expect(rowFor(diff, line)).toBe(` ${hashes[i + 2]}│${line}`);
    });
    expect(rowFor(diff, "C")).toBe(`+${hashes[7]}│C`);
    expect(rowFor(diff, "G1")).toBe(` ${hashes[8]}│G1`);
    expect(rowFor(diff, "G5")).toBeUndefined();
    expect(rowFor(diff, "G9")).toBe(` ${hashes[16]}│G9`);
    expect(rowFor(diff, "D")).toBe(`+${hashes[17]}│D`);
    expect(rowFor(diff, "e")).toBe(` ${hashes[18]}│e`);
  });
});
