import { describe, expect, it } from "vitest";
import {
  ServedRejectionError,
  verifyRebasedSpan,
  verifyServedRange,
  type LeaseSpanSource,
} from "../../src/hashline/index.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";
import { codeOf } from "../../src/utils.js";
import type { SpanMode } from "../../src/span-mode.js";

/**
 * #144 T2: strict span mode's leased-route refusal. Strict narrows upstream ADR-0024 decision 1
 * (an interior `null` is accepted) to fully served spans: a leased window that replaces a
 * never-served interior row rejects with one aggregated `E_UNSERVED_RANGE` (`unservedKind`
 * "interior"), rowless, naming every unserved absolute file line ascending and run-compressed.
 *
 * The refusal is aggregated AFTER the identity gate's loop so a concrete staleness elsewhere
 * still wins precedence; the boundary `E_STALE_RANGE` arm and the mirror route are untouched
 * (`refusesInteriorHole` is leased-only and builds on `acceptsInteriorHole`).
 *
 * Falsifier: make `refusesInteriorHole` always false → cases 2/4/5/6/7 accept the holed window.
 */

const LINES = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`);
const HASHES = lineHashesPure(LINES.join("\n"));

/** Leases for all 24 lines, each live at its own coordinate (no shift). */
function denseSource(): LeaseSpanSource {
  const ids = new Map<string, number>();
  HASHES.forEach((hash, i) => ids.set(hash, i + 1));
  return {
    leaseFor: (anchor) => {
      const lineId = ids.get(anchor);
      if (lineId === undefined) return undefined;
      return {
        lineId,
        servedLineNumber: lineId,
        servedSnapshotHash: "S",
        retiredAt: null,
      };
    },
    rebasedLineOf: (lineId) => (lineId >= 1 && lineId <= HASHES.length ? lineId : undefined),
    anchorHomes: () => [],
  };
}

/** Lines 1..total; a line listed in `holes` is a never-served (`null`) mirror slot. */
function windowWithHoles(total: number, holes: number[]): (string | null)[] {
  return Array.from({ length: total }, (_, i) => (holes.includes(i + 1) ? null : HASHES[i]!));
}

function verifyWindow(keys: (string | null)[], spanMode?: SpanMode): void {
  verifyServedRange({
    served: keys,
    startHash: keys[0]!,
    endHash: keys[keys.length - 1]!,
    startLine: 1,
    endLine: keys.length,
    fileHashes: HASHES.slice(0, keys.length),
    fileLines: LINES.slice(0, keys.length),
    filePath: "x.ts",
    leaseSource: denseSource(),
    ...(spanMode === undefined ? {} : { spanMode }),
  });
}

function rejectionOf(fn: () => void): ServedRejectionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ServedRejectionError);
    return error as ServedRejectionError;
  }
  throw new Error("expected a ServedRejectionError, none was thrown");
}

describe("strict span mode — leased-route interior refusal (#144 T2)", () => {
  it("strict span mode: absent and hint keep the tolerant leased route byte-identical", () => {
    expect(() => verifyWindow(windowWithHoles(3, [2]))).not.toThrow();
    expect(() => verifyWindow(windowWithHoles(3, [2]), "hint")).not.toThrow();
  });

  it("strict span mode: a single interior hole rejects rowless and names the unserved line", () => {
    const rejection = rejectionOf(() => verifyWindow(windowWithHoles(3, [2]), "strict"));
    expect(codeOf(rejection)).toBe("E_UNSERVED_RANGE");
    expect(rejection.unservedKind).toBe("interior");
    expect(rejection.servedRows).toEqual([]);
    expect(rejection.servedBlock).toBe("");
    expect(rejection.firstOffendingLine).toBe(2);
    expect(rejection.message).toContain(
      "Strict span mode refused the edit to x.ts: 1 of the 3 file lines it replaces was never served.",
    );
    expect(rejection.message).toContain("Unserved file line: 2");
  });

  it("strict span mode: a fully served window still passes", () => {
    expect(() => verifyWindow(windowWithHoles(3, []), "strict")).not.toThrow();
  });

  it("strict span mode: a contiguous interior run renders as one range", () => {
    const rejection = rejectionOf(() => verifyWindow(windowWithHoles(7, [4, 5, 6]), "strict"));
    expect(rejection.message).toContain("3 of the 7 file lines it replaces were never served.");
    expect(rejection.message).toContain("Unserved file lines: 4-6");
  });

  it("strict span mode: non-contiguous holes are run-compressed in ascending order", () => {
    const rejection = rejectionOf(() => verifyWindow(windowWithHoles(7, [4, 6]), "strict"));
    expect(rejection.message).toContain("Unserved file lines: 4, 6");
  });

  it("strict span mode: a second run renders after the first without merging", () => {
    // WHY the 10-line window: the unserved set must stay strictly interior, so line 9 cannot be
    // the window's closing boundary — a `null` boundary keeps its own `E_STALE_RANGE` arm.
    const rejection = rejectionOf(() => verifyWindow(windowWithHoles(10, [4, 5, 6, 9]), "strict"));
    expect(rejection.message).toContain("Unserved file lines: 4-6, 9");
  });

  it("strict span mode: the unserved list caps at eight runs and counts the hidden lines", () => {
    const rejection = rejectionOf(() =>
      verifyWindow(windowWithHoles(21, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]), "strict"),
    );
    expect(rejection.message).toContain("10 of the 21 file lines it replaces were never served.");
    expect(rejection.message).toContain(
      "Unserved file lines: 2, 4, 6, 8, 10, 12, 14, 16 (+2 more lines)",
    );
  });

  it("strict span mode: a null boundary keeps the fail-closed E_STALE_RANGE arm", () => {
    const rejection = rejectionOf(() =>
      verifyRebasedSpan({
        served: [HASHES[0]!, HASHES[1]!, null],
        servedStart: 1,
        servedEnd: 3,
        rebasedStart: 1,
        rebasedEnd: 3,
        route: { kind: "leased", source: denseSource() },
        echo: "",
        echoRows: [],
        where: " in x.ts",
        filePath: "x.ts",
        spanMode: "strict",
      }),
    );
    expect(codeOf(rejection)).toBe("E_STALE_RANGE");
    expect(rejection.message).toContain("line 3 in x.ts was never served.");
    expect(rejection.details.cause).toBe("never-served");
  });

  it("strict span mode: the mirror route's own interior scan is unchanged", () => {
    const rejection = rejectionOf(() =>
      verifyServedRange({
        served: windowWithHoles(3, [2]),
        startHash: HASHES[0]!,
        endHash: HASHES[2]!,
        startLine: 1,
        endLine: 3,
        fileHashes: HASHES.slice(0, 3),
        fileLines: LINES.slice(0, 3),
        filePath: "x.ts",
        spanMode: "strict",
      }),
    );
    expect(codeOf(rejection)).toBe("E_UNSERVED_RANGE");
    expect(rejection.unservedKind).toBe("interior");
    expect(rejection.firstOffendingLine).toBe(2);
  });
});
