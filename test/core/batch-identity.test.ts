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

      // Item 1 replaces line 1 with two lines, so item 2's anchor (line 5) now resolves one line
      // lower. The control: CP2-r1's pairing already resolves that, so the batch applies.
      const outcome = await runBatch(editTool, "a1.txt", [
        [a.get("L1")!, a.get("L1")!, "L1a\nL1b"],
        [a.get("L5")!, a.get("L5")!, "L5-changed"],
      ]);

      // Falsifier: any change that stops later items seeing earlier ones — the batch aborts as
      // `E_BATCH_ABORT` (inner cause `E_STALE_RANGE`), failing this assertion on `code` and the bytes below.
      expect(outcome).toEqual({ applied: true });
      expect(await readFile(path, "utf-8")).toBe("L1a\nL1b\nL2\nL3\nL4\nL5-changed\nL6\n");
    });
  });

  it("A2 residual: a duplicate canon introduced by item 1 no longer blocks item 2", async () => {
    await withTempFile("a2.txt", "A\nX\nB\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const a = anchorsByLine(await readTool.execute("read", { path: "a2.txt" }));

      // Item 1 replaces line 3 with `A\nX`, so the intermediate buffer is `A\nX\nA\nX` — the whole
      // interval is ambiguous for the pairing engine (no pins, several optimal embeddings), which
      // used to leave lines 1 and 2 unpaired — item 2's span rejected as E_STALE_RANGE, so the
      // batch aborted as E_BATCH_ABORT. The map knows line 1's identity directly, so item 2 applies.
      const outcome = await runBatch(editTool, "a2.txt", [
        [a.get("B")!, a.get("B")!, "A\nX"],
        [a.get("A")!, a.get("A")!, "A-changed"],
      ]);

      // Falsifier: pass no `currentIds` (the mutation below) and this goes RED — the batch aborts as
      // `E_BATCH_ABORT` (inner cause item 2's `E_STALE_RANGE`) and the file stays `A\nX\nB\n`.
      expect(outcome).toEqual({ applied: true });
      expect(await readFile(path, "utf-8")).toBe("A-changed\nX\nA\nX\n");
    });
  });

  it("the splice survives a shrink and a grow in one batch", async () => {
    await withTempFile("mix.txt", "M1\nM2\nM3\nM4\nM5\nM6\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const a = anchorsByLine(await readTool.execute("read", { path: "mix.txt" }));

      // Item 1 grows line 1 to two lines; item 2 shrinks lines 3-4 to one; item 3 targets a line
      // below both, whose identity only resolves if the map's arithmetic tracked both directions.
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

      // Item 1 creates the line `N1-extra`; item 2's anchor is that new line, which carries no
      // identity — the map assigns `null` and the lease lookup finds nothing. Fail-closed, and the
      // same outcome as before the map: a line the batch created has to be read before it can be
      // anchored.
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
