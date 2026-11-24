/**
 * #144 T4 — strict span mode must not force a re-read of untouched lines between served anchors.
 *
 * Invariant: strict refuses only an unserved INTERIOR of the replaced span. Two independent
 * one-line edits within one batch — and two chained edits with no intervening read — apply, as
 * long as every line each item replaces was served once in this session.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { initHasher } from "../../src/hashline/index.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});
afterEach(() => {
  delete process.env.DSH_BETTER_EDIT_SPAN_MODE;
  _resetConfigCache();
});

const SPAN_ENV = "DSH_BETTER_EDIT_SPAN_MODE";

async function withSpanMode<T>(mode: "hint" | "strict", run: () => Promise<T>): Promise<T> {
  const previous = process.env[SPAN_ENV];
  process.env[SPAN_ENV] = mode;
  _resetConfigCache();
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[SPAN_ENV];
    else process.env[SPAN_ENV] = previous;
    _resetConfigCache();
  }
}

/** Parse `hash│line` rows out of a read rendering into line text → anchor. */
function anchorsByLine(text: string): Map<string, string> {
  const rows = text.split("\n").filter((line) => /^[A-Za-z0-9]{3}│/.test(line));
  return new Map(rows.map((row) => [row.split("│")[1]!, extractHash(row)]));
}

type Harness = ReturnType<typeof setupIntegrationTest>;
async function readWindows(
  harness: Harness,
  path: string,
  windows: Array<{ offset: number; limit: number }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const window of windows) {
    const res = await harness.readTool.execute("read", { path, windows: [window] });
    for (const [line, hash] of anchorsByLine(getText(res))) out.set(line, hash);
  }
  return out;
}

const HOLE = "begin\nhidden\nend\n";

describe("strict span mode — line independence (#144 T4)", () => {
  it("two independent one-line edits around an unread line apply in one batch", async () => {
    await withTempFile("hole.txt", HOLE, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await readWindows(harness, "hole.txt", [
        { offset: 1, limit: 1 },
        { offset: 3, limit: 1 },
      ]);

      // Neither item's replaced interior is unserved (each span is one line), so line 2's hole
      // between the two edits is never examined.
      await withSpanMode("strict", () =>
        harness.editTool.execute("edit", {
          path: "hole.txt",
          edits: [
            [anchors.get("begin")!, anchors.get("begin")!, "BEGIN"],
            [anchors.get("end")!, anchors.get("end")!, "END"],
          ],
        }),
      );

      expect(await readFile(path, "utf-8")).toBe("BEGIN\nhidden\nEND\n");
    });
  });

  it("chained edits reuse served anchors with no intervening read", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const content = `${lines.join("\n")}\n`;

    await withTempFile("fifty.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await readWindows(harness, "fifty.txt", [{ offset: 1, limit: 50 }]);

      await withSpanMode("strict", async () => {
        await harness.editTool.execute("edit", {
          path: "fifty.txt",
          edits: [[anchors.get("line 2")!, anchors.get("line 2")!, "LINE 2"]],
        });
        // Still inside the same strict window and with no re-read: the anchors for 20-25 were
        // served by the single window above, and the earlier edit did not touch those lines.
        await harness.editTool.execute("edit", {
          path: "fifty.txt",
          edits: [
            [
              anchors.get("line 20")!,
              anchors.get("line 25")!,
              lines
                .slice(19, 25)
                .map((line) => line.toUpperCase())
                .join("\n"),
            ],
          ],
        });
      });

      const after = (await readFile(path, "utf-8")).split("\n");
      expect(after[1]).toBe("LINE 2");
      expect(after.slice(19, 25)).toEqual([
        "LINE 20",
        "LINE 21",
        "LINE 22",
        "LINE 23",
        "LINE 24",
        "LINE 25",
      ]);
    });
  });
});
