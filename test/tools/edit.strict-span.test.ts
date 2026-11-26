/**
 * #144 T4 — tool-level acceptance for strict span mode.
 *
 * Invariant: strict mode refuses a span edit whose replaced interior was never served, and it
 * refuses BEFORE any write (bytes unchanged, no undo row); hint mode applies the same edit and
 * discloses the replaced unserved interior through the `[MODEL] [W_UNSERVED_INTERIOR]` warning.
 * A fully served span, or a fully served span that only shifted position under an exterior
 * insert, applies under strict; a served interior whose identity drifted rejects `E_STALE_RANGE`;
 * one refused item aborts the whole batch atomically.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";

import { ANCHOR_LEN, HASH_SEP, initHasher } from "../../src/hashline/index.js";
import { canonicalSync } from "../../src/canonical-path.js";
import { getUndo } from "../../src/undo-edit.js";
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
const BLANK = `-${" ".repeat(ANCHOR_LEN)}${HASH_SEP}`; // empty gutter of a removed unserved row

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

/** Await a call that must reject; return the thrown DomainError-ish shape. */
async function rejection(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  if (error === undefined) throw new Error("expected the edit to reject");
  const shaped = error as { code?: string; message?: string };
  return {
    ...(shaped.code === undefined ? {} : { code: shaped.code }),
    message: shaped.message ?? String(error),
  };
}

const HOLE = "begin\nhidden\nend\n";
const TEN_LINES = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];
const TEN = TEN_LINES.map((line) => `${line}\n`).join("");

/** Serve lines 1 and 3 only, so line 2 stays a hole in the served mirror. */
function holeWindows() {
  return [
    { offset: 1, limit: 1 },
    { offset: 3, limit: 1 },
  ];
}

