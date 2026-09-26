import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { fmtReadPreview, MAX_READ_WINDOWS } from "../../src/file-view.js";
import { buildReadTool } from "../../src/tool-read.js";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { driftReported, markDriftReported } from "../../src/session-view.js";
import { sessionKeyFor } from "../../src/workspace-context.js";
import { initHasher } from "../../src/hashline/hasher.js";
import {
  extractHash,
  getText,
  setupIntegrationTest,
  useTestHome,
  withTempFile,
} from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

const home = useTestHome();

/**
 * FU-6 — port of pi-better-edit@2334352 `feat(read): add multi-window reads and consolidate
 * the read path's stats`, superseding ADR-0023's decline. Adaptations from the upstream file
 * (test/tools/read-windows.test.ts) are seam-level only:
 *  - `fmtReadPreview`/`MAX_READ_WINDOWS` live in `src/file-view.ts` here (no `src/file-content/`).
 *  - the tool seam is dsh `execute(id, args)` (no ctx argument), and the drift observation uses
 *    the local `readAndServe` + `markDriftReported`/`driftReported` seam (no `sessionFromContext`).
 */

/** Twelve addressable lines, so two windows can sit far apart without touching. */
const TWELVE = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

function rowsOf(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^[A-Za-z0-9]{3}│/.test(line))
    .map((line) => line.split("│")[1]!);
}

function anchorsByLine(text: string): Map<string, string> {
  const rows = text.split("\n").filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
  return new Map(rows.map((row) => [row.split("│")[1]!, extractHash(row)]));
}

