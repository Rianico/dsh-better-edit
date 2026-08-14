import { describe, expect, it } from "vitest";
import { buildNoop, buildChanged, finalizeResult } from "../../src/edit-response.js";
import { lineHashes } from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("buildNoop", () => {
  it("returns noop result with classification", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, addedLines: 0, removedLines: 0 },
      warnings: undefined,
    });
    expect(result.content[0].text).toContain("No changes made to test.txt");
    expect(result.details.classification).toBe("noop");
    expect(result.details.metrics!.edits_attempted).toBe(1);
  });

  it("includes noop edit details when provided", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: { loc: "ABC", currentContent: "old" },
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, addedLines: 0, removedLines: 0 },
      warnings: undefined,
    });
    expect(result.content[0].text).toContain("Edit for ABC");
    expect(result.content[0].text).toContain("ABC");
  });

  it("includes warnings when provided", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, addedLines: 0, removedLines: 0 },
      warnings: ["Warning 1"],
    });
    expect(result.details.metrics!.warnings).toBe(1);
    expect(result.details.warnings).toEqual(["Warning 1"]);
  });

  it("clips long currentContent in noop details", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: { loc: "ABC", currentContent: "old\n".repeat(300) },
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, addedLines: 0, removedLines: 0 },
      warnings: undefined,
    });
    expect(result.content[0].text).toContain("Edit for ABC");
    expect(result.content[0].text).not.toContain("old\n".repeat(300));
    expect(result.content[0].text).toContain("...");
  });
});

describe("buildChanged", () => {
  it("returns applied result with diff and metrics", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 2, addedLines: 1, removedLines: 1 },
    });
    expect(output.content[0].text).toContain("Successfully edited in test.txt");
    expect(output.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    expect(output.details.metrics!.classification).toBe("applied");
    expect(output.details.metrics!.edits_attempted).toBe(1);
    expect(output.details.metrics!.changed_lines).toEqual({ first: 2, last: 2 });
  });

  it("includes warnings when provided", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: ["Boundary duplication (leading)"],
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 2, addedLines: 1, removedLines: 1 },
    });
    expect(output.content[0].text).toContain("Warnings:");
    expect(output.content[0].text).toContain("Boundary duplication (leading)");
    expect(output.details.warnings).toEqual(["Boundary duplication (leading)"]);
  });

  it("shows empty file message when result is empty", async () => {
    const original = "aaa\nbbb\n";
    const result = "";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 1, lastChangedLine: 2, addedLines: 0, removedLines: 2 },
    });
    expect(output.content[0].text).toBe("File is empty. Use edit to insert content.");
  });

  it("computes added_lines and removed_lines from editMeta", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nCCC\nDDD\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 4, addedLines: 3, removedLines: 2 },
    });
    expect(output.details.metrics!.added_lines).toBe(3);
    expect(output.details.metrics!.removed_lines).toBe(2);
    expect(output.content[0].text).toContain("Added 3 line(s), removed 2 line(s).");
  });

  it("handles no changed lines gracefully", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nbbb\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, firstChangedLine: undefined, lastChangedLine: undefined, addedLines: 0, removedLines: 0 },
    });
    expect(output.details.metrics!.added_lines).toBe(0);
    expect(output.details.metrics!.removed_lines).toBe(0);
  });

  it("shows exactly one context line above and below the change in the diff", async () => {
    const original = "aaa\nbbb\nccc\nddd\neee\n";
    const result = "aaa\nbbb\nCCC\nddd\neee\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 3, lastChangedLine: 3, addedLines: 1, removedLines: 1 },
    });
    const diff = output.details.diff!;
    expect(diff).toContain("│bbb");
    expect(diff).toContain("│CCC");
    expect(diff).toContain("│ddd");
    expect(diff).not.toContain("│aaa");
    expect(diff).not.toContain("│eee");
  });
});

describe("finalizeResult", () => {
  it("returns the diff alone when nothing else is present", () => {
    const text = finalizeResult({ diff: "+a\n-b" });
    expect(text).toBe("+a\n-b");
  });

  it("appends a warnings block after the diff", () => {
    const text = finalizeResult({ diff: "+a\n-b", warnings: ["W1", "W2"] });
    expect(text).toBe("+a\n-b\n\nWarnings:\nW1\nW2");
  });

  it("appends the drift notice after the diff", () => {
    const text = finalizeResult({ diff: "+a", driftNotice: "Drift notice: ..." });
    expect(text).toBe("+a\n\nDrift notice: ...");
  });

  it("orders diff, warnings, then drift notice", () => {
    const text = finalizeResult({
      diff: "+a",
      warnings: ["W1"],
      driftNotice: "Drift notice: ...",
    });
    expect(text).toBe("+a\n\nWarnings:\nW1\n\nDrift notice: ...");
  });

  it("ignores an empty warnings array", () => {
    const text = finalizeResult({ diff: "+a", warnings: [] });
    expect(text).toBe("+a");
  });
});
