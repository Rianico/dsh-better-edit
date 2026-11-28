/**
 * Regression corpus for duplicate-line anchor pairing in `genDiff` (issue #151).
 *
 * Downstream port of pi-better-edit@1ba3186 (branch 7fa4a7d), the fix for upstream #326:
 * `Diff.diffLines` pairs byte-identical text lines by position; to it, two equal lines are
 * interchangeable. Production anchors are NOT interchangeable: `mapStableHashes` reuses each
 * surviving line's pre-edit anchor, so the same text at a different position carries a different
 * identity, and the removed line's anchor is retired. These fixtures derive both hash arrays the
 * way the mutation pipeline does (`lineHashesPure` for the pre-edit side, `mapStableHashes` with
 * the retired anchors blocked for the post-edit side) and assert every rendered row names the true
 * line identity at its position.
 */
import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import { genDiff } from "../../src/edit-diff.js";
import {
  ANCHOR_LEN,
  HASH_SEP,
  initHasher,
  lineHashesPure,
  mapStableHashes,
} from "../../src/hashline/index.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

const CONTEXT = 2;

interface Case {
  readonly oldContent: string;
  readonly newContent: string;
  /** Pre-edit line indexes (0-based) whose anchors the edit retires. */
  readonly removedIndexes: readonly number[];
}

interface HashPair {
  readonly oldHashes: string[];
  readonly newHashes: string[];
}

/** Derive anchors exactly as the mutation pipeline does: survivor reuse against the retired set. */
function pairHashes(fixture: Case): HashPair {
  const oldHashes = lineHashesPure(fixture.oldContent);
  const removedHashes = new Set(fixture.removedIndexes.map((index) => oldHashes[index]!));
  const newHashes = mapStableHashes(
    fixture.oldContent,
    oldHashes,
    fixture.newContent,
    removedHashes,
  );
  return { oldHashes, newHashes };
}

interface Row {
  readonly prefix: " " | "-" | "+";
  readonly anchor: string;
  readonly text: string;
}

const UNTOUCHED_MARKER = /^ \.\.\. \[\d+ lines untouched\] \.\.\.$/;
const DELETED_MARKER = /^ - \.\.\. \[\d+ lines deleted\] \.\.\.$/;
const ROW = new RegExp(`^([ +-])([A-Za-z0-9]{${ANCHOR_LEN}})${HASH_SEP}(.*)$`);
const READ_ROW = new RegExp(`^([A-Za-z0-9]{${ANCHOR_LEN}})${HASH_SEP}(.*)$`);

/** Parse rendered rows as prefix + anchor + text. Markers carry no identity. */
function parseRows(diff: string): Row[] {
  return diff
    .split("\n")
    .filter((line) => line !== " ..." && !UNTOUCHED_MARKER.test(line) && !DELETED_MARKER.test(line))
    .map((line) => ROW.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      prefix: match[1] as Row["prefix"],
      anchor: match[2]!,
      text: match[3]!,
    }));
}

const renderRows = (diff: string): string[] => diff.split("\n");

function removedAnchorsOf(diff: string): string[] {
  return parseRows(diff)
    .filter((row) => row.prefix === "-")
    .map((row) => row.anchor);
}

/** A line identity belongs to exactly one side of the projection: never both removed and kept. */
function expectNoAnchorSpansBothSides(diff: string, label: string): void {
  const rows = parseRows(diff);
  const kept = new Set(rows.filter((row) => row.prefix !== "-").map((row) => row.anchor));
  for (const row of rows) {
    if (row.prefix !== "-") continue;
    expect(
      kept.has(row.anchor),
      `${label}: anchor ${row.anchor} is rendered both as a kept row and as a removed row`,
    ).toBe(false);
  }
}

/** Every removed row names a line identity that no longer exists in the post-edit content. */
function expectRemovedAnchorsRetired(
  diff: string,
  newHashes: readonly string[],
  label: string,
): void {
  for (const anchor of removedAnchorsOf(diff)) {
    expect(
      newHashes,
      `${label}: removed anchor ${anchor} still names a post-edit line`,
    ).not.toContain(anchor);
  }
}

