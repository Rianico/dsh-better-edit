import { readFile, writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import {
  canon,
  lineHashesPure,
  ServedRejectionError,
  verifyServedRange,
} from "../../src/hashline/index.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { codeOf } from "../../src/utils.js";

beforeAll(async () => {
  await initHasher();
});

/**
 * CONTRACT: a served span is verified against the file EXACTLY. Each boundary anchor
 * must have exactly one served position, the served span's length must equal the
 * requested range's length, and every line's hash must equal the served hash at its
 * served position. Anything else rejects with `ServedRejectionError` (`E_STALE_RANGE`,
 * or `E_UNSERVED_RANGE` when a boundary anchor has zero or multiple served positions).
 * The edit NEVER re-binds onto a surviving twin.
 *
 * Case 1 — externally deleting the anchored line leaves the surviving byte-identical
 * twin holding the deleted line's anchor; the edit must reject and write nothing.
 * Refutability (a) `strictPos`: removing the `strictPos` branch in `verifyServedRange`
 * (src/hashline/anchor-pipeline.ts — `if (strictPos && from !== startLine - 1)`) lets
 * the edit apply to the surviving twin (no rejection, file changes), so this test goes
 * red. The surviving twin keeps the deleted line's hash (fresh allocation hands the
 * only remaining occurrence the base slot), the served canon still matches (identical
 * bytes), and only the served POSITION disagrees — exactly what `strictPos` pins.
 *
 * Case 2 — an orphaned serve (the same hash written at a new position while the old
 * served slot survives) makes the boundary anchor ambiguous; the span must reject with
 * `E_UNSERVED_RANGE` naming both positions.
 * Refutability (b) candidate-span enumeration: re-introducing the `(s, e)` pair search
 * that CP2 deleted (ADR-0004 orphan-span healing) resolves the ambiguity to the first
 * content-matching candidate and the span verifies clean — no rejection, test red.
 * That search IS the "heal and proceed" arm this contract removes.
 */
describe("deleted twin anchor (strictPos lock)", () => {
  it("rejects E_STALE_RANGE and writes nothing when the anchored line was deleted externally", async () => {
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
      // … with E_STALE_RANGE (surfaced inside the batch wrapper) …
      expect(String((error as Error).message)).toMatch(/E_STALE_RANGE/);
      // F7 pin: read-required shape — "Re-read." headline, a non-empty
      // `Current range:` section, and no retry hint.
      const message = String((error as Error).message);
      expect(message).toContain("Re-read.");
      expect(message).toContain("Current range:");
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

  it("CHARACTERIZATION for T3c: the pos-free path re-binds onto the surviving twin", () => {
    // NOT a contract — this records a KNOWN FAIL-OPEN for the lease-resolve seam (T3c).
    // `strictPos` is conditional (src/mutation.ts:152-155): false whenever
    // `epochSnapshotId` or `curSnapshotId` is undefined, i.e. a first edit with no epoch.
    // On that path the served position is trusted without evidence, so the same rebind
    // that case 1 rejects under `strictPos: true` is accepted here. Measured, not fixed.
    const fileLines = ["twin", "other"];
    const fileHashes = lineHashesPure(fileLines.join("\n"));
    const hTwin = fileHashes[0]!;
    const hOther = fileHashes[1]!;

    // Served when the twin sat at position 1 (a line preceded it). That predecessor
    // was then deleted externally, so the twin's bytes now sit at position 0 while the
    // served slot still points at 1.
    const served = [hOther, hTwin];
    const servedCanons = [canon("other"), canon("twin")];

    const reject = (strictPos: boolean): string | undefined => {
      try {
        verifyServedRange({
          served: [...served],
          servedCanons: [...servedCanons],
          startHash: hTwin,
          endHash: hTwin,
          startLine: 1,
          endLine: 1,
          fileHashes: [...fileHashes],
          fileLines: [...fileLines],
          strictPos,
        });
        return undefined;
      } catch (error) {
        expect(error).toBeInstanceOf(ServedRejectionError);
        return codeOf(error);
      }
    };

    // Pos-restricted (both epoch ids present): the position mismatch is caught.
    expect(reject(true)).toBe("E_STALE_RANGE");
    // Pos-free (epoch ids undefined): OBSERVED REBIND — the span is accepted and the
    // served slot at 1 silently re-binds onto the file's line 0. T3c finding, not a
    // T3a defect; do not "fix" this here.
    expect(reject(false)).toBeUndefined();
  });
});
