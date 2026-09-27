import { readFile, writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import type { ServedRow } from "../../src/domain-errors.js";
import { localIO, mapFsError } from "../../src/fs-bridge.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { lineHashesPure } from "../../src/hashline/index.js";
import { loadServed } from "../../src/session-view.js";
import { withWorkspace } from "../../src/workspace-context.js";
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
 *
 * Payload shape is disjoint by ROW COUNT (ADR-0022 §Decision 2, refined by FU-4's code
 * granularity): a row-less payload is the grounding-void shape — either a granular refusal
 * (`E_UNKNOWN_ANCHOR`, no read wording by upstream's text) asserted directly at its cell, or
 * the target-lost shape (read instruction in the headline); a row-carrying payload renders
 * `Current range:` (or `Current range (fresh read):` for `E_UNVERIFIED_RANGE`) and its rows.
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

  // Either end null means the window is unidentifiable (call sites pair null with null).
  if (args.liveStart === null || args.liveEnd === null) {
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
    // `defineTool` compiles the author-facing parameter map into a raw object-rooted schema; the
    // allowed set lives under `.properties`, not on the root (`type`/`properties` are schema keys).
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

  // FU-3 (upstream ADR-0024 decision 1, adopted): the interior-hole arm no longer fires on the
  // leased route — the tool path always carries a lease source, so the identity gate owns the
  // span and accepts the hole. This cell keeps pinning the E_UNSERVED_RANGE payload shape on the
  // boundary arm, which runs before the gate and rejects regardless of leases. The non-leased
  // interior rejection is pinned in test/core/error-codes.test.ts ("interior hole carries
  // E_UNSERVED_RANGE with kind").
  // FU-4 granularity: a boundary anchor the mirror never placed was never served for this
  // file — upstream refuses it with `E_UNKNOWN_ANCHOR` and NO rows (b92e0ec:src/hashline/
  // served-verification.ts:729-749), so `assertRegionPayload`'s row-shape branches do not
  // apply: the region is unidentifiable AND the message does not name a read. Asserted directly.
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
      // The `to` anchor exists on disk (line 3) but was never served, so it has no served position.
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
      // The granular refusal itself renders no rows — checked on the message: the payload
      // emits no `Current range:` heading (the envelope's separate `Current on-disk range`
      // echo at engine.ts:509 is an F5 convenience derived from the submitted anchors'
      // live window, not payload rows).
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

  // ---- planted violations: the guard must be able to fail ----
  it("negative control: a misplaced row fails the live-mapping check", () => {
    const hashes = lineHashesPure(DISK.trimEnd());
    const misplaced: ServedRow = { position: 0, hash: hashes[2]! };
    const planted = plantedError({
      code: "E_STALE_RANGE",
      // The planted payload wears the right heading, so the check fails on the row identity.
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
      // FU-6 (port of pi-better-edit@2334352, superseding ADR-0023's decline): `windows` reads are
      // served in one call — the R12 pin flipped from "windows is rejected" to "windows works",
      // while the discoverability invariant keeps a NON-contract field.
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
      // The failure is exactly the offending-field line: the `hint` suffix (src/utils.ts:26-40) is
      // the only place an allowed-set list could be appended, and any hint changes this string.
      expect(message).toBe(
        "[TO MODEL] [E_BAD_PAYLOAD] Read request contains unknown or unsupported fields: ranges.",
      );
      // The invariant, stated in terms of the DERIVED schema — no retyped list enters this file.
      assertNoAllowedSetLeak(message, allowed);

      // Demonstration control (required): `rejectUnknownFields` builds this message and its `hint`
      // argument is the only way the suffix is populated. Called WITH a hint, the ban must fail —
      // otherwise the assertion above would be vacuous.
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

  // ---- multi-region interaction (ADR-0023): the two cells that retire ADR-0022's declared limit.
  // Both express N served regions with N sequential `offset`/`limit` reads — since FU-6 a single
  // `windows` call serves N regions too, but these cells pin the sequential path on purpose: the
  // region oracle must scope a payload regardless of how the regions were served.
  // Each cell fails if a rejection payload starts carrying rows outside the
  // region the submitted anchors identify (e.g. the union of every served window).
  it("overlapping windowed reads: an anchor pair spanning the overlap scopes the payload to the resolved region (R13)", async () => {
    await withTempFile("overlap.txt", "one\ntwo\nthree\nfour\nfive\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      // Read A serves lines 1–3; read B serves lines 3–5. Line 3 is the overlap.
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

      // The serve-union the port was declined against (ADR-0023): the merged mirror holds BOTH
      // windows, and the overlap occupies exactly one position — the exact-write merge neither
      // duplicates it nor drops read A's rows.
      const mirror = await withWorkspace(cwd, () => loadServed("test-session", path));
      expect(mirror).toEqual([...windowA, windowB[1]!, windowB[2]!]);
      expect(mirror.filter((hash) => hash === overlap)).toHaveLength(1);

      // An interior insert, so the anchors' served span (3 lines) and their resolved span (4 lines)
      // disagree: the span-length arm rejects with the resolved region's current rows.
      const disk = "one\ntwo\nINSERTED\nthree\nfour\nfive\n";
      await writeFile(path, disk, "utf-8");
      let caught: unknown;
      try {
        await harness.editTool.execute("edit", {
          path: "overlap.txt",
          anchor_from: windowA[1]!, // "two" — served by read A only
          anchor_to: windowB[1]!, // "four" — served by read B only
          replace_with: "R",
        });
      } catch (error) {
        caught = error;
      }
      const fileLines = disk.split("\n").slice(0, -1);
      const fileHashes = lineHashesPure(disk.trimEnd());
      // The region is the span the submitted anchors resolve in — lines 2–5 of the new snapshot —
      // hardcoded from served-coordinate knowledge, never searched.
      assertRegionPayload({
        error: caught,
        fileHashes,
        fileLines,
        liveStart: 2,
        liveEnd: 5,
        expectedCode: "E_STALE_RANGE",
      });

      // The scoping half, as an exclusion: neither read's exclusive edge row may ride along. A
      // payload echoing the union of the two served windows (lines 1–6) reddens on these four.
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
        // Read A serves lines 1–2; read B serves lines 5–6. Lines 3–4 are never served.
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
        // The control's premise: two served regions that do not touch, with the gap left unserved.
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

        // Window B's rows are served, leased and byte-unchanged, so nothing but the region rule
        // keeps them out of this payload; the never-served gap rows are excluded with them.
        const payload = caught as Payloadish;
        expect(payload.servedRows.map((row) => row.position)).toEqual([0, 1, 2]);
        for (const outside of [3, 4, 5, 6]) {
          expect(payload.message).not.toContain(`${fileHashes[outside]}│${fileLines[outside]}`);
        }
        expect(await readFile(path, "utf-8"), "the rejection wrote nothing").toBe(disk);
      },
    );
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
