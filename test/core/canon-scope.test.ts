import { describe, expect, it } from "vitest";
import { codeOf } from "../../src/utils.js";
import {
  HASH_SPACE,
  canon,
  lineHashesPure,
  verifyServedRange,
  ServedRejectionError,
} from "../../src/hashline/index.js";
import { ALPH, xxh32 } from "../../src/hashline/hash-assign.js";

function hashToIndex(hash: string): number {
  let idx = 0;
  for (const ch of hash) idx = idx * ALPH.length + ALPH.indexOf(ch);
  return idx;
}

function baseIndexOf(line: string): number {
  return (xxh32(canon(line)) >>> 14) % HASH_SPACE;
}

describe("canon scope is file-local, never process-global (#149 class)", () => {
  it("a canon recorded while serving file A cannot decide file B's verdict", () => {
    const bLines = ["alpha", "beta"];
    const hashesB = lineHashesPure(bLines.join("\n"));
    const target = hashesB[0]!;
    // Build the cross-file anchor collision at test time: a foreign line whose
    // base slot equals target's index, so a single-line file A assigns it the
    // very same anchor file B uses for "alpha".
    let foreign: string | undefined;
    for (let i = 0; i < 2_000_000; i++) {
      const cand = `foreign-line-${i}`;
      if (baseIndexOf(cand) === hashToIndex(target)) {
        foreign = cand;
        break;
      }
    }
    expect(foreign).toBeDefined();
    expect(canon(foreign!)).not.toBe(canon("alpha"));
    const hashesA = lineHashesPure(foreign!);
    expect(hashesA).toHaveLength(1);
    expect(hashesA[0]).toBe(target);

    // A-population path: pre-fix this seeded the process-global map with
    // target -> foreign canon. Post-fix it must be a no-op for file B.
    verifyServedRange({
      served: [...hashesA],
      startHash: hashesA[0]!,
      endHash: hashesA[0]!,
      startLine: 1,
      endLine: 1,
      fileHashes: [...hashesA],
      fileLines: [foreign!],
    });

    // B's own verdict, served canons intact and disk unchanged: no refusal.
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

    // B's disk line disagrees with B's served canon: the canon tier fires.
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
