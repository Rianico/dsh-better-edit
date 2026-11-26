import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { fmtReadPreview, MAX_READ_WINDOWS } from "../../src/file-view.js";
import { buildReadTool } from "../../src/tool-read.js";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { driftReported, markDriftReported } from "../../src/session-view.js";
import { sessionKeyFor, withWorkspace } from "../../src/workspace-context.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import {
  extractHash,
  getText,
  makeTag,
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

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
}

/** Twenty lines, so two windows can overlap and their union still ends inside the file. */
const TWENTY_LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
const TWENTY = lines(TWENTY_LINES.length);
/** Two hundred lines: past the 2000-line budget only when duplicates render (16 x 200 = 3200). */
const TWO_HUNDRED = lines(200);

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

async function internalStore(): Promise<InternalHashStore> {
  return (await loadHashStore()) as InternalHashStore;
}

/**
 * Seed the three things only a full read owns: a retired anchor at an unknown death position
 * (`deathPos: null` — the shape no partial sweep may drain), a hazard card, and a canon array
 * longer than the file (a full read replaces it wholesale; a preserve path merges in place and
 * keeps the length, so 20 sentinels against 12 lines make an overwrite observable).
 */
async function seedFullReadOwned(sessionKey: string, path: string): Promise<void> {
  const store = await internalStore();
  store.clearRetiredAnchors(sessionKey, path);
  store.upsertRetiredAnchors(sessionKey, path, JSON.stringify([{ hash: "ZZZ", deathPos: null }]));
  store.clearCards(sessionKey, path);
  store.upsertCards(sessionKey, path, JSON.stringify([999]));
  store.upsertServedCanons(
    sessionKey,
    path,
    JSON.stringify(Array.from({ length: 20 }, () => "JUNK")),
  );
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

  it("renders an overlapping pair once, over its union", async () => {
    const result = await fmtReadPreview(
      TWENTY,
      {
        windows: [
          { offset: 1, limit: 10 },
          { offset: 5, limit: 11 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text.match(/^=== Lines /gm)).toHaveLength(1);
    expect(result.text).toContain("=== Lines 1-15 of 20 ===");
    expect(rowsOf(result.text)).toEqual(TWENTY_LINES.slice(0, 15));
    expect(result.served.map((row) => row.position)).toEqual([...Array(15).keys()]);
    // WHY: one run means one record per line, so the row the model sees and the row served agree.
    expect(anchorsByLine(result.text).get("line 5")).toBe(result.served[4]!.hash);
  });

  it("merges an interior window into the containing section", async () => {
    const result = await fmtReadPreview(
      TWENTY,
      {
        windows: [
          { offset: 3, limit: 4 },
          { offset: 1, limit: 10 },
        ],
      },
      undefined,
      home.testPath,
    );
    // WHY: the union is the answer, not whichever window came first.
    expect(result.text.match(/^=== Lines /gm)).toHaveLength(1);
    expect(result.text).toContain("=== Lines 1-10 of 20 ===");
    expect(rowsOf(result.text)).toEqual(TWENTY_LINES.slice(0, 10));
    expect(result.served.map((row) => row.position)).toEqual([...Array(10).keys()]);
  });

  it("renders an identical duplicate window once", async () => {
    const result = await fmtReadPreview(
      TWENTY,
      {
        windows: [
          { offset: 1, limit: 3 },
          { offset: 1, limit: 3 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text.match(/^=== Lines /gm)).toHaveLength(1);
    expect(result.text).toContain("=== Lines 1-3 of 20 ===");
    expect(rowsOf(result.text)).toEqual(["line 1", "line 2", "line 3"]);
    expect(result.served.map((row) => row.position)).toEqual([0, 1, 2]);
  });

  it("collapses sixteen identical windows to one section and charges the budget once", async () => {
    const windows = Array.from({ length: MAX_READ_WINDOWS }, () => ({ offset: 1, limit: 200 }));
    const result = await fmtReadPreview(TWO_HUNDRED, { windows }, undefined, home.testPath);
    expect(result.text.match(/^=== Lines /gm)).toHaveLength(1);
    expect(result.text).toContain("=== Lines 1-200 of 200 ===");
    expect(rowsOf(result.text)).toHaveLength(200);
    expect(result.served).toHaveLength(200);
    // WHY: duplicated bytes are never rendered, so they never debit the shared budget.
    expect(result.truncation).toBeUndefined();
  });

  it("keeps served positions aligned when an interior window merges away", async () => {
    const result = await fmtReadPreview(
      TWENTY,
      {
        windows: [
          { offset: 5, limit: 2 },
          { offset: 1, limit: 10 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("=== Lines 1-10 of 20 ===");
    // WHY: a merged run stays contiguous, so the builders' `startLine - 1 + index` still holds.
    expect(rowsOf(result.text)).toEqual(TWENTY_LINES.slice(0, 10));
    expect(result.served.map((row) => row.position)).toEqual([...Array(10).keys()]);
  });

  it("coalesces touching windows into one section", async () => {
    const result = await fmtReadPreview(
      TWENTY,
      {
        windows: [
          { offset: 1, limit: 2 },
          { offset: 3, limit: 4 },
        ],
      },
      undefined,
      home.testPath,
    );
    // WHY: no gap exists between 1-2 and 3-4, so two headers would be pure noise.
    expect(result.text.match(/^=== Lines /gm)).toHaveLength(1);
    expect(result.text).toContain("=== Lines 1-6 of 20 ===");
    expect(rowsOf(result.text)).toEqual(TWENTY_LINES.slice(0, 6));
  });

  it("keeps disjoint windows as separate sections in caller order", async () => {
    const forward = await fmtReadPreview(
      TWENTY,
      {
        windows: [
          { offset: 1, limit: 3 },
          { offset: 10, limit: 11 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(forward.text.match(/^=== Lines /gm)).toHaveLength(2);
    expect(forward.text.indexOf("=== Lines 1-3 of 20 ===")).toBeLessThan(
      forward.text.indexOf("=== Lines 10-20 of 20 ==="),
    );
    expect(rowsOf(forward.text)).toEqual([
      ...TWENTY_LINES.slice(0, 3),
      ...TWENTY_LINES.slice(9, 20),
    ]);

    const reversed = await fmtReadPreview(
      TWENTY,
      {
        windows: [
          { offset: 10, limit: 11 },
          { offset: 1, limit: 3 },
        ],
      },
      undefined,
      home.testPath,
    );
    // WHY: the order is part of the request, so sections follow it — `served` does not.
    expect(reversed.text.match(/^=== Lines /gm)).toHaveLength(2);
    expect(reversed.text.indexOf("=== Lines 10-20 of 20 ===")).toBeLessThan(
      reversed.text.indexOf("=== Lines 1-3 of 20 ==="),
    );
    expect(rowsOf(reversed.text)).toEqual([
      ...TWENTY_LINES.slice(9, 20),
      ...TWENTY_LINES.slice(0, 3),
    ]);
    const sortedPositions = [...Array(20).keys()].filter(
      (position) => position < 3 || position > 8,
    );
    expect(forward.served.map((row) => row.position)).toEqual(sortedPositions);
    expect(reversed.served.map((row) => row.position)).toEqual(sortedPositions);
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

  it("does not let a past-EOF window break a merged run", async () => {
    const result = await fmtReadPreview(
      TWENTY,
      {
        windows: [
          { offset: 1, limit: 2 },
          { offset: 99, limit: 1 },
          { offset: 3, limit: 4 },
        ],
      },
      undefined,
      home.testPath,
    );
    // WHY: a past-EOF window contributes no interval, so it is not a barrier between the runs
    // WHY: around it — 1-2 and 3-4 stay one coalesced run even with the message in between.
    expect(result.text.match(/^=== Lines /gm)).toHaveLength(1);
    const header = "=== Lines 1-6 of 20 ===";
    const message = "Offset 99 is beyond end of file (20 lines total)";
    expect(result.text).toContain(header);
    expect(result.text).toContain(message);
    // The message keeps its own caller slot (order 1), after the merged run (order 0).
    expect(result.text.indexOf(header)).toBeLessThan(result.text.indexOf("│line 6"));
    expect(result.text.indexOf("│line 6")).toBeLessThan(result.text.indexOf(message));
    expect(result.text).not.toContain("=== Lines 99");
    expect(rowsOf(result.text)).toEqual(TWENTY_LINES.slice(0, 6));
    expect(result.served.map((row) => row.position)).toEqual([0, 1, 2, 3, 4, 5]);
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
    expect(result.text).toContain("[Read budget exhausted; this section is not shown.");
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
    expect(windowed.text).toContain("exceeds the 200B limit");
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

  it("re-renders and re-serves the same window across two calls", async () => {
    await withTempFile("reread.ts", TWELVE, async ({ cwd }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const first = await readTool.execute("r1", {
        path: "reread.ts",
        windows: [{ offset: 1, limit: 3 }],
      });
      const second = await readTool.execute("r2", {
        path: "reread.ts",
        windows: [{ offset: 1, limit: 3 }],
      });
      // WHY: re-reading is how anchors refresh, so a read tool must never withhold served rows
      // WHY: because an earlier call already served the same range.
      expect(rowsOf(getText(first))).toEqual(["line 1", "line 2", "line 3"]);
      expect(rowsOf(getText(second))).toEqual(["line 1", "line 2", "line 3"]);
      const byLine = anchorsByLine(getText(second));
      const edited = await editTool.execute("e1", {
        path: "reread.ts",
        anchor_from: byLine.get("line 1")!,
        anchor_to: byLine.get("line 2")!,
        replace_with: "X",
      });
      // The second call's anchors resolve, so it really did re-serve (and re-lease) its rows.
      expect(getText(edited)).toContain("Successfully edited");
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
      expect(getText(readResult)).toContain("=== Lines 1-4 of 12 ===");
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

      // The drift clear is only ONE of the effects a full read owns. `windows: []` falls back to
      // the plain full-read contract, so the retired anchors, the hazard cards and the served
      // canon array go with it — the whole contract, from the same rule.
      const store = await internalStore();
      await seedFullReadOwned(sessionKey, path);
      await readAndServe(localIO(), "empty-windows.ts", cwd, { sessionKey, windows: [] });
      expect(store.getRetiredEntries(sessionKey, path)).toEqual([]);
      expect([...store.getCards(sessionKey, path)]).toEqual([]);
      expect(store.getServedCanons(sessionKey, path)).toHaveLength(12);

      // A non-empty `windows` request that happens to cover the whole file is still a window, not
      // "the" whole-file read: it must not clear the hazard state or overwrite the canon array
      // just because the rows it served turned out dense.
      await seedFullReadOwned(sessionKey, path);
      const whole = await readAndServe(localIO(), "empty-windows.ts", cwd, {
        sessionKey,
        windows: [{ offset: 1, limit: 12 }],
      });
      // The premise: this request really did serve every line of the file.
      expect(whole.served.map((row) => row.position)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      expect(store.getRetiredEntries(sessionKey, path).map((entry) => entry.hash)).toContain("ZZZ");
      expect([...store.getCards(sessionKey, path)]).toContain(999);
      expect(store.getServedCanons(sessionKey, path)).toHaveLength(20);
    });
  });

  it("the preview echoes the windows rule: windows: [] through the read tool is a full read, drift clear included", async () => {
    await withTempFile("echo-windows.ts", TWELVE, async ({ cwd, path }) => {
      const { readTool } = setupIntegrationTest(cwd);
      // The fixture's exec session (`makeExec` pins the session id).
      const sessionKey = "test-session";
      // The tool's store resolves against its workspace context; enter the same one so the
      // marks observed here are the marks the tool's full read clears.
      await withWorkspace(cwd, async () => {
        await markDriftReported(sessionKey, path, ["abc"]);
        const result = await readTool.execute("r1", { path: "echo-windows.ts", windows: [] });
        // Preview echo: `[]` maps to no-windows exactly like the serve-side rule — the plain
        // full-read rendering, no window headers.
        const text = getText(result);
        expect(text).not.toContain("=== Lines");
        expect(rowsOf(text)).toEqual(TWELVE.trimEnd().split("\n"));
        // The full-read contract read-and-serve's isFullRead owes the same rule: drift cleared.
        expect(await driftReported(sessionKey, path)).toEqual(new Set());
      });
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

describe("read tool — multi-window budget vs intrinsic line cap", () => {
  const BIG = "x".repeat(160_000);
  const MID = "y".repeat(100_000);
  const CONTENT = [BIG, "skip", MID].join("\n") + "\n";

  it("omits the over-budget window, refuses its unserved anchor, then edits after a standalone read", async () => {
    await withTempFile("two-cap.txt", CONTENT, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const windowed = getText(
        await readTool.execute("r1", {
          path: "two-cap.txt",
          windows: [
            { offset: 1, limit: 1 },
            { offset: 3, limit: 1 },
          ],
        }),
      );
      // Downstream's read result carries no `details.metrics`: the honest omission signal is the
      // notice text plus the absence of any served row for line 3, never a shrunken-limit claim.
      expect(windowed).toContain(
        "[Section does not fit in the remaining 43.7KB read budget; not shown. Re-read it on its own.]",
      );
      expect(windowed).not.toContain("cannot show");
      expect(windowed).not.toContain(MID);

      // The omitted line's anchor is real, but the windowed read never leased it.
      const omitted = (await makeTag(CONTENT, 3, path)).hash;
      let rejected: Error | undefined;
      try {
        await editTool.execute("e1", {
          path: "two-cap.txt",
          anchor_from: omitted,
          anchor_to: omitted,
          replace_with: "replaced",
        });
      } catch (error) {
        rejected = error as Error;
      }
      expect(rejected?.message).toContain("[E_UNKNOWN_ANCHOR]");
      expect(await readFile(path, "utf-8")).toBe(CONTENT);

      // The notice's recommendation — a standalone read — is the recovery path.
      const alone = getText(
        await readTool.execute("r2", { path: "two-cap.txt", offset: 3, limit: 1 }),
      );
      expect(alone).toContain(MID);
      const row = alone.split("\n").find((line) => /^[A-Za-z0-9]{3}│/.test(line));
      expect(row).toBeDefined();
      const anchor = extractHash(row!);

      const edited = await editTool.execute("e3", {
        path: "two-cap.txt",
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: "replaced",
      });
      expect(getText(edited)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe([BIG, "skip", "replaced"].join("\n") + "\n");
    });
  });
});
