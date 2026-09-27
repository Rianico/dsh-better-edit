import { beforeAll, describe, expect, it, vi } from "vitest";
import { AnchorSpaceExhaustedError, lineHashesPure } from "../../src/hashline/hash-assign.js";
import type { ServedPersistence } from "../../src/hash-store.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { applyOne } from "../../src/mutation/engine.js";

/**
 * Storage-error transparency for the promotion path: a failed store clear must surface as a
 * plain-text warning in `input.warnings` (no `[E_]`/`[W_]` header) while the edit still applies.
 */
const control = vi.hoisted(() => ({
  throwAnchorSpaceOnce: true,
  storeMode: "ok" as "ok" | "loadThrows" | "clearCardsThrows",
}));

vi.mock("../../src/hashline/hash.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hashline/hash.js")>();
  return {
    ...actual,
    lineHashes: async (...args: Parameters<typeof actual.lineHashes>) => {
      if (control.throwAnchorSpaceOnce) {
        control.throwAnchorSpaceOnce = false;
        throw new AnchorSpaceExhaustedError(3, 2);
      }
      return actual.lineHashes(...args);
    },
  };
});

vi.mock("../../src/hash-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hash-store.js")>();
  return {
    ...actual,
    loadServedStore: async () => {
      if (control.storeMode === "loadThrows") throw new Error("served store unavailable (test)");
      return {
        clearRetiredAnchors: () => undefined,
        clearCards: () => {
          if (control.storeMode === "clearCardsThrows") throw new Error("card clear failed (test)");
        },
      } as unknown as ServedPersistence;
    },
  };
});

async function runPromotionWith(
  content: string,
  storeMode: "ok" | "loadThrows" | "clearCardsThrows",
): Promise<{ result: string; warnings: string[] }> {
  control.throwAnchorSpaceOnce = true;
  control.storeMode = storeMode;
  const hashes = lineHashesPure(content);
  const warnings: string[] = [];
  const applied = await applyOne(
    {
      content,
      hashes,
      served: [...hashes],
      anchorFrom: hashes[0]!,
      anchorTo: hashes[0]!,
      replaceWith: "A",
      absolutePath: "/tmp/promotion.txt",
      displayPath: "promotion.txt",
      sessionKey: "sess",
      warnings,
      persist: false,
    },
    async () => {
      throw new Error("should not reject");
    },
  );
  return { result: applied.result, warnings };
}

describe("promotion store-clear transparency", () => {
  beforeAll(async () => {
    await initHasher();
  });

  it("reports a failed card clear as plain text and still applies the edit", async () => {
    const { result, warnings } = await runPromotionWith("a\nb", "clearCardsThrows");
    expect(result).toBe("A\nb");
    const clearWarnings = warnings.filter((warning) =>
      warning.includes("promotion could not clear"),
    );
    expect(clearWarnings).toHaveLength(1);
    expect(clearWarnings[0]).toContain("/tmp/promotion.txt");
    expect(clearWarnings[0]).toContain("card clear failed (test)");
    expect(clearWarnings[0]).toContain(
      "the next read may still compare against the pre-promotion range.",
    );
    expect(clearWarnings[0]).not.toMatch(/\[(E|W)_/);
  });

  it("reports a failed served-store load as plain text and still applies the edit", async () => {
    const { result, warnings } = await runPromotionWith("a\nb", "loadThrows");
    expect(result).toBe("A\nb");
    const clearWarnings = warnings.filter((warning) =>
      warning.includes("promotion could not clear"),
    );
    expect(clearWarnings).toHaveLength(1);
    expect(clearWarnings[0]).toContain("/tmp/promotion.txt");
    expect(clearWarnings[0]).toContain("served store unavailable (test)");
    expect(clearWarnings[0]).toContain(
      "stale-anchor checks stay degraded until the next full read.",
    );
    expect(clearWarnings[0]).not.toMatch(/\[(E|W)_/);
  });

  it("stays silent when the store clear succeeds", async () => {
    const { result, warnings } = await runPromotionWith("a\nb", "ok");
    expect(result).toBe("A\nb");
    expect(warnings.filter((warning) => warning.includes("promotion could not clear"))).toEqual([]);
    expect(warnings.some((warning) => warning.includes("Anchor space exhausted"))).toBe(true);
  });
});
