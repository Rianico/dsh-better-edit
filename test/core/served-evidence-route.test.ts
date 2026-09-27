import { describe, expect, it } from "vitest";
import {
  ServedRejectionError,
  verifyRebasedSpan,
  verifyServedRange,
  type LeaseSpanSource,
} from "../../src/hashline/index.js";
import { DomainError } from "../../src/domain-errors.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";
import { codeOf } from "../../src/utils.js";

/**
 * APSD-P1: the leased/mirror interior-hole conjunction, pinned as one route value's
 * decisions. The five sites (boundary interception, never-served interior scan, identity-gate
 * route, position-check null skip, and the gate's interior-accept / boundary-reject rule)
 * are constructed exactly once from `args.leaseSource` in `verifyServedRange`.
 *
 * Flip procedure (load-bearing proof, run before committing any change to the route):
 * invert `acceptsInteriorHole` in src/hashline/anchor-pipeline.ts
 * (`k !== 0 && k !== servedLen - 1` → `k === 0 || k === servedLen - 1`) and run `pnpm test`:
 * the authoritative RED set is ledger id RX1M1 (test/tools/mutate-ledger.mjs) — 8/8
 * interior-hole cells spanning this file, lease-resolve-seam, range-family-retry-truth
 * (C2) and read-windows; run `node test/tools/mutate-ledger.mjs RX1M1` (NO_COLOR=1) to
 * re-measure. The same one-family property holds for `owesInteriorScan` and
 * `checksPosition` — the falsifier comments below name the landing per cell.
 */

const FILE_LINES = ["alpha", "beta", "gamma"];
const FILE_HASHES = lineHashesPure(FILE_LINES.join("\n"));
const [H0, H1, H2] = FILE_HASHES as [string, string, string];

/** Leases for all three lines, each live at its own coordinate (no shift). */
function denseSource(): LeaseSpanSource {
  const ids: Record<string, number> = { [H0]: 11, [H1]: 12, [H2]: 13 };
  return {
    leaseFor: (anchor) => {
      const lineId = ids[anchor];
      if (lineId === undefined) return undefined;
      return {
        lineId,
        servedLineNumber: lineId - 10,
        servedSnapshotHash: "S",
        retiredAt: null,
      };
    },
    rebasedLineOf: (lineId) => (lineId >= 11 && lineId <= 13 ? lineId - 10 : undefined),
  };
}

/** The ServedRejectionError of a call that must throw. */
function rejectionFrom(fn: () => void): ServedRejectionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ServedRejectionError);
    return error as ServedRejectionError;
  }
  throw new Error("expected a ServedRejectionError, none was thrown");
}

/** The rejection code of a call, or undefined when it did not throw. */
function codeOfCall(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ServedRejectionError);
    return codeOf(error);
  }
}

/** The three-row window whose middle mirror slot is a never-served interior hole. */
const HOLED: (string | null)[] = [H0, null, H2];

function verifyE2E(leaseSource?: LeaseSpanSource): void {
  verifyServedRange({
    served: HOLED,
    startHash: H0,
    endHash: H2,
    startLine: 1,
    endLine: 3,
    fileHashes: [...FILE_HASHES],
    fileLines: [...FILE_LINES],
    ...(leaseSource === undefined ? {} : { leaseSource }),
  });
}

function verifyGate(served: (string | null)[]): void {
  verifyRebasedSpan({
    served,
    servedStart: 1,
    servedEnd: 3,
    rebasedStart: 1,
    rebasedEnd: 3,
    route: { kind: "leased", source: denseSource() },
    echo: "echo-block",
    echoRows: [{ position: 0, hash: H0 }],
    where: " in x.ts",
  });
}

describe("interior-hole conjunction — ServedEvidenceRoute answers the five sites (APSD-P1)", () => {
  it("interior-hole conjunction: the leased route accepts a holed window end-to-end", () => {
    // The ONLY permissive decisions on this path are the gate's `acceptsInteriorHole` and the
    // position-check `checksPosition` skip; the scan is off via `owesInteriorScan`.
    // Falsifier: invert `acceptsInteriorHole` or `checksPosition` → E_STALE_RANGE at line 2;
    // flip the scan's route test to run on leased → E_UNSERVED_RANGE. Both land in this family.
    expect(codeOfCall(() => verifyE2E(denseSource()))).toBeUndefined();
  });

  it("interior-hole conjunction: the gate accepts an interior null and verifies the boundary leases", () => {
    // Falsifier: invert `acceptsInteriorHole` → E_STALE_RANGE "was never served" at line 2.
    expect(codeOfCall(() => verifyGate([H0, null, H2]))).toBeUndefined();
  });

  it("interior-hole conjunction: the gate rejects a null end-boundary — the named anchor stays fail-closed", () => {
    // The same window with the hole at k = servedLen - 1: `acceptsInteriorHole` must say no.
    // Falsifier: invert `acceptsInteriorHole` → the boundary is accepted, falls to
    // `leaseFor(null)` and the headline changes to "no served line identity." — this assert
    // goes RED while the interior-accept cells above flip in the same run: one family.
    const error = rejectionFrom(() => verifyGate([H0, H1, null]));
    expect(codeOf(error)).toBe("E_STALE_RANGE");
    expect(String(error.message)).toContain("line 3 in x.ts was never served.");
    expect(error.details.cause).toBe("never-served");
  });

  it("interior-hole conjunction: the mirror route rejects the same hole via its interior scan", () => {
    // Decision 2: on the mirror route the scan owns the hole — the gate never runs.
    // Falsifier: invert `owesInteriorScan` (leased↔mirror) → this rejects with E_STALE_RANGE
    // from the position comparison instead; the leased end-to-end cell flips to
    // E_UNSERVED_RANGE. Both are interior-hole-conjunction cells.
    const error = rejectionFrom(() => verifyE2E());
    expect(codeOf(error)).toBe("E_UNSERVED_RANGE");
    expect(error.unservedKind).toBe("interior");
    expect(error.firstOffendingLine).toBe(2);
  });

  it("interior-hole conjunction: the mirror route accepts a dense window (the scan is not a blanket reject)", () => {
    // Guards against a route inversion that would make the mirror scan reject everything:
    // a holed-out mirror is still refused (cell above), a served-dense mirror passes.
    expect(
      codeOfCall(() =>
        verifyServedRange({
          served: [...FILE_HASHES],
          startHash: H0,
          endHash: H2,
          startLine: 1,
          endLine: 3,
          fileHashes: [...FILE_HASHES],
          fileLines: [...FILE_LINES],
        }),
      ),
    ).toBeUndefined();
  });

  it("interior-hole conjunction: an unleased boundary is refused at the interception before the hole is judged", () => {
    // The boundary-interception site consults the SAME route value: leased kind, missing
    // boundary lease → E_UNKNOWN_ANCHOR, no rows, the hole never reaches the gate.
    // Falsifier: hard-code the interception to always run (drop the route test) → the mirror
    // cells above turn RED with E_UNKNOWN_ANCHOR (the mirror route has no source to consult).
    const noStartLease: LeaseSpanSource = {
      leaseFor: (anchor) => (anchor === H2 ? denseSource().leaseFor(H2) : undefined),
      rebasedLineOf: () => 3,
    };
    let thrown: unknown;
    try {
      verifyE2E(noStartLease);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).not.toBeInstanceOf(ServedRejectionError);
    expect(codeOf(thrown as DomainError)).toBe("E_UNKNOWN_ANCHOR");
  });
});