describe("duplicate-line anchor pairing (#151)", () => {
  it("(a) replacing the first of two identical lines retires its anchor and keeps the survivor's", () => {
    const fixture: Case = {
      oldContent: "header\ndup\ndup\nfooter\n",
      newContent: "header\nchanged\ndup\nfooter\n",
      removedIndexes: [1],
    };
    const { oldHashes, newHashes } = pairHashes(fixture);
    const [h0, a, b, h3] = oldHashes as [string, string, string, string];
    const [n0, fresh, n2, n3] = newHashes as [string, string, string, string];

    expect(a, "(a): duplicate anchors must differ for the pairing to be observable").not.toBe(b);
    expect([n0, n2, n3], "(a): survivors keep their pre-edit anchors").toEqual([h0, b, h3]);
    expect([a, b, h0, h3], "(a): the replaced line's anchor is retired").not.toContain(fresh);

    const { diff } = genDiff(fixture.oldContent, fixture.newContent, CONTEXT, newHashes, oldHashes);

    expect(renderRows(diff), `(a) rendered rows:\n${diff}`).toEqual([
      ` ${h0}│header`,
      `-${a}│dup`,
      `+${fresh}│changed`,
      ` ${b}│dup`,
      ` ${h3}│footer`,
    ]);
    expectNoAnchorSpansBothSides(diff, "(a)");
    expectRemovedAnchorsRetired(diff, newHashes, "(a)");
    expect(removedAnchorsOf(diff), "(a): the removed row names the replaced line").toEqual([a]);
  });

  it("(b) replacing the second of two identical lines retires its anchor and keeps the survivor's", () => {
    const fixture: Case = {
      oldContent: "header\ndup\ndup\nfooter\n",
      newContent: "header\ndup\nchanged\nfooter\n",
      removedIndexes: [2],
    };
    const { oldHashes, newHashes } = pairHashes(fixture);
    const [h0, a, b, h3] = oldHashes as [string, string, string, string];
    const [n0, n1, fresh, n3] = newHashes as [string, string, string, string];

    expect(n1, "(b): the surviving first duplicate keeps its anchor").toBe(a);
    expect([n0, n3], "(b): untouched lines keep their anchors").toEqual([h0, h3]);

    const { diff } = genDiff(fixture.oldContent, fixture.newContent, CONTEXT, newHashes, oldHashes);

    expect(renderRows(diff), `(b) rendered rows:\n${diff}`).toEqual([
      ` ${h0}│header`,
      ` ${a}│dup`,
      `-${b}│dup`,
      `+${fresh}│changed`,
      ` ${h3}│footer`,
    ]);
    expectNoAnchorSpansBothSides(diff, "(b)");
    expectRemovedAnchorsRetired(diff, newHashes, "(b)");
    expect(removedAnchorsOf(diff), "(b): the removed row names the replaced line").toEqual([b]);
  });

  it("(b2) mirror of (a): the edit retires the FIRST duplicate while the survivor stays earlier in the file", () => {
    const fixture: Case = {
      oldContent: "header\ndup\ndup\nfooter\n",
      newContent: "header\ndup\nchanged\nfooter\n",
      removedIndexes: [1],
    };
    const { oldHashes, newHashes } = pairHashes(fixture);
    const [h0, a, b, h3] = oldHashes as [string, string, string, string];
    const [n0, n1, fresh, n3] = newHashes as [string, string, string, string];

    expect(n1, "(b2): the surviving second duplicate keeps its anchor").toBe(b);
    expect([n0, n3], "(b2): untouched lines keep their anchors").toEqual([h0, h3]);

    const { diff } = genDiff(fixture.oldContent, fixture.newContent, CONTEXT, newHashes, oldHashes);

    expect(renderRows(diff), `(b2) rendered rows:\n${diff}`).toEqual([
      ` ${h0}│header`,
      `-${a}│dup`,
      ` ${b}│dup`,
      `+${fresh}│changed`,
      ` ${h3}│footer`,
    ]);
    expectNoAnchorSpansBothSides(diff, "(b2)");
    expectRemovedAnchorsRetired(diff, newHashes, "(b2)");
    expect(removedAnchorsOf(diff), "(b2): the removed row names the retired duplicate").toEqual([
      a,
    ]);
  });

  it("(c) deleting a range that holds one of two identical blank lines keeps the survivor's anchor", () => {
    const fixture: Case = {
      oldContent: "alpha\nbeta\n\ncharlie\ndelta\n\necho\n",
      newContent: "alpha\n\necho\n",
      removedIndexes: [1, 2, 3, 4],
    };
    const { oldHashes, newHashes } = pairHashes(fixture);
    const [h0, h1, h2, h3, h4, h5, h6] = oldHashes as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const [n0, n1, n2] = newHashes as [string, string, string];

    expect(h2, "(c): the two blank lines must carry distinct anchors").not.toBe(h5);
    expect([n0, n1, n2], "(c): the surviving blank keeps its own anchor").toEqual([h0, h5, h6]);

    const { diff } = genDiff(fixture.oldContent, fixture.newContent, CONTEXT, newHashes, oldHashes);

    expect(renderRows(diff), `(c) rendered rows:\n${diff}`).toEqual([
      ` ${h0}│alpha`,
      `-${h1}│beta`,
      `-${h2}│`,
      `-${h3}│charlie`,
      `-${h4}│delta`,
      ` ${h5}│`,
      ` ${h6}│echo`,
    ]);
    expectNoAnchorSpansBothSides(diff, "(c)");
    expectRemovedAnchorsRetired(diff, newHashes, "(c)");
    expect(removedAnchorsOf(diff), "(c): removed rows stay in pre-edit order").toEqual([
      h1,
      h2,
      h3,
      h4,
    ]);
  });

  it("(e) keeps the Myers pairing when the two sides share no line identity", () => {
    const oldHashes = ["aa1", "bb2", "ee5"];
    const newHashes = ["cc3", "dd4"];

    const { diff, servedRows } = genDiff("a\nb\nx\n", "a\nb\n", CONTEXT, newHashes, oldHashes);

    expect(renderRows(diff), `(e) rendered rows:\n${diff}`).toEqual([
      ` ${newHashes[0]}│a`,
      ` ${newHashes[1]}│b`,
      `-${oldHashes[2]}│x`,
    ]);
    expect(servedRows).toEqual([
      { position: 0, hash: newHashes[0] },
      { position: 1, hash: newHashes[1] },
    ]);
  });

  describe("(d) duplicate lines through the real read/edit/undo tools", () => {
    const ORIGINAL = "header\ndup\ndup\nfooter\n";

    type ReadRow = { readonly anchor: string; readonly text: string };

    function readRows(text: string): ReadRow[] {
      return text
        .split("\n")
        .map((line) => READ_ROW.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({ anchor: match[1]!, text: match[2]! }));
    }

    function toolRows(text: string): Row[] {
      return text
        .split("\n")
        .map((line) => ROW.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({
          prefix: match[1] as Row["prefix"],
          anchor: match[2]!,
          text: match[3]!,
        }));
    }

    function duplicateAnchors(text: string): [string, string] {
      const dups = readRows(text).filter((row) => row.text === "dup");
      expect(dups, "(d): the fixture serves two duplicate rows").toHaveLength(2);
      const [first, second] = [dups[0]!.anchor, dups[1]!.anchor];
      expect(first, "(d): the duplicate anchors must differ").not.toBe(second);
      return [first, second];
    }

    it("(d1) chained edit: the removed row names the replaced duplicate, the context row resolves the next edit", async () => {
      await withTempFile("duplicates.txt", ORIGINAL, async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
        const read = await harness.readTool.execute("read", { path: "duplicates.txt" });
        const [replaced, survivor] = duplicateAnchors(getText(read));

        const applied = await harness.editTool.execute("edit", {
          file: "duplicates.txt",
          edits: [{ anchor_from: replaced, anchor_to: replaced, replace_with: "changed" }],
        });
        const appliedText = getText(applied);
        const rows = toolRows(appliedText);

        expect(removedAnchorsOf(appliedText), "(d1): the removed row is the replaced line").toEqual(
          [replaced],
        );
        const contextDup = rows.find((row) => row.prefix === " " && row.text === "dup");
        expect(contextDup?.anchor, "(d1): the context row keeps the survivor's anchor").toBe(
          survivor,
        );
        expect(
          rows.filter((row) => row.prefix !== "-").map((row) => row.anchor),
          "(d1): the retired anchor must not survive in any kept row",
        ).not.toContain(replaced);

        await harness.editTool.execute("edit", {
          file: "duplicates.txt",
          edits: [
            {
              anchor_from: contextDup!.anchor,
              anchor_to: contextDup!.anchor,
              replace_with: "DUP",
            },
          ],
        });
        expect(await readFile(path, "utf-8")).toBe("header\nchanged\nDUP\nfooter\n");
      });
    });

    it("(d2) exact undo: the revert restores both duplicates byte-identically and names the survivor as context", async () => {
      await withTempFile("undo-duplicates.txt", ORIGINAL, async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
        const read = await harness.readTool.execute("read", { path: "undo-duplicates.txt" });
        const [replaced, survivor] = duplicateAnchors(getText(read));

        await harness.editTool.execute("edit", {
          file: "undo-duplicates.txt",
          edits: [{ anchor_from: replaced, anchor_to: replaced, replace_with: "changed" }],
        });

        const undone = await harness.undoTool.execute("undo", { path: "undo-duplicates.txt" });
        const undoneText = getText(undone);

        expect(await readFile(path, "utf-8"), "(d2): undo restores the exact bytes").toBe(ORIGINAL);
        expect(
          removedAnchorsOf(undoneText),
          "(d2): the surviving duplicate is not removed",
        ).not.toContain(survivor);
        expect(undoneText, "(d2): the retired duplicate comes back as an addition").toContain(
          `+${replaced}│dup`,
        );
        const contextDup = toolRows(undoneText).find(
          (row) => row.prefix === " " && row.text === "dup",
        );
        expect(contextDup?.anchor, "(d2): the surviving duplicate keeps its anchor").toBe(survivor);

        const reread = await harness.readTool.execute("read", { path: "undo-duplicates.txt" });
        expect(
          duplicateAnchors(getText(reread)),
          "(d2): undo restores the pre-edit anchors",
        ).toEqual([replaced, survivor]);
      });
    });

    it("(d3) exact undo of a range deletion: the deleted blank returns under its own anchor, the survivor stays context", async () => {
      const original = "alpha\nbeta\n\ncharlie\ndelta\n\necho\n";
      await withTempFile("undo-range.txt", original, async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
        const read = await harness.readTool.execute("read", { path: "undo-range.txt" });
        const served = readRows(getText(read));
        const anchorOf = (text: string): string => {
          const row = served.find((candidate) => candidate.text === text);
          expect(row, `(d3): served rows did not contain ${JSON.stringify(text)}`).toBeDefined();
          return row!.anchor;
        };
        const beta = anchorOf("beta");
        const delta = anchorOf("delta");
        const blanks = served.filter((row) => row.text === "");
        expect(blanks, "(d3): the fixture serves two blanks").toHaveLength(2);
        const [deletedBlank, survivingBlank] = [blanks[0]!.anchor, blanks[1]!.anchor];
        expect(deletedBlank, "(d3): the blanks must carry distinct anchors").not.toBe(
          survivingBlank,
        );

        await harness.editTool.execute("edit", {
          file: "undo-range.txt",
          edits: [{ anchor_from: beta, anchor_to: delta, replace_with: "" }],
        });
        expect(await readFile(path, "utf-8")).toBe("alpha\n\necho\n");

        const undone = await harness.undoTool.execute("undo", { path: "undo-range.txt" });
        const undoneText = getText(undone);

        expect(await readFile(path, "utf-8"), "(d3): undo restores the exact bytes").toBe(original);
        expect(undoneText, "(d3): the deleted blank returns under its own anchor").toContain(
          `+${deletedBlank}│`,
        );
        expect(
          removedAnchorsOf(undoneText),
          "(d3): the surviving blank is never rendered as removed",
        ).not.toContain(survivingBlank);
        const contextBlank = toolRows(undoneText).find(
          (row) => row.prefix === " " && row.text === "",
        );
        expect(contextBlank?.anchor, "(d3): the surviving blank keeps its anchor").toBe(
          survivingBlank,
        );
      });
    });
  });
});
