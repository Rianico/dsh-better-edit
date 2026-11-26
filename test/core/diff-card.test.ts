import { beforeAll, describe, expect, it } from "vitest";
import { buildBatchResult } from "../../src/edit-response.js";
import { lineHashes } from "../../src/hashline/index.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

beforeAll(async () => {
  await initHasher();
});

describe("diff card — buildBatchResult", () => {
  it("renders per-file headers inside fenced diff for batch edits", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);

    const out = buildBatchResult([
      {
        path: "a.txt",
        originalNormalized: original,
        result,
        originalHashes,
        resultHashes,
        warnings: undefined,
        driftNotice: undefined,
        appliedCount: 1,
        noopCount: 0,
        totalAddedLines: 1,
        totalRemovedLines: 1,
      },
      {
        path: "b.txt",
        originalNormalized: original,
        result,
        originalHashes,
        resultHashes,
        warnings: undefined,
        driftNotice: undefined,
        appliedCount: 1,
        noopCount: 0,
        totalAddedLines: 1,
        totalRemovedLines: 1,
      },
    ]);

    const text = out.content[0]!.text;
    expect(text).toContain("Successfully edited 2 file(s)");
    expect(text).toContain("```diff");
    expect(text).toContain("--- a.txt ---");
    expect(text).toContain("--- b.txt ---");
    expect(out.details.diff).toContain("--- a.txt ---");
  });

  it("still truncates batch diffs when combined size exceeds limits", async () => {
    const orig = Array.from({ length: 300 }, (_, i) => `orig ${i}`).join("\n") + "\n";
    const res = Array.from({ length: 300 }, (_, i) => `changed ${i}`).join("\n") + "\n";
    const oh = await lineHashes(orig, home.testPath);
    const rh = await lineHashes(res, home.testPath);

    const out = buildBatchResult([
      {
        path: "x.txt",
        originalNormalized: orig,
        result: res,
        originalHashes: oh,
        resultHashes: rh,
        warnings: undefined,
        driftNotice: undefined,
        appliedCount: 1,
        noopCount: 0,
        totalAddedLines: 300,
        totalRemovedLines: 300,
      },
      {
        path: "y.txt",
        originalNormalized: orig,
        result: res,
        originalHashes: oh,
        resultHashes: rh,
        warnings: undefined,
        driftNotice: undefined,
        appliedCount: 1,
        noopCount: 0,
        totalAddedLines: 300,
        totalRemovedLines: 300,
      },
    ]);

    expect(out.content[0]!.text).toContain("```diff");
    expect(out.content[0]!.text).toContain("[Diff truncated:");
  });
});
