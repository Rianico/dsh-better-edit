import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initHasher } from "../src/hashline/hash-assign.js";
import { shutdownHashStore } from "../src/hash-store.js";
import { extractHash, getText, setupIntegrationTest } from "../test/support/fixtures.js";

async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

const INITIAL = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\n";

/** The exterior shift: a line prepended out of band moves every anchor down one. */
const SHIFTED = `prepended\n${INITIAL}`;

async function withShiftedFile(
  run: (args: { dir: string; name: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), "epoch-shift-"));
  const name = "shift.txt";
  try {
    await writeFile(join(dir, name), INITIAL, "utf-8");
    await run({ dir, name });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("51 exterior shift — identity replaces the position check", () => {
  let tmpHome: string;
  beforeAll(async () => {
    await initHasher();
    tmpHome = await mkdtemp(join(await getWritableTempRoot(), "testhome-51-epoch-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
  });
  afterAll(async () => {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("applies at the rebased coordinate after an exterior insert (benign shift, no re-read)", async () => {
    await withShiftedFile(async ({ dir, name }) => {
      const { readTool, editTool } = setupIntegrationTest(dir);
      const read = await readTool.execute("read", { path: name });
      const anchor = extractHash(
        getText(read)
          .split("\n")
          .find((line) => line.endsWith("│line 5"))!,
      );

      await writeFile(join(dir, name), SHIFTED, "utf-8");

      // The served anchor's leased line identity resolves to the rebased coordinate, so the edit
      // applies there instead of rejecting: the line's bytes are unchanged and only its position
      // moved, which is exactly what a benign shift is. A look-alike rebind still rejects — see
      // test/core/deleted-twin-anchor.test.ts.
      await editTool.execute("shift", {
        path: name,
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: "line 5 changed",
      });

      expect(await readFile(join(dir, name), "utf-8")).toBe(
        `prepended\n${INITIAL.replace("line 5\n", "line 5 changed\n")}`,
      );
    });
  });

  it("a full re-read re-syncs and the same edit applies", async () => {
    await withShiftedFile(async ({ dir, name }) => {
      await writeFile(join(dir, name), SHIFTED, "utf-8");
      const { readTool, editTool } = setupIntegrationTest(dir);
      const read = await readTool.execute("read", { path: name });
      const anchor = extractHash(
        getText(read)
          .split("\n")
          .find((line) => line.endsWith("│line 5"))!,
      );

      await editTool.execute("re-read", {
        path: name,
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: "line 5 changed",
      });
      expect(await readFile(join(dir, name), "utf-8")).toContain("line 5 changed");
    });
  });
});
