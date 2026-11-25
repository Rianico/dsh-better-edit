import { describe, expect, it } from "vitest";

import { buildBatchResult, type BatchSection } from "../../src/edit-response.js";

function section(overrides: Partial<BatchSection> = {}): BatchSection {
  return {
    path: "a.ts",
    originalNormalized: "alpha\nbeta\n",
    result: "alpha\nBETA\n",
    originalHashes: ["AAA", "BBB"],
    resultHashes: ["AAA", "CCC"],
    warnings: undefined,
    driftNotice: undefined,
    appliedCount: 1,
    noopCount: 0,
    totalAddedLines: 1,
    totalRemovedLines: 1,
    ...overrides,
  };
}

describe("driftNotice is omitted, never empty", () => {
  it("omits the key for a clean section", () => {
    const built = buildBatchResult([section()]);
    expect("driftNotice" in built.details).toBe(false);
  });

  it("omits the key when a section reports an empty notice", () => {
    const built = buildBatchResult([section({ driftNotice: "" })]);
    expect("driftNotice" in built.details).toBe(false);
  });

  it("keeps a real notice", () => {
    const built = buildBatchResult([section({ driftNotice: "drift: 1 line(s) changed." })]);
    expect(built.details.driftNotice).toBe("drift: 1 line(s) changed.");
  });

  it("joins one notice per file with a blank line", () => {
    const built = buildBatchResult([
      section({ driftNotice: "one" }),
      section({ path: "b.ts", driftNotice: "two" }),
    ]);
    expect(built.details.driftNotice).toBe("one\n\ntwo");
  });

  it("drops the empty section and keeps the real one", () => {
    const built = buildBatchResult([
      section({ path: "a.ts", driftNotice: "" }),
      section({ path: "b.ts", driftNotice: "drift: 2 line(s) changed." }),
    ]);
    expect(built.details.driftNotice).toBe("drift: 2 line(s) changed.");
  });
});
