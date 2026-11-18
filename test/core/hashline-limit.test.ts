import { describe, expect, it, vi } from "vitest";
import {
  lineHashesPure,
  lineHashes,
  HASH_SPACE,
  MAX_HASH_LINES,
} from "../../src/hashline/index.js";
import {
  AnchorSpaceExhaustedError,
  isAnchorSpaceExhaustion,
  isPromotableAnchorSpaceExhaustion,
} from "../../src/hashline/hash-assign.js";
import { eLargeFileMsg } from "../../src/constants.js";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { sessionKeyFor } from "../../src/workspace-context.js";
import { useTestHome, withTempFile, setupReadTest } from "../support/fixtures.js";

const home = useTestHome();

describe("hashline limits", () => {
  it("derives the hash space from the alphabet and hash length", () => {
    expect(HASH_SPACE).toBe(62 ** 3);
    expect(MAX_HASH_LINES).toBe(HASH_SPACE);
  });

  it("hashes exactly MAX_HASH_LINES lines with unique anchors", () => {
    const content = Array.from({ length: MAX_HASH_LINES }, (_, i) => `line ${i}`).join("\n");
    const hashes = lineHashesPure(content);
    expect(hashes).toHaveLength(MAX_HASH_LINES);
    expect(new Set(hashes).size).toBe(MAX_HASH_LINES);
  }, 300_000);

  it("throws a clear E_LARGE_FILE error above the limit", () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
    expect(() => lineHashesPure(content)).toThrow(
      "[TO MODEL] [E_LARGE_FILE] Cannot allocate a unique hash anchor",
    );
  }, 300_000);

  it("preserves unique hashes at the boundary through the store path", async () => {
    const content = Array.from({ length: MAX_HASH_LINES }, (_, i) => `x${i}`).join("\n");
    const hashes = await lineHashes(content, home.testPath);
    expect(hashes).toHaveLength(MAX_HASH_LINES);
    expect(new Set(hashes).size).toBe(MAX_HASH_LINES);
  }, 300_000);
});

describe("anchor-space-exhaustion predicates (exhaustion vs. promotion)", () => {
  // WHY this pin exists: `isAnchorSpaceExhaustion` answers "is this exhaustion" (the two
  // translate blocks in hash-assign), while `isPromotableAnchorSpaceExhaustion` answers "can
  // clearing retired anchors and retrying help" (read, edit, undo). A rewording of an allocator or
  // line-cap message must redden HERE instead of silently changing a promotion decision at
  // whichever site kept a private copy of the test.
  const TYPED = new AnchorSpaceExhaustedError(2, 3);
  const PROBE = new Error(
    `Anchor space exhausted — probing failed over ${HASH_SPACE} slots (reserved full).`,
  );
  // The hash-space headline: `AnchorSpaceExhaustedError`'s own text, which survives a re-wrap that
  // costs the error its class. (Arch-T8 called this "the line-cap wording"; the live line cap is
  // the fixture below.) Exhaustion — yes. Promotable — no: the file is too long to hash at all.
  const HASH_SPACE_HEADLINE = new Error(
    `[TO MODEL] [E_LARGE_FILE] Cannot allocate a unique hash anchor: the file exceeds the ${HASH_SPACE}-line limit`,
  );
  // The live maxLines refusal read-and-serve actually receives, composed by the producer itself so
  // this fixture cannot drift from the thrown text.
  const LINE_CAP = new Error(eLargeFileMsg("huge.ts", MAX_HASH_LINES + 1, MAX_HASH_LINES));

  it.each([
    ["the typed error", TYPED, true, true],
    ["the probe-exhaustion wording", PROBE, true, true],
    ["the hash-space headline", HASH_SPACE_HEADLINE, true, false],
    ["the line-cap refusal", LINE_CAP, false, false],
  ])("classifies %s", (_label, e, exhaustion: boolean, promotable: boolean) => {
    expect(isAnchorSpaceExhaustion(e)).toBe(exhaustion);
    expect(isPromotableAnchorSpaceExhaustion(e)).toBe(promotable);
  });

  it("declines an unrelated failure and a non-Error on both questions", () => {
    for (const predicate of [isAnchorSpaceExhaustion, isPromotableAnchorSpaceExhaustion]) {
      expect(predicate(new Error("ENOENT: no such file or directory"))).toBe(false);
      expect(predicate("probing failed over")).toBe(false);
      expect(predicate(undefined)).toBe(false);
    }
  });
});

describe("read tool line cap", () => {
  it("rejects oversized files with E_LARGE_FILE before hashing", async () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
    await withTempFile("huge.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      await expect(
        readTool.execute("r1", { path: "huge.ts" }, undefined, undefined, ctx),
      ).rejects.toThrow("E_LARGE_FILE");
    });
  });

  it("reads a file at the limit without hashing errors", async () => {
    const content = Array.from({ length: MAX_HASH_LINES }, (_, i) => `x${i}`).join("\n");
    await withTempFile("big.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("r1", { path: "big.ts" }, undefined, undefined, ctx);
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("│x0");
      expect(text).toContain("[Showing lines 1-");
    });
  }, 300_000);

  // WHY: the promotion branch of `readAndServe` is a retired-anchor GC, not a line-count escape
  // hatch. An uncurable refusal must therefore reach the model with hazard state intact — the
  // read failed, so degrading its own stale-anchor checks would be a silent cost, and the retry
  // would throw the identical error.
  it("clears no hazard state on the uncurable line-cap refusal", async () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
    await withTempFile("huge.txt", content, async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("arch-t8-line-cap-no-clear");
      const store = (await loadHashStore()) as InternalHashStore;
      store.clearRetiredAnchors(sessionKey, path);
      store.upsertRetiredAnchors(
        sessionKey,
        path,
        JSON.stringify([{ hash: "ZZZ", deathPos: null }]),
      );
      store.clearCards(sessionKey, path);
      store.upsertCards(sessionKey, path, JSON.stringify([7]));
      // `loadServedStore` is `loadHashStore` for this store path (hash-store.ts:314), so these
      // spies sit on the very object the call under test reaches.
      const clearRetired = vi.spyOn(store, "clearRetiredAnchors");
      const clearCards = vi.spyOn(store, "clearCards");

      const refused = await readAndServe(localIO(), "huge.txt", cwd, { sessionKey }).then(
        () => {
          throw new Error("the oversized read must refuse");
        },
        (e: unknown) => e,
      );
      expect(String(refused)).toContain("E_LARGE_FILE");
      // The refusal the reader actually receives answers "no" to promotion's question — that is
      // what keeps the store untouched below, and it is refutable independently of the spy.
      expect(isPromotableAnchorSpaceExhaustion(refused)).toBe(false);

      expect(clearRetired).not.toHaveBeenCalled();
      expect(clearCards).not.toHaveBeenCalled();
      expect(store.getRetiredEntries(sessionKey, path).map((entry) => entry.hash)).toEqual(["ZZZ"]);
      expect([...store.getCards(sessionKey, path)]).toEqual([7]);
      clearRetired.mockRestore();
      clearCards.mockRestore();
    });
  }, 300_000);
});
