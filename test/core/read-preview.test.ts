import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES } from "../../src/file-view.js";
import { fmtReadPreview } from "../../src/file-view.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("fmtReadPreview", () => {
  it("returns empty file marker for empty content", async () => {
    const result = await fmtReadPreview("", {}, undefined, home.testPath);
    expect(result.text).toContain("[File is empty. Use edit to insert content.]");
  });

  it("returns empty file marker for content with only newline", async () => {
    const result = await fmtReadPreview("\n", {}, undefined, home.testPath);
    expect(result.text).toMatch(/^[A-Za-z0-9]{3}│$/);
  });

  it("returns all lines when no offset or limit given", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", {}, undefined, home.testPath);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).toContain("│c");
  });

  it("respects offset parameter", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { offset: 2 }, undefined, home.testPath);
    expect(result.text).toContain("│b");
    expect(result.text).toContain("│c");
    expect(result.text).not.toContain("│a");
  });

  it("respects limit parameter", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { limit: 2 }, undefined, home.testPath);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).not.toContain("│c");
  });

  it("shows pagination hint when limit is less than total lines", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { limit: 2 }, undefined, home.testPath);
    expect(result.text).toContain("[Showing lines 1-2 of 3. Use offset=3 to continue.]");
  });

  it("shows pagination hint when offset is beyond start", async () => {
    const result = await fmtReadPreview(
      "a\nb\nc\nd\n",
      { offset: 2, limit: 2 },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("[Showing lines 2-3 of 4. Use offset=4 to continue.]");
  });

  it("rejects non-positive offset", async () => {
    await expect(
      fmtReadPreview("a\nb\nc\n", { offset: 0 } as any, undefined, home.testPath),
    ).rejects.toThrow("positive integer");
  });

  it("rejects non-positive limit", async () => {
    await expect(
      fmtReadPreview("a\nb\nc\n", { limit: 0 } as any, undefined, home.testPath),
    ).rejects.toThrow("positive integer");
  });

  it("uses precomputed hashes when provided", async () => {
    const hashes = ["AAA", "BBB", "CCC"];
    const result = await fmtReadPreview("a\nb\nc\n", {}, hashes, home.testPath);
    expect(result.text).toContain("AAA│a");
    expect(result.text).toContain("BBB│b");
    expect(result.text).toContain("CCC│c");
  });

  it("skips an oversized first line and shows the rest with a neutral notice (auto-read budget)", async () => {
    const big = "X".repeat(60_000);
    const result = await fmtReadPreview(
      `${big}\na\nb\n`,
      {},
      undefined,
      home.testPath,
      DEFAULT_MAX_BYTES,
    );
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).not.toContain("│X");
    expect(result.text).toContain("[Line 1: 58.6KB; not shown.]");
    expect(result.text).toContain(
      "[Line 1 exceeds the 50.0KB limit; the read tool cannot show it.]",
    );
  });

  it("marks an oversized middle line while keeping its neighbors hashable (auto-read budget)", async () => {
    const big = "Y".repeat(60_000);
    const result = await fmtReadPreview(
      `a\n${big}\nc\n`,
      {},
      undefined,
      home.testPath,
      DEFAULT_MAX_BYTES,
    );
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│c");
    expect(result.text).not.toContain("│Y");
    expect(result.text).toContain("[Line 2:");
  });

  it("returns only the warning when every line is oversized (auto-read budget)", async () => {
    const big = "Z".repeat(60_000);
    const result = await fmtReadPreview(
      `${big}\n`,
      {},
      undefined,
      home.testPath,
      DEFAULT_MAX_BYTES,
    );
    expect(result.text).not.toMatch(/[A-Za-z0-9]{3}│/);
    expect(result.text).toContain("exceeds the 50.0KB limit");
    expect(result.text).toContain("the read tool cannot show it");
    expect(result.nextOffset).toBeUndefined();
  });

  it("offers continuation past a skipped oversized line", async () => {
    const big = "W".repeat(210_000);
    const content = ["a", big, "b", "c", "d", "e"].join("\n");
    const result = await fmtReadPreview(content, { limit: 3 }, undefined, home.testPath);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).not.toContain("│W");
    expect(result.text).toContain("[Line 2:");
    expect(result.nextOffset).toBe(4);
    expect(result.text).toContain("[Showing lines 1-3 of 6. Use offset=4 to continue.]");
  });

  it("shows a 60KB line in full by default", async () => {
    const big = "V".repeat(60_000);
    const result = await fmtReadPreview(`${big}\nb\n`, {}, undefined, home.testPath);
    expect(result.text).toMatch(new RegExp(`^[A-Za-z0-9]{3}│V{60000}\n[A-Za-z0-9]{3}│b$`));
    expect(result.text).not.toContain("content not shown");
  });

  it("shows a line just under 200KB in full by default", async () => {
    const big = "U".repeat(204_700);
    const result = await fmtReadPreview(`${big}\n`, {}, undefined, home.testPath);
    expect(result.text).toMatch(new RegExp(`^[A-Za-z0-9]{3}│U{204700}$`));
    expect(result.text).not.toContain("content not shown");
  });

  it("marks lines over 200KB by default", async () => {
    const big = "T".repeat(210_000);
    const result = await fmtReadPreview(`${big}\n`, {}, undefined, home.testPath);
    expect(result.text).not.toMatch(/[A-Za-z0-9]{3}│/);
    expect(result.text).toContain("exceeds the 200.0KB limit");
    expect(result.text).toContain("[Line 1: 205.1KB; not shown.]");
    expect(result.text).toContain("the read tool cannot show it");
    expect(result.nextOffset).toBeUndefined();
  });

  it("states oversized lines without naming a shell or a path placeholder", async () => {
    const content = `a\n${"X".repeat(60_000)}\nb\n`;
    const result = await fmtReadPreview(content, {}, undefined, home.testPath, DEFAULT_MAX_BYTES);
    expect(result.text).not.toMatch(/\b(?:bash|sed|powershell)\b|head -c|<path>/i);
    expect(result.text).toContain("[Line 2: 58.6KB; not shown.]");
    expect(result.text).toContain(
      "[Line 2 exceeds the 50.0KB limit; the read tool cannot show it.]",
    );
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
  });
});

