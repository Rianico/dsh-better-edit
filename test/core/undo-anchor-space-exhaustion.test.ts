import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AnchorSpaceExhaustedError } from "../../src/hashline/hash-assign.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * R1 finding 4: the undo path rehashes the current and restored files, and anchor-space
 * exhaustion there must map like the edit path (`isAnchorSpaceExhausted` →
 * `retryLineHashesWithPromotion` → typed `E_LARGE_FILE` hash-space) — promote (clear retired) and
 * retry once, then refuse with the typed capacity error rather than a raw probe error.
 *
 * The mock targets only `lineHashes`; the edit that seeds the undo history runs with `mode: "ok"`.
 */
const control = vi.hoisted(() => ({
  calls: 0,
  mode: "ok" as "ok" | "nth" | "always",
  nth: 0,
}));

vi.mock("../../src/hashline/hash.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hashline/hash.js")>();
  return {
    ...actual,
    lineHashes: async (...args: Parameters<typeof actual.lineHashes>) => {
      const call = control.calls++;
      if (control.mode === "always" || (control.mode === "nth" && call === control.nth)) {
        throw new AnchorSpaceExhaustedError(1, 0);
      }
      return actual.lineHashes(...args);
    },
  };
});

const ORIGINAL = "alpha\nbravo\ncharlie\n";
const EDITED = "alpha\nbravo edited\ncharlie\n";

beforeAll(async () => {
  await initHasher();
});

function rowsOf(result: { content: Array<{ text?: string }> }): string[] {
  return getText(result)
    .split("\n")
    .filter((line) => line.includes("│"));
}

async function editOnce(
  harness: ReturnType<typeof setupIntegrationTest>,
  file: string,
): Promise<void> {
  const read = await harness.readTool.execute("r1", { path: file });
  const bravo = extractHash(rowsOf(read)[1]!);
  await harness.editTool.execute("e1", {
    path: file,
    anchor_from: bravo,
    anchor_to: bravo,
    replace_with: "bravo edited",
  });
}

describe("undo anchor-space exhaustion mapping (R1 finding 4)", () => {
  it("promotes and completes the revert when the current-file rehash exhausts once", async () => {
    await withTempFile("undo_promote_current.txt", ORIGINAL, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      await editOnce(harness, "undo_promote_current.txt");

      control.calls = 0;
      control.mode = "nth";
      control.nth = 0;
      try {
        const undone = await harness.undoTool.execute("u1", { path: "undo_promote_current.txt" });
        expect(getText(undone)).toContain("File reverted to previous state");
        // Exactly one promotion retry: the exhausted current-file rehash, its retry, then the
        // restore rehash. Without the guard this would be 1 call and a thrown raw probe error.
        expect(control.calls).toBe(3);
      } finally {
        control.mode = "ok";
      }
      expect(await readFile(path, "utf8")).toBe(ORIGINAL);
    });
  });

  it("promotes and completes the revert when the restore rehash exhausts once", async () => {
    await withTempFile("undo_promote_restore.txt", ORIGINAL, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      await editOnce(harness, "undo_promote_restore.txt");

      control.calls = 0;
      control.mode = "nth";
      control.nth = 1;
      try {
        const undone = await harness.undoTool.execute("u1", { path: "undo_promote_restore.txt" });
        expect(getText(undone)).toContain("File reverted to previous state");
        // Exactly one promotion retry: the current-file rehash, the exhausted restore rehash, then
        // its retry.
        expect(control.calls).toBe(3);
      } finally {
        control.mode = "ok";
      }
      expect(await readFile(path, "utf8")).toBe(ORIGINAL);
    });
  });

  it("maps persistent exhaustion to E_LARGE_FILE (hash-space) and leaves the file untouched", async () => {
    await withTempFile("undo_exhaust_hard.txt", ORIGINAL, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      await editOnce(harness, "undo_exhaust_hard.txt");

      control.calls = 0;
      control.mode = "always";
      try {
        await expect(
          harness.undoTool.execute("u1", { path: "undo_exhaust_hard.txt" }),
        ).rejects.toThrow(/E_LARGE_FILE/);
        // The first attempt and the post-promotion retry both exhausted, then the typed refusal.
        expect(control.calls).toBe(2);
      } finally {
        control.mode = "ok";
      }
      // The revert never ran: the file still holds the edited content.
      expect(await readFile(path, "utf8")).toBe(EDITED);
    });
  });
});
