import { describe, expect, it } from "vitest";
import { codeOf } from "../../src/utils.js";
import {
  HASH_SPACE,
  canon,
  lineHashesPure,
  verifyServedRange,
  ServedRejectionError,
} from "../../src/hashline/index.js";
import { xxh32 } from "../../src/hashline/hash-assign.js";

function baseIndexOf(line: string): number {
  return (xxh32(canon(line)) >>> 14) % HASH_SPACE;
}

function searchBase(target: number, prefix: string): string | undefined {
  for (let i = 0; i < 2_000_000; i++) {
    const cand = `${prefix}-${i}`;
    if (baseIndexOf(cand) === target) return cand;
  }
  return undefined;
}

describe("canon scope is file-local, never process-global (#149 class)", () => {
  it("a canon recorded while serving file A cannot decide file B's boundary heal", () => {
    const diskCanons = ["alpha", "beta", "gamma"];
    const T = (xxh32(canon("alpha")) >>> 14) % HASH_SPACE;
    // Decoy and foreign share alpha's base slot but carry foreign canons that
    // match no disk line, so a poisoned lookup can never accidentally heal.
    const decoy = searchBase(T, "decoy");
    expect(decoy).toBeDefined();
    expect(canon(decoy!)).not.toBe(canon("alpha"));
    expect(diskCanons).not.toContain(canon(decoy!));
    const foreign = searchBase(T, "foreign");
    expect(foreign).toBeDefined();
    expect(foreign).not.toBe(decoy);
    expect(canon(foreign!)).not.toBe(canon("alpha"));
    expect(diskCanons).not.toContain(canon(foreign!));

    // Foreign file A hashes FIRST: [decoy, foreign] takes base T and T+1.
    // Pre-fix every hashing call seeds the process-global map first-write-wins,
    // so A's hashing claims hShift -> canon(foreign) before the serve-side
    // hashing below ever runs. Post-fix hashing has no side effect, so this
    // ordering is irrelevant — which is the point.
    const aLines = [decoy!, foreign!];
    const aHashes = lineHashesPure(aLines.join("\n"));

    // Serve side built from the real hashing: decoy takes base T, alpha
    // probe-shifts to hShift, beta is stable.
    const servedBase = lineHashesPure([decoy!, "alpha", "beta"].join("\n"));
    const hBase = servedBase[0]!;
    const hShift = servedBase[1]!;
    const hBeta = servedBase[2]!;
    expect(hShift).not.toBe(hBase);
    expect(aHashes[0]).toBe(hBase);
    expect(aHashes[1]).toBe(hShift);

    // The trailing duplicate is the stale duplicate that forces the
    // ambiguous-position branch and thus the boundary heal.
    const served = [hBase, hShift, hBeta, hShift];
    const servedCanons = [canon(decoy!), canon("alpha"), canon("beta"), canon("alpha")];

    // Disk now: alpha carries the base hash, its shifted hash is gone.
    const fileLines = ["alpha", "beta", "gamma"];
    const fileHashes = lineHashesPure(fileLines.join("\n"));
    expect(fileHashes.includes(hShift)).toBe(false);
    expect(fileHashes.indexOf(hBase)).toBe(0);
    expect(fileHashes.indexOf(hBeta)).toBe(1);

    // A-call over A's own data (pre-fix: re-asserts the poisoned entries).
    verifyServedRange({
      served: [...aHashes],
      servedCanons: aLines.map((l) => canon(l)),
      startHash: aHashes[0]!,
      endHash: aHashes[1]!,
      startLine: 1,
      endLine: 2,
      fileHashes: [...aHashes],
      fileLines: [...aLines],
    });

    // B-call over the stale duplicate. Pre-fix the poisoned startCanon
    // (canon(foreign), claimed by A's hashing) finds no disk match ->
    // E_UNSERVED_RANGE; post-fix B's own served canon heals to disk lines
    // 1..2 -> clean return.
    expect(() =>
      verifyServedRange({
        served: [...served],
        servedCanons: [...servedCanons],
        startHash: hShift,
        endHash: hBeta,
        startLine: 2,
        endLine: 3,
        fileHashes: [...fileHashes],
        fileLines: [...fileLines],
      }),
    ).not.toThrow();
  });

  it("the same-position canon tier still fires on B's own disagreement", () => {
    const bLines = ["alpha", "beta"];
    const hashesB = lineHashesPure(bLines.join("\n"));
    const servedCanons = bLines.map((l) => canon(l));
    expect(() =>
      verifyServedRange({
        served: [...hashesB],
        servedCanons: [...servedCanons],
        startHash: hashesB[0]!,
        endHash: hashesB[1]!,
        startLine: 1,
        endLine: 2,
        fileHashes: [...hashesB],
        fileLines: [...bLines],
      }),
    ).not.toThrow();
    let code: string | undefined;
    try {
      verifyServedRange({
        served: [...hashesB],
        servedCanons: [...servedCanons],
        startHash: hashesB[0]!,
        endHash: hashesB[1]!,
        startLine: 1,
        endLine: 2,
        fileHashes: [...hashesB],
        fileLines: ["alpha edited", "beta"],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ServedRejectionError);
      code = codeOf(error);
    }
    expect(code).toBe("E_STALE_RANGE");
  });
});