describe("fmtReadPreview — oversized marker truncation", () => {
  it("continues past a truncated marker list without skipping hidden rows", async () => {
    const big1 = "X".repeat(1000);
    const big2 = "Y".repeat(1000);
    const content = `a\n${big1}\n${big2}\nb\n`;
    const budget = 40;

    const first = await fmtReadPreview(content, {}, undefined, home.testPath, budget);
    expect(first.text).toContain("│a");
    expect(first.text).toContain("[Line 2:");
    expect(first.text).not.toContain("│b");
    expect(first.text).not.toContain("Line 3");
    expect(first.text).toContain("Use offset=3 to continue");
    expect(first.nextOffset).toBe(3);

    const second = await fmtReadPreview(content, { offset: 3 }, undefined, home.testPath, budget);
    expect(second.text).toContain("[Line 3:");
    expect(second.text).toContain("│b");
    expect(second.nextOffset).toBeUndefined();
  });
});

describe("fmtReadPreview — maxTruncLines budget", () => {
  it("caps truncated output lines via maxTruncLines", async () => {
    const content = ["l1", "l2", "l3", "l4", "l5"].join("\n") + "\n";
    const result = await fmtReadPreview(content, {}, undefined, home.testPath, undefined, 3);
    expect(result.text).toContain("│l1");
    expect(result.text).toContain("│l3");
    expect(result.text).not.toContain("│l4");
    expect(result.text).toContain("[Showing lines 1-3 of 5. Use offset=4 to continue.]");
    expect(result.nextOffset).toBe(4);
  });

  it("caps oversized-marker rows via maxTruncLines with continuation", async () => {
    const big = "X".repeat(60_000);
    const content = `${big}\n${big}\n${big}\nb\n`;
    const result = await fmtReadPreview(
      content,
      {},
      undefined,
      home.testPath,
      DEFAULT_MAX_BYTES,
      2,
    );
    expect(result.text).toContain("[Line 1:");
    expect(result.text).toContain("[Line 2:");
    expect(result.text).not.toContain("[Line 3:");
    expect(result.text).not.toContain("│b");
    expect(result.text).toContain(
      "[Showing lines 1-2 of 4 (50.0KB limit). Use offset=3 to continue.]",
    );
    expect(result.nextOffset).toBe(3);
  });
});

