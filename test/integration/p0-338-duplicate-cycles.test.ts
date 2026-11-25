import { readFile, writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { loadRetiredAnchors } from "../../src/session-view.js";
import { sessionKeyFor, withWorkspace } from "../../src/workspace-context.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

const RUN_FOUR = "head\n  }\n  }\n  }\n  }\ntail\n";
const RUN_TWO = "head\n  }\n  }\ntail\n";

type Harness = ReturnType<typeof setupIntegrationTest>;

function rowsOf(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("│"));
}

function hashOf(text: string, content: string, occurrence = 0): string {
  const matches = rowsOf(text).filter((line) => line.slice(line.indexOf("│") + 1) === content);
  const row = matches[occurrence];
  if (row === undefined) throw new Error(`no row for ${JSON.stringify(content)} #${occurrence}`);
  return extractHash(row);
}

function anchorsOf(text: string): string[] {
  return rowsOf(text).map((line) => extractHash(line));
}

async function read(harness: Harness, path: string, extra: Record<string, unknown> = {}) {
  return getText(await harness.readTool.execute("read", { path, ...extra }));
}

async function edit(harness: Harness, path: string, anchor: string, text: string) {
  const result = (await harness.editTool.execute("edit", {
    path,
    anchor_from: anchor,
    anchor_to: anchor,
    replace_with: text,
  })) as { content: Array<{ text?: string }>; details?: Record<string, unknown> };
  return { text: getText(result), details: result.details };
}

async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return String((error as Error).message);
  }
  return "";
}

describe("#338 — homogeneous runs survive exterior drift without a re-read", () => {
  it("applies a shrink edit on the surviving ordinal anchor", async () => {
    await withTempFile("run-shrink.txt", RUN_FOUR, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const first = await read(harness, "run-shrink.txt");
      const secondBrace = hashOf(first, "  }", 1);

      await writeFile(path, RUN_TWO, "utf-8");

      const applied = await edit(harness, "run-shrink.txt", secondBrace, "  } // second");

      expect(await readFile(path, "utf-8")).toBe("head\n  }\n  } // second\ntail\n");
      expect(applied.text).toContain("Successfully edited");
    });
  });

  it("rejects the retired overflow copy and writes nothing", async () => {
    await withTempFile("run-shrink-overflow.txt", RUN_FOUR, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const fourthBrace = hashOf(await read(harness, "run-shrink-overflow.txt"), "  }", 3);

      await writeFile(path, RUN_TWO, "utf-8");

      const message = await rejection(() =>
        edit(harness, "run-shrink-overflow.txt", fourthBrace, "  } // edited"),
      );

      expect(message).toMatch(/E_STALE_ANCHOR|E_TARGET_LOST/);
      expect(await readFile(path, "utf-8")).toBe(RUN_TWO);
    });
  });

  it("applies a growth edit on a surviving ordinal anchor", async () => {
    await withTempFile("run-grow.txt", RUN_TWO, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const secondBrace = hashOf(await read(harness, "run-grow.txt"), "  }", 1);

      await writeFile(path, RUN_FOUR, "utf-8");

      const applied = await edit(harness, "run-grow.txt", secondBrace, "  } // second");

      expect(await readFile(path, "utf-8")).toBe("head\n  }\n  } // second\n  }\n  }\ntail\n");
      expect(applied.text).toContain("Successfully edited");
    });
  });
});

describe("#338 — a deleted twin's anchor is retired, not re-issued", () => {
  it("persists the deleted twin through the drifted full read and never serves it again", async () => {
    await withTempFile("twins.txt", "x\na\ny\na\nz\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const key = sessionKeyFor(harness.sessionKey);
      const first = await read(harness, "twins.txt");
      const deleted = hashOf(first, "a", 0);
      const survivor = hashOf(first, "a", 1);
      expect(deleted).not.toBe(survivor);

      await writeFile(path, "x\ny\na\nz\n", "utf-8");

      const drifted = await read(harness, "twins.txt");
      expect(anchorsOf(drifted)).toContain(survivor);
      expect(anchorsOf(drifted)).not.toContain(deleted);
      // The store is workspace-scoped, so the read must be inspected in the same workspace the tool
      // call used (the bare call would open the shared-home store instead).
      expect([...(await withWorkspace(cwd, () => loadRetiredAnchors(key, path)))]).toContain(
        deleted,
      );

      const zAnchor = hashOf(drifted, "z", 0);
      await edit(harness, "twins.txt", zAnchor, "a\nz");

      const regrown = await read(harness, "twins.txt");
      const aRows = rowsOf(regrown).filter((line) => line.endsWith("│a"));
      expect(aRows).toHaveLength(2);
      for (const row of aRows) expect(extractHash(row)).not.toBe(deleted);
    });
  });

  it("persists the retired anchors on a paged read too", async () => {
    await withTempFile("twins-paged.txt", "x\na\ny\na\nz\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const key = sessionKeyFor(harness.sessionKey);
      const deleted = hashOf(await read(harness, "twins-paged.txt"), "a", 0);

      await writeFile(path, "x\ny\na\nz\n", "utf-8");

      await read(harness, "twins-paged.txt", { offset: 1, limit: 2 });

      expect([...(await withWorkspace(cwd, () => loadRetiredAnchors(key, path)))]).toContain(
        deleted,
      );
    });
  });
});

// The notice is payload-only (`finalizeResult` never renders it) and this tool surface exposes no
// `details` channel, so the omission rule is pinned in test/core/drift-notice-omission.test.ts.
describe("#338 — drift notice shape", () => {
  it("applies a clean edit on a served anchor", async () => {
    await withTempFile("clean.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const beta = hashOf(await read(harness, "clean.txt"), "beta");

      const applied = await edit(harness, "clean.txt", beta, "BETA");

      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
      expect(applied.text).toContain("Successfully edited");
    });
  });

  it("applies on the surviving anchor when an exterior line changed outside the range", async () => {
    await withTempFile("outside.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const beta = hashOf(await read(harness, "outside.txt"), "beta");

      await writeFile(path, "alpha\nbeta\ngamma\nDELTA\n", "utf-8");

      const applied = await edit(harness, "outside.txt", beta, "BETA");

      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\nDELTA\n");
      expect(applied.text).toContain("Successfully edited");
    });
  });
});
