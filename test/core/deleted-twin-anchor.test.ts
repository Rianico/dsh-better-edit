import { readFile, writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import {
  canon,
  lineHashesPure,
  ServedRejectionError,
  verifyServedRange,
} from "../../src/hashline/index.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { codeOf } from "../../src/utils.js";

beforeAll(async () => {
  await initHasher();
});

/**
 * CONTRACT: a served span is verified against the file EXACTLY. Each boundary anchor
 * must have exactly one served position, the served span's length must equal the
 * requested range's length, and every line's hash must equal the served hash at its
 * served position. Since FU-4 the rejections are granular: a leased boundary whose line
 * identity is gone rejects `E_TARGET_LOST` at the interception
 * (`src/hashline/served-evidence.ts`, `interceptLeaseBoundaries`), a zero-served-position anchor
 * rejects `E_UNKNOWN_ANCHOR` (`verifyServedRange`), an ambiguous boundary keeps
 * `E_UNSERVED_RANGE` with rows,
 * and the `verifyRebasedSpan` gate keeps `E_STALE_RANGE`. The edit NEVER re-binds onto a
 * surviving twin. Under the aligned edit load (T3, ADR-0050) a deleted twin's anchor is
 * ABSENT from the aligned buffer, so the refusal lands on the stale-anchor arm
 * (`E_STALE_ANCHOR`, anchors that resolve to nothing) before any lease-identity interception
 * can mint `E_TARGET_LOST`; that interception arm stays covered by
 * `test/core/lease-resolve-seam.test.ts` (direct `verifyRebasedSpan` calls).
 *
 * Case 1 — externally deleting the anchored line leaves the surviving byte-identical
 * twin holding the deleted line's anchor; the edit must reject and write nothing.
 * Refutability (a) identity arms, not the position check: Case 1 runs on the tool path (a lease
 * source is present), and the alignment leaves the deleted line's anchor with no position in
 * the buffer, so `valEdit` reports it stale and `E_STALE_ANCHOR` refuses the submission. Drop
 * the aligned load (or its retired-anchor block) and the surviving twin's spelling would
 * resolve again — this test goes red. The twin keeps the deleted line's hash and its canon
 * still matches; only identity disagrees, and under alignment identity decides before content.
 * The lease-identity interception (`E_TARGET_LOST`) is pinned at arm level by
 * `test/core/lease-resolve-seam.test.ts` (direct `verifyRebasedSpan` calls). The
 * position check (`verifyServedRange`'s lease-less fallback) is pinned by the pos-free test in this
 * file (`:159`), not Case 1.
 *
 * Case 2 — an orphaned serve (the same hash written at a new position while the old
 * served slot survives) makes the boundary anchor ambiguous; the span must reject with
 * `E_UNSERVED_RANGE` naming both positions.
 * Refutability (b) candidate-span enumeration: re-introducing the `(s, e)` pair search
 * that CP2 deleted (ADR-0004 orphan-span healing) resolves the ambiguity to the first
 * content-matching candidate and the span verifies clean — no rejection, test red.
 * That search IS the "heal and proceed" arm this contract removes.
 */
describe("deleted twin anchor (exact position lock)", () => {
  it("rejects E_STALE_ANCHOR and writes nothing when the anchored line was deleted externally", async () => {
    const initial =
      "export function alpha() {\n" +
      "  return compute(value);\n" +
      "}\n" +
      "\n" +
      "export function beta() {\n" +
      "  return compute(value);\n" +
      "}\n";

    await withTempFile("twins.ts", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "twins.ts" });
      const rows = getText(read).split("\n");
      const twinRows = rows.filter((line) => line.endsWith("│  return compute(value);"));
      expect(twinRows).toHaveLength(2);
      const firstAnchor = extractHash(twinRows[0]!);
      const secondAnchor = extractHash(twinRows[1]!);
      // Position/context derived: identical bytes, different anchors.
      expect(firstAnchor).not.toBe(secondAnchor);

      // Externally delete the FIRST occurrence (out-of-band; no serve recording).
      const external = initial.replace("  return compute(value);\n", "");
      expect(external).not.toBe(initial);
      await writeFile(path, external, "utf-8");

      let error: unknown;
      try {
        await editTool.execute("stale-twin", {
          path: "twins.ts",
          anchor_from: firstAnchor,
          anchor_to: firstAnchor,
          replace_with: "  return changed;",
        });
      } catch (e) {
        error = e;
      }
      // The call rejects …
      expect(error).toBeDefined();
      // … with E_STALE_ANCHOR at anchor resolution (surfaced inside the batch wrapper): the
      // aligned buffer holds no line with the deleted twin's spelling, so the anchor is stale —
      // the rowless shape: the headline names the anchor and carries the re-read remedy, with
      // NO rows (the envelope's own `Current on-disk range` note is not a payload row), and no
      // retry hint.
      const message = String((error as Error).message);
      expect(message).toMatch(/E_STALE_ANCHOR/);
      expect(message).toContain(
        `1 stale anchor in twins.ts: "${firstAnchor}". Re-read for fresh anchors.`,
      );
      expect(message).not.toContain("Current range:");
      expect(message).not.toContain("Retry with these anchors");
      // … and the file on disk is byte-identical to the externally-written
      // content: the edit never re-bound onto the surviving twin.
      expect(await readFile(path, "utf-8")).toBe(external);
    });
  });

  it("rejects E_UNSERVED_RANGE when an orphaned serve leaves the boundary ambiguous", () => {
    // Built through `verifyServedRange` directly rather than the store/read/edit path:
    // producing an orphaned serve (one hash at two served positions) requires writing
    // served rows out of band, which is the lease-resolve seam T3c owns. The seam is
    // exported from src/hashline/index.ts for exactly this, and the property under test
    // — an ambiguous boundary rejects — is the verification rule itself.
    const fileLines = ["alpha", "beta", "gamma"];
    const fileHashes = lineHashesPure(fileLines.join("\n"));
    const hAlpha = fileHashes[0]!;
    const hBeta = fileHashes[1]!;
    const servedCanons = fileLines.map((line) => canon(line));

    // Control: without the orphan, this exact span verifies clean — so the rejection
    // below is caused by the ambiguity, not by the span being wrong.
    expect(() =>
      verifyServedRange({
        served: [...fileHashes],
        servedCanons: [...servedCanons],
        startHash: hAlpha,
        endHash: hBeta,
        startLine: 1,
        endLine: 2,
        fileHashes: [...fileHashes],
        fileLines: [...fileLines],
      }),
    ).not.toThrow();

    // Orphaned serve: `hAlpha` was written at position 2 while its old slot at
    // position 0 survived. Pre-CP2 the eager heal nulled position 0 and the lazy
    // candidate search re-bound the span onto the look-alike; now it rejects.
    let code: string | undefined;
    let message = "";
    try {
      verifyServedRange({
        served: [hAlpha, hBeta, hAlpha],
        servedCanons: [...servedCanons],
        startHash: hAlpha,
        endHash: hBeta,
        startLine: 1,
        endLine: 2,
        fileHashes: [...fileHashes],
        fileLines: [...fileLines],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ServedRejectionError);
      code = codeOf(error);
      message = error instanceof Error ? error.message : String(error);
    }
    expect(code).toBe("E_UNSERVED_RANGE");
    expect(message).toContain("was served at 2 positions");
  });

  it("rejects E_STALE_RANGE on the pos-free path too — the position check is unconditional", () => {
    // The position check in `verifyServedRange` is UNCONDITIONAL. The pos-free path is
    // reachable on a normal session route (the epoch pin was written only by a FULL read,
    // and a windowed read is never a full read), so a moved span must reject rather than
    // silently re-bind onto the line that now holds the same bytes.
    // Refutability: delete the `if (from !== startLine - 1)` rejection -> `reject()` returns
    // undefined instead of E_STALE_RANGE (green-with-a-write).
    const fileLines = ["twin", "other"];
    const fileHashes = lineHashesPure(fileLines.join("\n"));
    const hTwin = fileHashes[0]!;
    const hOther = fileHashes[1]!;

    // Served when the twin sat at position 1 (a line preceded it). That predecessor was
    // then deleted externally, so the twin's bytes now sit at position 0 while the served
    // slot still points at 1.
    const served = [hOther, hTwin];
    const servedCanons = [canon("other"), canon("twin")];

    // No copies: the seam is pure, so rejecting must not mutate the caller's mirror.
    const reject = (): string | undefined => {
      try {
        verifyServedRange({
          served,
          servedCanons,
          startHash: hTwin,
          endHash: hTwin,
          startLine: 1,
          endLine: 1,
          fileHashes,
          fileLines,
        });
        return undefined;
      } catch (error) {
        expect(error).toBeInstanceOf(ServedRejectionError);
        return codeOf(error);
      }
    };

    // The epoch state no longer decides whether a moved span is caught: the unconditional
    // position check rejects it outright.
    expect(reject()).toBe("E_STALE_RANGE");
    // Rejecting is pure — no write reaches the caller's served mirror.
    expect(served).toEqual([hOther, hTwin]);
    expect(servedCanons).toEqual([canon("other"), canon("twin")]);
  });

  it("rejects E_STALE_ANCHOR when a WINDOWED read served the twin (alignment makes the spelling absent)", async () => {
    // The reachable route this pins: the epoch pin was written only inside
    // `if (isFullRead)` and `isFullRead` requires `rows.length === full.hashes.length`, so a
    // WINDOWED read never pinned it for that (session, path). The windowed read's served rows
    // still carry leases. Since T3 the edit load aligns to the latest lineage, so the deleted
    // twin's spelling is ABSENT from the buffer and the refusal happens at anchor resolution
    // (`E_STALE_ANCHOR`) — before the lease-identity interception could mint `E_TARGET_LOST`;
    // the pos-free route itself is pinned by the direct cell above. Before the position
    // check was made unconditional this edit silently applied to the surviving twin.
    const initial =
      "export function alpha() {\n" +
      "  return compute(value);\n" +
      "}\n" +
      "\n" +
      "export function beta() {\n" +
      "  return compute(value);\n" +
      "}\n";

    await withTempFile("windowed-twin.ts", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      // WINDOWED read (never a full read): serves lines 1-3, which includes the first
      // occurrence of the duplicated line.
      const read = await readTool.execute("windowed-route", {
        path: "windowed-twin.ts",
        offset: 1,
        limit: 3,
      });
      const rows = getText(read).split("\n");
      const twinRows = rows.filter((line) => line.endsWith("│  return compute(value);"));
      expect(twinRows).toHaveLength(1);
      const firstAnchor = extractHash(twinRows[0]!);

      // Externally delete the FIRST occurrence (out-of-band; no serve recording). The
      // survivor takes the base slot, so `firstAnchor` now resolves three lines lower
      // while the served slot still points at line 2.
      const external = initial.replace("  return compute(value);\n", "");
      expect(external).not.toBe(initial);
      await writeFile(path, external, "utf-8");

      let error: unknown;
      try {
        await editTool.execute("windowed-route", {
          path: "windowed-twin.ts",
          anchor_from: firstAnchor,
          anchor_to: firstAnchor,
          replace_with: "  return changed;",
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(String((error as Error).message)).toMatch(/E_STALE_ANCHOR/);
      // Byte-identical: the edit never re-bound onto the surviving twin.
      expect(await readFile(path, "utf-8")).toBe(external);
    });
  });
});
