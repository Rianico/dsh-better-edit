import { readFile, writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import type { ServedRow } from "../../src/domain-errors.js";
import { localIO, mapFsError } from "../../src/fs-bridge.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { lineHashesPure } from "../../src/hashline/index.js";
import { loadServed } from "../../src/session-view.js";
import { sessionKeyFor, withWorkspace } from "../../src/workspace-context.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { buildReadTool } from "../../src/tool-read.js";
import { rejectUnknownFields } from "../../src/utils.js";
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
    expect(err.code).toBe(args.expectedCode);
  }
  const rows = err.servedRows ?? [];
  expect(err.message).not.toContain(RETRY_AFFORDANCE);

  if (args.liveStart === null || args.liveEnd === null) {
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
    expect(row.hash, `row ${row.position} reproduces fileHashes[${row.position}]`).toBe(
      args.fileHashes[row.position],
    );
    const line = row.position + 1;
    expect(line).toBeGreaterThanOrEqual(args.liveStart);
    expect(line).toBeLessThanOrEqual(args.liveEnd);
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

/** The `HASH` column of every served row in a rendered read, in served order. */
function servedHashes(rendered: string): string[] {
  return rendered
    .split("\n")
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│")[0]!);
}

/**
 * The read tool's allowed parameter set, DERIVED from the exported tool schema — never retyped
 * (CP2 premise P2: `READ_KS` is module-local and `src/contract.ts` is frozen, so a typed list here
 * would be a hand-copy of a derivable fact). `buildReadTool` is the same source `READ_KS` mirrors.
 */
function allowedReadParams(): string[] {
  const tool = buildReadTool(localIO()) as unknown as {
    parameters: { properties: Record<string, unknown> };
  };
  return Object.keys(tool.parameters.properties);
}

/**
 * The R12 ban, as a FUNCTION so the demonstration control below can show it fails (CP3 FIX 1):
 * the failure must not name any allowed field. It is not satisfied by the absence of a list in
 * `rejectUnknownFields`; it is satisfied by the absence of a hint at the call site.
 */
function assertNoAllowedSetLeak(message: string, allowed: readonly string[]): void {
  for (const name of allowed) {
    expect(message, `the failure must not name the allowed field "${name}"`).not.toContain(name);
  }
}

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

  it("never-served boundary arm rejects granular with no rows", async () => {
    await withTempFile("hole.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const window1 = getText(
        await harness.readTool.execute("read", { path: "hole.txt", offset: 1, limit: 1 }),
      );
      const from = window1
        .split("\n")
        .find((l) => l.includes("│"))!
        .split("│")[0]!;
      const disk = await readFile(path, "utf-8");
      const to = lineHashesPure(disk.trimEnd())[2]!;
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
      const err = caught as { code?: string; message: string; servedRows?: ServedRow[] };
      expect(err.message).toContain("[E_UNKNOWN_ANCHOR]");
      expect(err.message).toContain(`has not served the anchor "${to}"`);
      expect(err.message).toContain("nothing was written");
      expect(err.message).not.toContain("Current range");
      expect(err.message).not.toContain(RETRY_AFFORDANCE);
      expect(await readFile(path, "utf-8"), "the rejection wrote nothing").toBe(disk);
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

  it("negative control: a misplaced row fails the live-mapping check", () => {
    const hashes = lineHashesPure(DISK.trimEnd());
    const misplaced: ServedRow = { position: 0, hash: hashes[2]! };
    const planted = plantedError({
      code: "E_STALE_RANGE",
      message: `[TO MODEL] [E_STALE_RANGE] line 2 differs.\nCurrent range:\n${misplaced.hash}│alpha`,
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
      message: `[TO MODEL] [E_STALE_RANGE] x.\nCurrent range:\n${hashes[2]}│gamma`,
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
      message: `[TO MODEL] [E_STALE_RANGE] x.\n${hashes[0]}│alpha`,
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
      message: `[TO MODEL] [E_STALE_RANGE] line 3 gone.\nCurrent range:\n${hashes[2]}│delta`,
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
      message: "[TO MODEL] [E_STALE_RANGE] the target is gone.",
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
      message: `[TO MODEL] [E_STALE_RANGE] x.\nCurrent range:\n${hashes[0]}│alpha\n${RETRY_AFFORDANCE} (no read needed).`,
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

  it("windows is part of the read contract; unknown-field rejection stays leak-free (R12, FU-6 flipped)", async () => {
    await withTempFile("r12.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const readText = getText(
        await harness.readTool.execute("read", {
          path: "r12.txt",
          windows: [{ offset: 1, limit: 1 }],
        }),
      );
      expect(readText).toContain("=== Lines 1-1 of 3 ===");

      let caught: unknown;
      try {
        await harness.readTool.execute("read-bad", {
          path: "r12.txt",
          ranges: [{ offset: 1, limit: 1 }],
        });
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe("E_BAD_PAYLOAD");
      const message = (caught as Error).message;
      const allowed = allowedReadParams();
      expect(allowed.length, "the tool schema exposes the allowed set").toBeGreaterThan(0);
      expect(allowed, "the schema now advertises windows").toContain("windows");
      expect(message).toBe(
        "[TO MODEL] [E_BAD_PAYLOAD] Read request contains unknown or unsupported fields: ranges.",
      );
      assertNoAllowedSetLeak(message, allowed);

      let hinted: unknown;
      try {
        rejectUnknownFields(
          { ranges: [{ offset: 1, limit: 1 }] },
          new Set(allowed),
          "Read request",
          `Allowed: ${allowed.join(", ")}.`,
        );
      } catch (error) {
        hinted = error;
      }
      expect((hinted as Error | undefined)?.message, "the control rendered a hint").toContain(
        "Allowed:",
      );
      expect(() => assertNoAllowedSetLeak((hinted as Error).message, allowed)).toThrow(
        /must not name the allowed field/,
      );
    });
  });

  it("overlapping windowed reads: an anchor pair spanning the overlap scopes the payload to the resolved region (R13)", async () => {
    await withTempFile("overlap.txt", "one\ntwo\nthree\nfour\nfive\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const windowA = servedHashes(
        getText(
          await harness.readTool.execute("read", { path: "overlap.txt", offset: 1, limit: 3 }),
        ),
      );
      const windowB = servedHashes(
        getText(
          await harness.readTool.execute("read", { path: "overlap.txt", offset: 3, limit: 3 }),
        ),
      );
      expect(windowA).toHaveLength(3);
      expect(windowB).toHaveLength(3);
      const overlap = windowA[2]!;
      expect(windowB[0]!, "both reads served the overlap line under one anchor").toBe(overlap);

      const mirror = await withWorkspace(cwd, () => loadServed("test-session", path));
      expect(mirror).toEqual([...windowA, windowB[1]!, windowB[2]!]);
      expect(mirror.filter((hash) => hash === overlap)).toHaveLength(1);

      const disk = "one\ntwo\nINSERTED\nthree\nfour\nfive\n";
      await writeFile(path, disk, "utf-8");
      let caught: unknown;
      try {
        await harness.editTool.execute("edit", {
          path: "overlap.txt",
          anchor_from: windowA[1]!,
          anchor_to: windowB[1]!,
          replace_with: "R",
        });
      } catch (error) {
        caught = error;
      }
      const fileLines = disk.split("\n").slice(0, -1);
      const fileHashes = lineHashesPure(disk.trimEnd());
      assertRegionPayload({
        error: caught,
        fileHashes,
        fileLines,
        liveStart: 2,
        liveEnd: 5,
        expectedCode: "E_STALE_RANGE",
      });

      const payload = caught as Payloadish;
      expect(payload.servedRows.map((row) => row.position)).toEqual([1, 2, 3, 4]);
      expect(payload.message).not.toContain(`${fileHashes[0]}│${fileLines[0]}`);
      expect(payload.message).not.toContain(`${fileHashes[5]}│${fileLines[5]}`);
      expect(await readFile(path, "utf-8"), "the rejection wrote nothing").toBe(disk);
    });
  });

  it("disjoint windowed reads: an anchor pair inside window A excludes window B's rows (R14)", async () => {
    await withTempFile(
      "disjoint.txt",
      "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n",
      async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
        const windowA = servedHashes(
          getText(
            await harness.readTool.execute("read", { path: "disjoint.txt", offset: 1, limit: 2 }),
          ),
        );
        const windowB = servedHashes(
          getText(
            await harness.readTool.execute("read", { path: "disjoint.txt", offset: 5, limit: 2 }),
          ),
        );
        expect(windowA).toHaveLength(2);
        expect(windowB).toHaveLength(2);
        const mirror = await withWorkspace(cwd, () => loadServed("test-session", path));
        expect(mirror).toEqual([windowA[0]!, windowA[1]!, null, null, windowB[0]!, windowB[1]!]);

        const disk = "alpha\nINSERTED\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
        await writeFile(path, disk, "utf-8");
        let caught: unknown;
        try {
          await harness.editTool.execute("edit", {
            path: "disjoint.txt",
            anchor_from: windowA[0]!,
            anchor_to: windowA[1]!,
            replace_with: "R",
          });
        } catch (error) {
          caught = error;
        }
        const fileLines = disk.split("\n").slice(0, -1);
        const fileHashes = lineHashesPure(disk.trimEnd());
        assertRegionPayload({
          error: caught,
          fileHashes,
          fileLines,
          liveStart: 1,
          liveEnd: 3,
          expectedCode: "E_STALE_RANGE",
        });

        const payload = caught as Payloadish;
        expect(payload.servedRows.map((row) => row.position)).toEqual([0, 1, 2]);
        for (const outside of [3, 4, 5, 6]) {
          expect(payload.message).not.toContain(`${fileHashes[outside]}│${fileLines[outside]}`);
        }
        expect(await readFile(path, "utf-8"), "the rejection wrote nothing").toBe(disk);
      },
    );
  });

  it("a rejection re-serves only its region and leaves out-of-region slots untouched (ADR-0043)", async () => {
    await withTempFile(
      "region.txt",
      "alpha\nbeta\ngamma\ndelta\nepsilon\n",
      async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
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

        const disk = "alpha\nINSERTED\nbeta\ngamma\ndelta\nepsilon\n";
        await writeFile(path, disk, "utf-8");
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
        expect(String((caught as Error).message)).toContain("[E_STALE_RANGE]");
        const payload = caught as Payloadish;
        const after = await withWorkspace(cwd, () => loadServed("test-session", path));
        const currentHashes = lineHashesPure(disk.trimEnd());
        expect(payload.servedRows.map((row) => row.position)).toEqual([0, 1, 2]);
        expect(after.slice(0, 3)).toEqual(currentHashes.slice(0, 3));
        expect(after.slice(3).every((slot) => slot === null)).toBe(true);
        const diskLines = disk.split("\n").slice(0, -1);
        for (const outside of [3, 4, 5]) {
          expect(payload.message).not.toContain(`${currentHashes[outside]}│${diskLines[outside]}`);
        }
        expect(await readFile(path, "utf-8"), "the rejection wrote nothing").toBe(disk);
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

      const pinAfter = store.getFileUndo(path);
      expect(pinAfter).toEqual(pinBefore);
      expect(store.lineageFor(path, pinAfter!.snapshotHash!).length).toBeGreaterThan(0);
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("the noop-loop refusal carries its whole span's rows and leases the interior it shows (#218)", async () => {
    await withTempFile("noop.txt", "one\ntwo\nthree\nfour\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const fullKey = sessionKeyFor(harness.sessionKey);
      const first = servedHashes(
        getText(await harness.readTool.execute("read", { path: "noop.txt", offset: 1, limit: 1 })),
      );
      const last = servedHashes(
        getText(await harness.readTool.execute("read", { path: "noop.txt", offset: 4, limit: 1 })),
      );
      expect(first).toHaveLength(1);
      expect(last).toHaveLength(1);
      const before = await withWorkspace(cwd, () => loadServed(fullKey, path));
      expect([before[0], before[3]]).toEqual([first[0], last[0]]);
      expect(before.slice(1, 3)).toEqual([null, null]);

      const call = (): Promise<{ content: Array<{ text?: string }> }> =>
        harness.editTool.execute("edit", {
          file: "noop.txt",
          edits: [
            { anchor_from: first[0]!, anchor_to: last[0]!, replace_with: "one\ntwo\nthree\nfour" },
          ],
        });
      await call();
      await call();
      let caught: unknown;
      try {
        await call();
      } catch (error) {
        caught = error;
      }

      const disk = await readFile(path, "utf-8");
      assertRegionPayload({
        error: caught,
        fileHashes: lineHashesPure(disk.trimEnd()),
        fileLines: disk.split("\n").slice(0, -1),
        liveStart: 1,
        liveEnd: 4,
        expectedCode: "E_NOOP_LOOP",
        heading: "Current on-disk range",
      });
      const after = await withWorkspace(cwd, () => loadServed(fullKey, path));
      expect(after.slice(1, 3).every((slot) => slot !== null)).toBe(true);
      expect(after).toEqual(lineHashesPure(disk.trimEnd()));
    });
  });
});
