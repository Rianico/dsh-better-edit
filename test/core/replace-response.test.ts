import { describe, expect, it } from "vitest";
import { buildNoop, finalizeResult } from "../../src/edit-response.js";
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

describe("finalizeResult", () => {
  it("returns the diff alone when nothing else is present", () => {
    const text = finalizeResult({ diff: "+a\n-b" });
    expect(text).toBe("+a\n-b");
  });

  it("appends a warnings block after the diff", () => {
    const text = finalizeResult({ diff: "+a\n-b", warnings: ["W1", "W2"] });
    expect(text).toBe("+a\n-b\n\nW1\nW2");
  });

  it("appends the drift notice after the diff", () => {
    const text = finalizeResult({ diff: "+a", driftNotice: "drift: ..." });
    expect(text).toBe("+a");
  });

  it("orders diff, warnings, then drift notice", () => {
    const text = finalizeResult({
      diff: "+a",
      warnings: ["W1"],
      driftNotice: "drift: ...",
    });
    expect(text).toBe("+a\n\nW1");
  });

  it("ignores an empty warnings array", () => {
    const text = finalizeResult({ diff: "+a", warnings: [] });
    expect(text).toBe("+a");
  });
});
