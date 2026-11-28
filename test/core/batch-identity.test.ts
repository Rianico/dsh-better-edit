import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { shutdownHashStore } from "../../src/hash-store.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

/** Rendered served row -> its anchor, keyed by the row's line text. */
function anchorsByLine(result: { content: Array<{ text?: string }> }): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of getText(result).split("\n")) {
    const sep = row.indexOf("│");
    if (sep > 0) map.set(row.slice(sep + 1), extractHash(row));
  }
  return map;
}

/** Run a batch and report either the file bytes or the rejection code. */
async function runBatch(
  editTool: { execute: (id: string, params: unknown) => Promise<unknown> },
  file: string,
  edits: [string, string, string][],
): Promise<{ code: string } | { applied: true }> {
  try {
    await editTool.execute("batch", { file, edits });
    return { applied: true };
  } catch (error) {
    const message = String((error as Error).message);
    const match = /\[(E_[A-Z_]+)\]/.exec(message);
    return { code: match?.[1] ?? message };
  }
}

describe("batch working-buffer identity map", () => {
  let tmpHome: string;
  beforeAll(async () => {
    tmpHome = await mkdtemp(join(await getWritableTempRoot(), "testhome-batch-id-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
  });
  afterAll(async () => {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("A1 control: item 2 applies at its rebased coordinate after item 1 grows the file", async () => {
    await withTempFile("a1.txt", "L1\nL2\nL3\nL4\nL5\nL6\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const a = anchorsByLine(await readTool.execute("read", { path: "a1.txt" }));

      const outcome = await runBatch(editTool, "a1.txt", [
        [a.get("L1")!, a.get("L1")!, "L1a\nL1b"],
        [a.get("L5")!, a.get("L5")!, "L5-changed"],
      ]);

      expect(outcome).toEqual({ applied: true });
      expect(await readFile(path, "utf-8")).toBe("L1a\nL1b\nL2\nL3\nL4\nL5-changed\nL6\n");
    });
  });

  it("A2 residual: a duplicate canon introduced by item 1 no longer blocks item 2", async () => {
    await withTempFile("a2.txt", "A\nX\nB\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const a = anchorsByLine(await readTool.execute("read", { path: "a2.txt" }));

      const outcome = await runBatch(editTool, "a2.txt", [
        [a.get("B")!, a.get("B")!, "A\nX"],
        [a.get("A")!, a.get("A")!, "A-changed"],
      ]);

      expect(outcome).toEqual({ applied: true });
      expect(await readFile(path, "utf-8")).toBe("A-changed\nX\nA\nX\n");
    });
  });

  it("the splice survives a shrink and a grow in one batch", async () => {
    await withTempFile("mix.txt", "M1\nM2\nM3\nM4\nM5\nM6\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const a = anchorsByLine(await readTool.execute("read", { path: "mix.txt" }));

      const outcome = await runBatch(editTool, "mix.txt", [
        [a.get("M1")!, a.get("M1")!, "M1a\nM1b"],
        [a.get("M3")!, a.get("M4")!, "M34"],
        [a.get("M6")!, a.get("M6")!, "M6-changed"],
      ]);

      expect(outcome).toEqual({ applied: true });
      expect(await readFile(path, "utf-8")).toBe("M1a\nM1b\nM2\nM34\nM5\nM6-changed\n");
    });
  });

  it("an item targeting a line an earlier item created still rejects", async () => {
    await withTempFile("newline.txt", "N1\nN2\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const a = anchorsByLine(await readTool.execute("read", { path: "newline.txt" }));

      const first = a.get("N1")!;
      const outcome = await runBatch(editTool, "newline.txt", [
        [first, first, "N1\nN1-extra"],
        [first, first, "N1-again"],
      ]);

      expect(outcome).toEqual({ code: "E_BATCH_ABORT" });
      expect(await readFile(path, "utf-8")).toBe("N1\nN2\n");
    });
  });
});
