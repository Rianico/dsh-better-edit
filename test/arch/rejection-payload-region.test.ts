import { readFile, writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import type { ServedRow } from "../../src/domain-errors.js";
import { mapFsError } from "../../src/fs-bridge.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { lineHashesPure } from "../../src/hashline/index.js";
import { loadServed } from "../../src/session-view.js";
import { withWorkspace } from "../../src/workspace-context.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

/**
 * Region oracle (ADR-0022 decisions 1–4): every rejection payload's rows are derivable
 * from the submitted anchors' live mapping, never from a lookup in the file's current bytes.
 *
 * The caller names the live window from test knowledge of served coordinates (hardcoded per
 * scenario); this file never imports the content lookup (`findEditHashEcho`, `canon`-based
 * placement), so a window placed by such a lookup cannot satisfy the window check.
 * `fileHashes`/`fileLines` are the current on-disk snapshot; each row must reproduce them
 * exactly at its own position.
 *
 * Payload shape is disjoint by ROW COUNT, not by code (the local tree has no
 * `E_TARGET_LOST`/`E_UNVERIFIED_RANGE` — ADR-0022 §Decision 2): a row-less payload is the
 * target-lost shape (no `Current range` heading of either form, read instruction in the
 * headline); a row-carrying payload renders `Current range:` and its rows.
 *
 * R15: the rule below is the guard, so it carries its own mutant (`T6M4` breaks the real
 * per-row identity check). The planted-violation cells exercise the broken guard.
 */
const SERVED_LINE_RE = /^[A-Za-z0-9]{3}│/m;
/** The deleted retry affordance. Its reappearance anywhere in a payload is a regression. */
const RETRY_AFFORDANCE = "Retry with these anchors";

type Payloadish = {
  code?: string;
  message: string;
  servedRows: ServedRow[];
  servedBlock: string;
};

function assertRegionPayload(args: {
  error: unknown;
  fileHashes: string[];
  fileLines: string[];
  /** The live window the caller named from served-coordinate knowledge; null = unidentifiable. */
  liveStart: number | null;
  liveEnd: number | null;
  expectedCode: string;
  /** The heading the code's renderer emits: `Current range:` for the range family,
   * `Current context around resolved anchor` for `E_STALE_ANCHOR`. */
  heading?: string;
}): void {
  const err = args.error as Payloadish;
  expect(err, "a rejection payload was thrown").toBeDefined();
  expect(err.message).toContain(`[${args.expectedCode}]`);
  if (err.code !== undefined && err.code !== "E_BATCH_ABORT") {
    // The real-tool path aggregates a single failure into an E_BATCH_ABORT envelope whose
    // message embeds the inner header verbatim, so the code lives in the text there.
    expect(err.code).toBe(args.expectedCode);
  }
  const rows = err.servedRows ?? [];
  expect(err.message).not.toContain(RETRY_AFFORDANCE);

  if (args.liveStart === null) {
    // Target-lost shape: grounding void, only a read restores it.
    expect(rows).toEqual([]);
    expect(err.servedBlock).toBe("");
    expect(err.message).not.toContain("Current range:");
    expect(err.message).not.toMatch(SERVED_LINE_RE);
    expect(err.message).toMatch(/read/i);
    return;
  }

  expect(rows.length).toBeGreaterThan(0);
  expect(err.message).toContain(args.heading ?? "Current range:");
  const seen = new Set<number>();
  for (const row of rows) {
    expect(Number.isInteger(row.position), `position is an integer: ${row.position}`).toBe(true);
    expect(row.position).toBeGreaterThanOrEqual(0);
    expect(row.position).toBeLessThan(args.fileHashes.length);
    expect(seen.has(row.position), `position ${row.position} appears once`).toBe(false);
    seen.add(row.position);
    // The identity half: the row's hash IS the current snapshot's hash at that position.
    expect(row.hash, `row ${row.position} reproduces fileHashes[${row.position}]`).toBe(
      args.fileHashes[row.position],
    );
    const line = row.position + 1;
    expect(line).toBeGreaterThanOrEqual(args.liveStart);
    expect(line).toBeLessThanOrEqual(args.liveEnd);
    // The message half: the row is rendered with the same snapshot's content.
    expect(err.message).toContain(`${row.hash}│${args.fileLines[row.position]}`);
  }
}

/** A malformed payload the registry cannot construct — plain field bags, never `DomainError`. */
function plantedError(args: {
  code: string;
  message: string;
  servedRows: ServedRow[];
  servedBlock: string;
}): Payloadish {
  return { ...args };
}

const DISK = "alpha\nBETA\ngamma\n";

describe("rejection payload region rule (ADR-0022)", () => {
  it("live lease applies at the served coordinates with no rejection", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("read", { path: "sample.ts" }));
      const betaRef = text
        .split("\n")
        .find((line) => line.includes("│beta"))!
        .split("│")[0]!;
      const result = await editTool.execute("edit", {
        path: "sample.ts",
        anchor_from: betaRef,
        anchor_to: betaRef,
        replace_with: "BETA",
      });
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("span-length arm carries the named region's rows", async () => {
    await withTempFile("span.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = getText(await harness.readTool.execute("read", { path: "span.txt" }))
        .split("\n")
        .filter((line) => line.includes("│"))
        .map((line) => line.split("│")[0]!);
      expect(served).toHaveLength(4);
      const disk = "alpha\nbeta\ninserted\ngamma\ndelta\n";
      await writeFile(path, disk, "utf-8");
      let caught: unknown;
      try {
        await harness.editTool.execute("edit", {
          path: "span.txt",
          anchor_from: served[0]!,
          anchor_to: served[3]!,
          replace_with: "R",
        });
      } catch (error) {
        caught = error;
      }
      // The named window is the range the submitted anchors identify (served lines 1–5 of
      // the current 5-line file); hardcoded, never searched.
      assertRegionPayload({
        error: caught,
        fileHashes: lineHashesPure(disk),
        fileLines: disk.split("\n").slice(0, -1),
        liveStart: 1,
        liveEnd: 5,
        expectedCode: "E_STALE_RANGE",
      });
      expect(await readFile(path, "utf-8")).toBe(disk);
    });
  });

  it("never-served interior arm carries the named region's rows", async () => {
    await withTempFile("hole.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const window1 = getText(
        await harness.readTool.execute("read", { path: "hole.txt", offset: 1, limit: 1 }),
      );
      const window3 = getText(
        await harness.readTool.execute("read", { path: "hole.txt", offset: 3, limit: 1 }),
      );
      const from = window1
        .split("\n")
        .find((l) => l.includes("│"))!
        .split("│")[0]!;
      const to = window3
        .split("\n")
        .find((l) => l.includes("│"))!
        .split("│")[0]!;
      const disk = await readFile(path, "utf-8");
      let caught: unknown;
      try {
        await harness.editTool.execute("edit", {
          path: "hole.txt",
          anchor_from: from,
          anchor_to: to,
          replace_with: "R",
        });
      } catch (error) {
        caught = error;
      }
      assertRegionPayload({
        error: caught,
        fileHashes: lineHashesPure(disk.trimEnd()),
        fileLines: disk.split("\n").slice(0, -1),
        liveStart: 1,
        liveEnd: 3,
        expectedCode: "E_UNSERVED_RANGE",
      });
    });
  });

  it("stale-anchor arm carries only its context region's rows", async () => {
    await withTempFile("anchor.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = getText(await harness.readTool.execute("read", { path: "anchor.txt" }))
        .split("\n")
        .filter((line) => line.includes("│"))
        .map((line) => line.split("│")[0]!);
      const disk = "alpha\nbeta\ngamma\n";
      await writeFile(path, disk, "utf-8");
      let caught: unknown;
      try {
        await harness.editTool.execute("edit", {
          path: "anchor.txt",
          anchor_from: served[0]!,
          anchor_to: served[3]!,
          replace_with: "R",
        });
      } catch (error) {
        caught = error;
      }
      assertRegionPayload({
        error: caught,
        fileHashes: lineHashesPure(disk.trimEnd()),
        fileLines: disk.split("\n").slice(0, -1),
        liveStart: 1,
        liveEnd: 3,
        expectedCode: "E_STALE_ANCHOR",
        heading: "Current context around resolved anchor",
      });
    });
  });

  it("row-less target-lost shape: no rows, no heading, read instruction in the headline", () => {
    const versionGuard = Object.assign(new Error("stale version"), { code: "FS_STALE_VERSION" });
    let caught: unknown;
    try {
      mapFsError(versionGuard, "sample.ts");
    } catch (error) {
      caught = error;
    }
    assertRegionPayload({
      error: caught,
      fileHashes: [],
      fileLines: [],
      liveStart: null,
      liveEnd: null,
      expectedCode: "E_STALE_RANGE",
    });
  });

  // ---- planted violations: the guard must be able to fail ----
  it("negative control: a misplaced row fails the live-mapping check", () => {
    const hashes = lineHashesPure(DISK.trimEnd());
    const misplaced: ServedRow = { position: 0, hash: hashes[2]! };
    const planted = plantedError({
      code: "E_STALE_RANGE",
      // The planted payload wears the right heading, so the check fails on the row identity.
      message: `[MODEL] [E_STALE_RANGE] line 2 differs.\nCurrent range:\n${misplaced.hash}│alpha`,
      servedRows: [misplaced],
      servedBlock: `${misplaced.hash}│alpha`,
    });
    expect(() =>
      assertRegionPayload({
        error: planted,
        fileHashes: hashes,
        fileLines: DISK.split("\n").slice(0, -1),
        liveStart: 1,
        liveEnd: 3,
        expectedCode: "E_STALE_RANGE",
      }),
    ).toThrow();
  });

  it("negative control: a row outside the named window fails the check", () => {
    const hashes = lineHashesPure(DISK.trimEnd());
    const outside: ServedRow = { position: 2, hash: hashes[2]! };
    const planted = plantedError({
      code: "E_STALE_RANGE",
      message: `[MODEL] [E_STALE_RANGE] x.\nCurrent range:\n${hashes[2]}│gamma`,
      servedRows: [outside],
      servedBlock: `${hashes[2]}│gamma`,
    });
    expect(() =>
      assertRegionPayload({
        error: planted,
        fileHashes: hashes,
        fileLines: DISK.split("\n").slice(0, -1),
        liveStart: 1,
        liveEnd: 2,
        expectedCode: "E_STALE_RANGE",
      }),
    ).toThrow();
  });

  it("negative control: rows without a heading fail the check", () => {
    const hashes = lineHashesPure(DISK.trimEnd());
    const planted = plantedError({
      code: "E_STALE_RANGE",
      message: `[MODEL] [E_STALE_RANGE] x.\n${hashes[0]}│alpha`,
      servedRows: [{ position: 0, hash: hashes[0]! }],
      servedBlock: `${hashes[0]}│alpha`,
    });
    expect(() =>
      assertRegionPayload({
        error: planted,
        fileHashes: hashes,
        fileLines: DISK.split("\n").slice(0, -1),
        liveStart: 1,
        liveEnd: 3,
        expectedCode: "E_STALE_RANGE",
      }),
    ).toThrow();
  });

  it("negative control: a target-lost payload carrying rows fails the check", () => {
    const hashes = lineHashesPure("alpha\nbeta\ndelta".trimEnd());
    const planted = plantedError({
      code: "E_STALE_RANGE",
      message: `[MODEL] [E_STALE_RANGE] line 3 gone.\nCurrent range:\n${hashes[2]}│delta`,
      servedRows: [{ position: 2, hash: hashes[2]! }],
      servedBlock: `${hashes[2]}│delta`,
    });
    expect(() =>
      assertRegionPayload({
        error: planted,
        fileHashes: hashes,
        fileLines: ["alpha", "beta", "delta"],
        liveStart: null,
        liveEnd: null,
        expectedCode: "E_STALE_RANGE",
      }),
    ).toThrow();
  });

  it("negative control: a row-less payload without a read instruction fails the check", () => {
    const planted = plantedError({
      code: "E_STALE_RANGE",
      message: "[MODEL] [E_STALE_RANGE] the target is gone.",
      servedRows: [],
      servedBlock: "",
    });
    expect(() =>
      assertRegionPayload({
        error: planted,
        fileHashes: [],
        fileLines: [],
        liveStart: null,
        liveEnd: null,
        expectedCode: "E_STALE_RANGE",
      }),
    ).toThrow();
  });

  it("negative control: the deleted retry affordance fails the check", () => {
    const hashes = lineHashesPure(DISK.trimEnd());
    const planted = plantedError({
      code: "E_STALE_RANGE",
      message: `[MODEL] [E_STALE_RANGE] x.\nCurrent range:\n${hashes[0]}│alpha\n${RETRY_AFFORDANCE} (no read needed).`,
      servedRows: [{ position: 0, hash: hashes[0]! }],
      servedBlock: `${hashes[0]}│alpha`,
    });
    expect(() =>
      assertRegionPayload({
        error: planted,
        fileHashes: hashes,
        fileLines: DISK.split("\n").slice(0, -1),
        liveStart: 1,
        liveEnd: 3,
        expectedCode: "E_STALE_RANGE",
      }),
    ).toThrow();
  });

  it("the declared multi-window limit is discoverable from the failure (R12)", async () => {
    await withTempFile("r12.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      let caught: unknown;
      try {
        await harness.readTool.execute("read", {
          path: "r12.txt",
          windows: [{ offset: 1, limit: 1 }],
        });
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe("E_BAD_PAYLOAD");
      const message = (caught as Error).message;
      // Discoverable: the failure NAMES the unsupported field. (T6 CP1 measured that it does
      // NOT also list the allowed set — `assertReadRequest` passes no hint — so this cell pins
      // the half that holds and the report records the re-rule signal.)
      expect(message).toContain("windows");
      expect(message).toContain("Read request");
    });
  });

  it("a rejection inside a region leaves the served mirror and out-of-region slots untouched (T3f per region)", async () => {
    await withTempFile(
      "region.txt",
      "alpha\nbeta\ngamma\ndelta\nepsilon\n",
      async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
        // A windowed read serves lines 1–2; positions 3–5 are never served.
        const servedRows = getText(
          await harness.readTool.execute("read", { path: "region.txt", offset: 1, limit: 2 }),
        )
          .split("\n")
          .filter((line) => line.includes("│"))
          .map((line) => line.split("│")[0]!);
        expect(servedRows).toHaveLength(2);
        const before = await withWorkspace(cwd, () => loadServed("test-session", path));
        expect(before.slice(0, 2)).toEqual([servedRows[0]!, servedRows[1]!]);
        expect(before.slice(2).every((slot) => slot === null)).toBe(true);

        // An insert ABOVE the served span that duplicates a served line: the minimal
        // exterior change that makes the edit reject at all.
        await writeFile(path, `beta\nalpha\nbeta\ngamma\ndelta\nepsilon\n`, "utf-8");
        let caught: unknown;
        try {
          await harness.editTool.execute("edit", {
            path: "region.txt",
            anchor_from: servedRows[0]!,
            anchor_to: servedRows[1]!,
            replace_with: "R",
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeDefined();
        const after = await withWorkspace(cwd, () => loadServed("test-session", path));
        expect(after).toEqual(before);
        // Rows outside the region stay unserved.
        expect(after.slice(2).every((slot) => slot === null)).toBe(true);
      },
    );
  });

  it("a pinned undo target survives a region rejection (T5)", async () => {
    await withTempFile("pin.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const store = await withWorkspace(
        cwd,
        async () => (await loadHashStore()) as InternalHashStore,
      );
      const served = getText(await harness.readTool.execute("read", { path: "pin.txt" }))
        .split("\n")
        .filter((line) => line.includes("│"))
        .map((line) => line.split("│")[0]!);
      expect(served).toHaveLength(4);

      // Apply one edit so a v7 undo pin exists.
      await harness.editTool.execute("edit", {
        path: "pin.txt",
        anchor_from: served[3]!,
        anchor_to: served[3]!,
        replace_with: "",
      });
      const pinBefore = store.getFileUndo(path);
      expect(pinBefore, "a v7 undo pin exists after the applied edit").toBeDefined();
      expect(pinBefore!.snapshotHash, "the pin names a snapshot").not.toBeNull();
      expect(store.lineageFor(path, pinBefore!.snapshotHash!).length).toBeGreaterThan(0);

      // A region rejection: the file changed out of band under the served anchors.
      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");
      let caught: unknown;
      try {
        await harness.editTool.execute("edit", {
          path: "pin.txt",
          anchor_from: served[0]!,
          anchor_to: served[2]!,
          replace_with: "R",
        });
      } catch (error) {
        caught = error;
      }
      expect(String((caught as Error).message)).toMatch(/E_STALE_RANGE|E_UNSERVED_RANGE/);

      // The pin is untouched by the rejection, and its snapshot still resolves: a reject path
      // that vacuums or rewrites `file_undo` reddens this cell.
      const pinAfter = store.getFileUndo(path);
      expect(pinAfter).toEqual(pinBefore);
      expect(store.lineageFor(path, pinAfter!.snapshotHash!).length).toBeGreaterThan(0);
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });
});
