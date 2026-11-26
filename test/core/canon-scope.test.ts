import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { codeOf } from "../../src/utils.js";
import {
  HASH_SPACE,
  canon,
  lineHashesPure,
  verifyServedRange,
  ServedRejectionError,
} from "../../src/hashline/index.js";
import { xxh32 } from "../../src/hashline/hash-assign.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { shutdownHashStore } from "../../src/hash-store.js";
import { loadServedCanons, recordServed } from "../../src/session-view.js";
import { getWritableTempRoot } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

function baseIndexOf(line: string): number {
  return (xxh32(line) >>> 14) % HASH_SPACE;
}

function searchBase(target: number, prefix: string): string | undefined {
  for (let i = 0; i < 2_000_000; i++) {
    const cand = `${prefix}-${i}`;
    if (baseIndexOf(cand) === target) return cand;
  }
  return undefined;
}

describe("canon scope is file-local, never process-global (#149 class)", () => {
  it("rejects E_UNSERVED_RANGE on an ambiguous boundary that file A's canon cannot decide", () => {
    const diskCanons = ["alpha", "beta", "gamma"];
    const T = baseIndexOf("alpha");
    const decoy = searchBase(T, "decoy");
    expect(decoy).toBeDefined();
    expect(canon(decoy!)).not.toBe(canon("alpha"));
    expect(diskCanons).not.toContain(canon(decoy!));
    const foreign = searchBase(T, "foreign");
    expect(foreign).toBeDefined();
    expect(foreign).not.toBe(decoy);
    expect(canon(foreign!)).not.toBe(canon("alpha"));
    expect(diskCanons).not.toContain(canon(foreign!));

    const aLines = [decoy!, foreign!];
    const aHashes = lineHashesPure(aLines.join("\n"));

    const servedBase = lineHashesPure([decoy!, "alpha", "beta"].join("\n"));
    const hBase = servedBase[0]!;
    const hShift = servedBase[1]!;
    const hBeta = servedBase[2]!;
    expect(hShift).not.toBe(hBase);
    expect(aHashes[0]).toBe(hBase);
    expect(aHashes[1]).toBe(hShift);

    const served = [hBase, hShift, hBeta, hShift];
    const servedCanons = [canon(decoy!), canon("alpha"), canon("beta"), canon("alpha")];

    const fileLines = ["alpha", "beta", "gamma"];
    const fileHashes = lineHashesPure(fileLines.join("\n"));
    expect(fileHashes.includes(hShift)).toBe(false);
    expect(fileHashes.indexOf(hBase)).toBe(0);
    expect(fileHashes.indexOf(hBeta)).toBe(1);

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

    let code: string | undefined;
    let message = "";
    try {
      verifyServedRange({
        served: [...served],
        servedCanons: [...servedCanons],
        startHash: hShift,
        endHash: hBeta,
        startLine: 2,
        endLine: 3,
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

  it("a serve of file B records B's own canons after file A was hashed (#149)", async () => {
    const T = baseIndexOf("alpha");
    const decoy = searchBase(T, "decoy");
    const foreign = searchBase(T, "foreign");
    expect(decoy).toBeDefined();
    expect(foreign).toBeDefined();

    const aHashes = lineHashesPure([decoy!, foreign!].join("\n"));
    const hShift = aHashes[1]!;
    expect(canon(foreign!)).not.toBe(canon("alpha"));

    await withTempHome(async () => {
      const fileLines = ["alpha", "beta", "gamma"];
      const fileHashes = lineHashesPure(fileLines.join("\n"));
      expect(fileHashes.includes(hShift)).toBe(false);

      //
      await recordServed(
        "t3a-canon-scope",
        "/b.ts",
        [
          { position: 0, hash: fileHashes[0]! },
          { position: 1, hash: hShift },
          { position: 2, hash: fileHashes[2]! },
        ],
        3,
        {
          hashes: fileHashes,
          canons: fileLines.map((line) => canon(line)),
          fullRead: false,
        },
      );

      const canons = await loadServedCanons("t3a-canon-scope", "/b.ts");
      expect(canons[0]).toBe(canon("alpha"));
      expect(canons[2]).toBe(canon("gamma"));
      expect(canons[1]).toBeNull();
    });
  });
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-canon-scope-test-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try {
    await run(tmpHome);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}
