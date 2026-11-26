/**
 * #144 T3 — hint mode discloses replaced unserved interior lines in the diff.
 *
 * Falsifier: the null-vs-undefined rule of `genDiff`'s optional `served` mirror. A `null` slot
 * proves the session never read that old line, so its removed row must render the empty gutter
 * (no anchor) and its line number must reach `unservedRemovedLines`; an `undefined` slot is a
 * truncated mirror whose lease outlives it, so it MUST keep the anchor. With no mirror the
 * projection is unchanged. A fold must not hide the fact either: the marker counts only the
 * hidden unserved lines, and the returned list stays ascending and cap-independent.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { genDiff } from "../../src/edit-diff.js";
import { ANCHOR_LEN, HASH_SEP, initHasher, lineHashesPure } from "../../src/hashline/index.js";
import { DIFF_REMOVED_CAP, DIFF_REMOVED_EDGE } from "../../src/constants.js";

beforeAll(async () => {
  await initHasher();
});

/** The empty gutter: a removed row with no anchor, at the same width as an anchored row. */
const BLANK = `-${" ".repeat(ANCHOR_LEN)}${HASH_SEP}`;

const THREE = "aaa\nbbb\nccc\n";
const THREE_HASHES = (): string[] => lineHashesPure(THREE);

const TEN = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
const TEN_HASHES = (): string[] => lineHashesPure(TEN);

describe("genDiff unserved removed rows (#144 T3)", () => {
  it("blanks the gutter for a removed line the session never read", () => {
    const hashes = THREE_HASHES();
    const served: (string | null)[] = [hashes[0]!, null, hashes[2]!];

    const { diff, unservedRemovedLines } = genDiff(THREE, "", 0, undefined, hashes, served);

    const rows = diff.split("\n");
    expect(rows).toEqual([
      `-${hashes[0]}${HASH_SEP}aaa`,
      `${BLANK}bbb`,
      `-${hashes[2]}${HASH_SEP}ccc`,
    ]);
    // Same width, no anchor: the blank row keeps the anchor column empty rather than shrinking.
    const blankRow = rows[1]!;
    expect(blankRow.indexOf(HASH_SEP)).toBe(1 + ANCHOR_LEN);
    expect(blankRow.length).toBe(rows[0]!.length);
    expect(unservedRemovedLines).toEqual([2]);
  });

  it("keeps anchors for a truncated mirror slot (undefined, not null)", () => {
    const hashes = THREE_HASHES();
    // The mirror stops at line 1: lines 2-3 were never *recorded*, not proven unread.
    const served: (string | null)[] = [hashes[0]!];

    const { diff, unservedRemovedLines } = genDiff(THREE, "", 0, undefined, hashes, served);

    expect(diff.split("\n")).toEqual([
      `-${hashes[0]}${HASH_SEP}aaa`,
      `-${hashes[1]}${HASH_SEP}bbb`,
      `-${hashes[2]}${HASH_SEP}ccc`,
    ]);
    expect(unservedRemovedLines).toEqual([]);
  });

  it("is unchanged when no mirror is supplied", () => {
    const hashes = THREE_HASHES();

    const { diff, unservedRemovedLines } = genDiff(THREE, "", 0, undefined, hashes);

    expect(diff.split("\n")).toEqual([
      `-${hashes[0]}${HASH_SEP}aaa`,
      `-${hashes[1]}${HASH_SEP}bbb`,
      `-${hashes[2]}${HASH_SEP}ccc`,
    ]);
    expect(unservedRemovedLines).toEqual([]);
  });

  it("leaves a fully served fold marker byte-identical", () => {
    const hashes = TEN_HASHES();
    // Precondition: ten removed lines exceed the cap, so the fold path is the one under test.
    expect(10).toBeGreaterThan(DIFF_REMOVED_CAP);

    const { diff, unservedRemovedLines } = genDiff(TEN, "", 0, undefined, hashes, hashes);

    expect(diff).toContain(` - ... [${10 - DIFF_REMOVED_EDGE * 2} lines deleted] ...`);
    expect(diff).not.toContain("unserved");
    expect(unservedRemovedLines).toEqual([]);
  });

  it("counts only the fold-hidden unserved lines on the marker", () => {
    const hashes = TEN_HASHES();
    expect(10).toBeGreaterThan(DIFF_REMOVED_CAP);
    // Old lines 3, 5 and 10 were never read; 3 and 5 fall inside the hidden span, 10 is a tail row.
    const served: (string | null)[] = hashes.map((hash, index) =>
      index === 2 || index === 4 || index === 9 ? null : hash,
    );

    const { diff, unservedRemovedLines } = genDiff(TEN, "", 0, undefined, hashes, served);

    expect(diff).toContain(" - ... [6 lines deleted] (2 unserved) ...");
    // Ascending and cap-independent: the hidden pair first, then the blanked tail row.
    expect(unservedRemovedLines).toEqual([3, 5, 10]);
    expect(diff.split("\n")).toContain(`${BLANK}l10`);
  });

  it("reports the removed old-line count independently of the fold cap and the mirror", () => {
    const hashes = TEN_HASHES();
    const allNull: (string | null)[] = hashes.map(() => null);

    const withoutMirror = genDiff(TEN, "", 2, undefined, hashes);
    const folded = genDiff(TEN, "", 2, undefined, hashes, allNull);
    const unchanged = genDiff(TEN, TEN, 2, undefined, hashes);

    // Precondition: the renderer folds this deletion, so the count cannot be a rendered-row tally.
    expect(10).toBeGreaterThan(DIFF_REMOVED_CAP);
    expect(withoutMirror.removedLineCount).toBe(10);
    expect(folded.removedLineCount).toBe(10);
    expect(unchanged.removedLineCount).toBe(0);
  });
});