describe("fmtReadPreview — windows", () => {
  it("renders each window under its own header and serves exactly its rows", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      {
        windows: [
          { offset: 1, limit: 2 },
          { offset: 10, limit: 2 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("=== Lines 1-2 of 12 ===");
    expect(result.text).toContain("=== Lines 10-11 of 12 ===");
    expect(rowsOf(result.text)).toEqual(["line 1", "line 2", "line 10", "line 11"]);
    expect(result.served.map((row) => row.position)).toEqual([0, 1, 9, 10]);
  });

  it("collapses overlapping windows to one served row per line", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      {
        windows: [
          { offset: 1, limit: 3 },
          { offset: 2, limit: 3 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("=== Lines 1-3 of 12 ===");
    expect(result.text).toContain("=== Lines 2-4 of 12 ===");
    const positions = result.served.map((row) => row.position);
    expect(positions).toEqual([0, 1, 2, 3]);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("keeps the file-scoped continuation hint out of window sections", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      { windows: [{ offset: 1, limit: 2 }] },
      undefined,
      home.testPath,
    );
    expect(result.text).not.toContain("to continue");
    expect(result.nextOffset).toBeUndefined();
  });

  it("clamps a window's limit at end of file", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      { windows: [{ offset: 11, limit: 50 }] },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("=== Lines 11-12 of 12 ===");
    expect(result.served.map((row) => row.position)).toEqual([10, 11]);
    // WHY: a window that fit the shared budget is not a truncated result, so no metadata is owed.
    expect(result.truncation).toBeUndefined();
  });

  it("reports a window past end of file without serving it", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      {
        windows: [
          { offset: 99, limit: 2 },
          { offset: 1, limit: 1 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("Offset 99 is beyond end of file (12 lines total)");
    // WHY: a window past EOF has no line range to name, so its section carries the message alone.
    expect(result.text).not.toContain("=== Lines 99");
    expect(result.served.map((row) => row.position)).toEqual([0]);
  });

  it("spends one shared budget across every window", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      {
        windows: [
          { offset: 1, limit: 3 },
          { offset: 10, limit: 2 },
        ],
      },
      undefined,
      home.testPath,
      400,
      3,
    );
    expect(result.text).toContain("[Read budget exhausted; this window is not shown.");
    expect(result.served.map((row) => row.position)).toEqual([0, 1, 2]);
    // WHY: the budget really did cut a requested window away, so the tool owes truncated: true.
    expect(result.truncation?.truncated).toBe(true);
    // WHY: windows are discrete slices, so no root offset can paginate the request as one stream.
    expect(result.nextOffset).toBeUndefined();
  });

  it("reports a truncated window without offering a root pagination offset", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      { windows: [{ offset: 1, limit: 6 }] },
      undefined,
      home.testPath,
      400,
      2,
    );
    expect(result.truncation?.truncated).toBe(true);
    // The window keeps its own continuation cue...
    expect(result.text).toContain("to continue");
    // ...but the request is not one stream, so no scalar offset is offered for it.
    expect(result.nextOffset).toBeUndefined();
  });

  it("treats an empty windows array as no windows", async () => {
    const result = await fmtReadPreview(TWELVE, { windows: [] }, undefined, home.testPath);
    expect(result.served).toHaveLength(12);
  });

  it("keeps an oversized window from leaking a continuation hint", async () => {
    const content = `${"x".repeat(500)}\nshort two\nshort three\nshort four\n`;
    const windowed = await fmtReadPreview(
      content,
      { windows: [{ offset: 1, limit: 2 }] },
      undefined,
      home.testPath,
      200,
      100,
    );
    expect(windowed.text).toContain("exceeds 200B");
    expect(windowed.text).toContain("│short two");
    // WHY: the window named lines 1-2; "use offset=3 to continue" would offer a page it never asked for.
    expect(windowed.text).not.toContain("to continue");
    expect(windowed.nextOffset).toBeUndefined();

    // The same range read alone IS a page, so the hint is still owed there.
    const single = await fmtReadPreview(
      content,
      { offset: 1, limit: 2 },
      undefined,
      home.testPath,
      200,
      100,
    );
    expect(single.text).toContain("to continue");
  });

  it("prefers windows over offset/limit when both are given", async () => {
    const result = await fmtReadPreview(
      TWELVE,
      { offset: 5, limit: 5, windows: [{ offset: 1, limit: 1 }] },
      undefined,
      home.testPath,
    );
    expect(result.served.map((row) => row.position)).toEqual([0]);
  });

  it("rejects a window field that is not a positive integer", async () => {
    await expect(
      fmtReadPreview(TWELVE, { windows: [{ offset: 0, limit: 2 }] }, undefined, home.testPath),
    ).rejects.toThrow("positive integer");
    await expect(
      fmtReadPreview(TWELVE, { windows: [{ offset: 1 }] } as never, undefined, home.testPath),
    ).rejects.toThrow('"windows[0].limit"');
  });

  it("rejects more windows than the tool accepts", async () => {
    const tooMany = Array.from({ length: MAX_READ_WINDOWS + 1 }, (_, index) => ({
      offset: index + 1,
      limit: 1,
    }));
    await expect(
      fmtReadPreview(TWELVE, { windows: tooMany }, undefined, home.testPath),
    ).rejects.toThrow(`at most ${MAX_READ_WINDOWS} windows`);
  });
});

describe("read tool — windows", () => {
  it("serves anchors from every window so one edit can span them", async () => {
    await withTempFile("windows.ts", TWELVE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", {
        path: "windows.ts",
        windows: [
          { offset: 1, limit: 2 },
          { offset: 11, limit: 2 },
        ],
      });
      const byLine = anchorsByLine(getText(readResult));
      // Both anchors come from different windows: the leases granted by one read must cover them.
      const edited = await editTool.execute("e1", {
        path: "windows.ts",
        anchor_from: byLine.get("line 1")!,
        anchor_to: byLine.get("line 12")!,
        replace_with: "X",
      });
      expect(getText(edited)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("X\n");
    });
  });

  it("leases a line shared by two windows once", async () => {
    await withTempFile("overlap.ts", TWELVE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", {
        path: "overlap.ts",
        windows: [
          { offset: 1, limit: 3 },
          { offset: 2, limit: 3 },
        ],
      });
      expect(getText(readResult)).toContain("=== Lines 1-3 of 12 ===");
      const byLine = anchorsByLine(getText(readResult));
      // Lines 2-3 appear in both windows; their anchors must resolve against the lease granted once.
      const edited = await editTool.execute("e1", {
        path: "overlap.ts",
        anchor_from: byLine.get("line 2")!,
        anchor_to: byLine.get("line 3")!,
        replace_with: "X",
      });
      expect(getText(edited)).toContain("Successfully edited");
      const expected = ["line 1", "X", ...TWELVE.trimEnd().split("\n").slice(3)].join("\n") + "\n";
      expect(await readFile(path, "utf-8")).toBe(expected);
    });
  });

  it("treats windows: [] as a full read and a partial read as not", async () => {
    await withTempFile("empty-windows.ts", TWELVE, async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("fu6-empty-windows");

      await markDriftReported(sessionKey, path, ["abc"]);
      await readAndServe(localIO(), "empty-windows.ts", cwd, { sessionKey, windows: [] });
      // An empty array falls back to a full read, so it owes the full-read contract: drift cleared.
      expect(await driftReported(sessionKey, path)).toEqual(new Set());

      await markDriftReported(sessionKey, path, ["abc"]);
      await readAndServe(localIO(), "empty-windows.ts", cwd, {
        sessionKey,
        offset: 1,
        limit: 2,
      });
      expect(await driftReported(sessionKey, path)).toEqual(new Set(["abc"]));

      // A non-empty multi-window read serves sparse rows — also not a full read.
      await markDriftReported(sessionKey, path, ["abc"]);
      const sparse = await readAndServe(localIO(), "empty-windows.ts", cwd, {
        sessionKey,
        windows: [
          { offset: 1, limit: 2 },
          { offset: 11, limit: 2 },
        ],
      });
      expect(sparse.served.map((row) => row.position)).toEqual([0, 1, 10, 11]);
      expect(await driftReported(sessionKey, path)).toEqual(new Set(["abc"]));
    });
  });

  it("leaves a plain offset/limit read unchanged", async () => {
    await withTempFile("plain.ts", TWELVE, async ({ cwd }) => {
      const { readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute("r1", { path: "plain.ts", offset: 2, limit: 2 });
      const text = getText(result);
      expect(text).not.toContain("=== Lines");
      expect(rowsOf(text)).toEqual(["line 2", "line 3"]);
    });
  });

  it("advertises windows, with the 16-window cap, in the read tool schema", async () => {
    const tool = buildReadTool(localIO()) as unknown as {
      parameters: { properties: Record<string, { description?: string }> };
    };
    const windows = tool.parameters.properties.windows;
    // WHY the cap text: the DSL has no maxItems, so normWindows enforces the bound and only the
    // description can keep it discoverable to the model (see the FU-6 note in src/tool-read.ts).
    expect(windows, "the read schema advertises windows").toBeDefined();
    expect(windows?.description).toContain(`${MAX_READ_WINDOWS} line windows`);
  });
});