describe("fmtReadPreview — multi-window budget vs intrinsic line cap", () => {
  const BIG = "x".repeat(160_000);
  const MID = "y".repeat(100_000);

  it("omits a recoverable window with a budget notice and honest truncation (#153 repro)", async () => {
    const content = [BIG, "skip", MID].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 3, limit: 1 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("=== Lines 3-3 of 3 ===");
    expect(result.text).toContain(
      "[Section does not fit in the remaining 43.7KB read budget; not shown. Re-read it on its own.]",
    );
    // The row is recoverable: neither the shrunken budget nor the read tool is blamed.
    expect(result.text).not.toContain("43.7KB limit");
    expect(result.text).not.toContain("cannot show");
    // Window 2 serves 0 rows, and the omitted content never enlarges the answer.
    expect(result.served.map((row) => row.position)).toEqual([0]);
    expect(result.text).not.toContain("y".repeat(1000));
    expect(result.text.length).toBeLessThan(161_000);
    expect(result.truncation?.truncated).toBe(true);
    expect(result.truncation?.truncatedBy).toBe("bytes");
    expect(result.truncation?.outputLines).toBe(0);
  });

  it("recovers the omitted line from a standalone read", async () => {
    const content = [BIG, "skip", MID].join("\n") + "\n";
    const result = await fmtReadPreview(content, { offset: 3, limit: 1 }, undefined, home.testPath);
    expect(result.text).toMatch(/^[A-Za-z0-9]{3}│y{100000}$/);
    expect(result.served.map((row) => row.position)).toEqual([2]);
    expect(result.truncation).toBeUndefined();
  });

  it("keeps a smaller later section renderable after a budget-omitted one", async () => {
    const content = [BIG, "skip", MID, "gap", "tiny"].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 3, limit: 1 },
          { offset: 5, limit: 1 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain(
      "[Section does not fit in the remaining 43.7KB read budget; not shown. Re-read it on its own.]",
    );
    // The omitted section spent only its own notice bytes, so a later small section still renders.
    expect(result.text).toContain("=== Lines 5-5 of 5 ===");
    expect(result.text).toContain("│tiny");
    expect(result.served.map((row) => row.position)).toEqual([0, 4]);
    expect(result.truncation?.truncatedBy).toBe("bytes");
  });

  it("stops a mixed later section at the budget and serves only its shown rows", async () => {
    const content = [BIG, "skip", "small", MID].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 3, limit: 2 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("=== Lines 3-4 of 4 ===");
    expect(result.text).toContain("│small");
    // A recoverable row that misses the budget stops the section; it is never called oversized.
    expect(result.text).not.toContain("[Line 4: ");
    expect(result.text).not.toContain("exceeds the");
    expect(result.text).not.toContain("y".repeat(1000));
    expect(result.served.map((row) => row.position)).toEqual([0, 2]);
    expect(result.truncation?.truncatedBy).toBe("bytes");
    expect(result.truncation?.outputLines).toBe(1);
  });

  it("cites the intrinsic 200 KiB cap for an oversized line in a later section", async () => {
    const content = [BIG, "skip", "z".repeat(210_000)].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 3, limit: 1 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("[Line 3: 205.1KB; not shown.]");
    expect(result.text).toContain(
      "[Line 3 exceeds the 200.0KB limit; the read tool cannot show it.]",
    );
    // The shrunken remaining budget is never cited as the line limit.
    expect(result.text).not.toContain("43.7KB limit");
    expect(result.served.map((row) => row.position)).toEqual([0]);
  });

  it("does not warn about an oversized row the shown prefix never reached", async () => {
    const content =
      [BIG, "skip", "a".repeat(30_000), "b".repeat(30_000), "z".repeat(210_000)].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 3, limit: 3 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("=== Lines 3-5 of 5 ===");
    expect(result.text).toContain("│a");
    // Budget stops before line 5, so neither its placeholder nor its warning is owed.
    expect(result.text).not.toContain("[Line 5: ");
    expect(result.text).not.toContain("exceeds the");
    expect(result.text).not.toContain("│b");
    expect(result.served.map((row) => row.position)).toEqual([0, 2]);
    expect(result.truncation?.truncatedBy).toBe("bytes");
  });
});