describe("strict span mode — tool acceptance (#144 T4)", () => {
  it("hint applies the span and discloses the replaced unserved interior", async () => {
    await withTempFile("hole.txt", HOLE, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await readWindows(harness, "hole.txt", holeWindows());

      const out = await withSpanMode("hint", () =>
        harness.editTool.execute("edit", {
          path: "hole.txt",
          edits: [[anchors.get("begin")!, anchors.get("end")!, "replacement"]],
        }),
      );
      const text = getText(out);

      // The removed unserved row keeps an empty gutter; a served row would print its anchor.
      expect(text).toContain(`${BLANK}hidden`);
      expect(text).not.toMatch(/^-[A-Za-z0-9]{3}│hidden$/m);
      expect(text).toContain("[MODEL] [W_UNSERVED_INTERIOR]");
      expect(await readFile(path, "utf-8")).toBe("replacement\n");
    });
  });

  it("non-contiguous hint holes pin the warning range to the first and last unserved line", async () => {
    const TWELVE = Array.from({ length: 12 }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
    await withTempFile("span.txt", TWELVE, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      // Serve boundaries plus the middle run: old lines 3 and 10 stay unserved.
      const anchors = await readWindows(harness, "span.txt", [
        { offset: 1, limit: 2 },
        { offset: 4, limit: 6 },
        { offset: 11, limit: 2 },
      ]);

      const out = await withSpanMode("hint", () =>
        harness.editTool.execute("edit", {
          path: "span.txt",
          edits: [[anchors.get("row 1")!, anchors.get("row 12")!, "replacement"]],
        }),
      );

      expect(getText(out)).toContain(
        "Span replaced 12 file lines, 2 of which were never served; the edit applied.\n" +
          "Unserved file lines: 3, 10",
      );
      expect(await readFile(path, "utf-8")).toBe("replacement\n");
    });
  });
  it("strict refuses the span before any write and records no undo row", async () => {
    await withTempFile("hole.txt", HOLE, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await readWindows(harness, "hole.txt", holeWindows());
      const before = await readFile(path, "utf-8");

      const error = await withSpanMode("strict", () =>
        rejection(
          harness.editTool.execute("edit", {
            path: "hole.txt",
            edits: [[anchors.get("begin")!, anchors.get("end")!, "replacement"]],
          }),
        ),
      );

      expect(error.code).toBe("E_UNSERVED_RANGE");
      expect(error.message).toContain("[E_UNSERVED_RANGE]");
      expect(error.message).toContain("Strict span mode refused the edit to hole.txt:");
      expect(error.message).toContain("1 of the 3 file lines it replaces was never served.");
      expect(error.message).toContain("Unserved file line: 2");
      // The strict refusal is rowless, so it must not pretend to echo a current range.
      expect(error.message).not.toContain("Current range");
      expect(await readFile(path, "utf-8")).toBe(before);
      expect(await getUndo(canonicalSync(path))).toBeUndefined();
    });
  });

  it("a hole-filled span passes strict mode once line 2 is read", async () => {
    await withTempFile("hole.txt", HOLE, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      // The literal retry path: boundaries first, then the hole, then the same span.
      const holes = await readWindows(harness, "hole.txt", holeWindows());
      const filled = await readWindows(harness, "hole.txt", [{ offset: 2, limit: 1 }]);
      const anchors = new Map([...holes, ...filled]);

      await withSpanMode("strict", () =>
        harness.editTool.execute("edit", {
          path: "hole.txt",
          edits: [[anchors.get("begin")!, anchors.get("end")!, "replacement"]],
        }),
      );

      expect(await readFile(path, "utf-8")).toBe("replacement\n");
    });
  });

  it("a fully served range that only shifted under an exterior insert applies under strict", async () => {
    await withTempFile("shift.txt", TEN, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await readWindows(harness, "shift.txt", [{ offset: 5, limit: 3 }]);

      // A plain new-content insert above the span: the lease identity rebases it, so the
      // served anchors still name the same lines and no re-read is owed.
      await writeFile(path, `inserted\n${TEN}`, "utf-8");

      await withSpanMode("strict", () =>
        harness.editTool.execute("edit", {
          path: "shift.txt",
          edits: [[anchors.get("l5")!, anchors.get("l7")!, "L5\nL6\nL7"]],
        }),
      );

      expect(await readFile(path, "utf-8")).toBe(
        "inserted\nl1\nl2\nl3\nl4\nL5\nL6\nL7\nl8\nl9\nl10\n",
      );
    });
  });

  it("an externally changed served interior still rejects E_STALE_RANGE, not E_UNSERVED_RANGE", async () => {
    await withTempFile("drift.txt", TEN, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await readWindows(harness, "drift.txt", [{ offset: 5, limit: 3 }]);

      const drift = `${TEN_LINES.map((line) => (line === "l6" ? "l6-changed" : line)).join("\n")}\n`;
      await writeFile(path, drift, "utf-8");

      const error = await withSpanMode("strict", () =>
        rejection(
          harness.editTool.execute("edit", {
            path: "drift.txt",
            edits: [[anchors.get("l5")!, anchors.get("l7")!, "L5\nL6\nL7"]],
          }),
        ),
      );

      expect(error.message).toContain("[E_STALE_RANGE]");
      expect(error.message).not.toContain("[E_UNSERVED_RANGE]");
      expect(await readFile(path, "utf-8")).toBe(drift);
      expect(await getUndo(canonicalSync(path))).toBeUndefined();
    });
  });

  it("one strict-refused item aborts the whole batch atomically", async () => {
    await withTempFile("hole.txt", HOLE, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await readWindows(harness, "hole.txt", holeWindows());
      const before = await readFile(path, "utf-8");

      const error = await withSpanMode("strict", () =>
        rejection(
          harness.editTool.execute("edit", {
            path: "hole.txt",
            edits: [
              [anchors.get("begin")!, anchors.get("begin")!, "BEGIN"],
              [anchors.get("begin")!, anchors.get("end")!, "ALL"],
            ],
          }),
        ),
      );

      expect(error.code).toBe("E_BATCH_ABORT");
      expect(error.message).toContain("[E_UNSERVED_RANGE]");
      // Item 1 alone would have written, so the unchanged bytes prove the batch is all-or-nothing.
      expect(await readFile(path, "utf-8")).toBe(before);
      expect(await getUndo(canonicalSync(path))).toBeUndefined();
    });
  });
});
