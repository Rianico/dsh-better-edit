import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { lineHashesPure } from "../../src/hashline/index.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

/**
 * Full-message goldens for the edit rejection surface (#218, spec #214 T5).
 *
 * Every cell drives the REAL `edit` tool through `setupIntegrationTest(cwd)` and asserts the whole
 * model-facing string with `toBe`. The expected text is built from named fragments of the registry
 * formatters — the verdict (`batchAbortFormat`), the list entry (`batchAbortItem`), the range
 * headings (`staleRangeFormat`, `noopLoopFormat`), the row renderer (`fmtServedRows`) and the two
 * serve dispositions (`ROWS_SERVED_NOTE`/`ROWS_NOT_SERVED_NOTE` in `src/mutation/batch-rejection.ts`)
 * — never pasted from a capture. Anchors are deterministic (raw-byte derived), so every hash below
 * is interpolated from `lineHashesPure`; the display path in a bullet is the submitted `file` value,
 * so the goldens are cwd-stable (the one exception is the foreign-anchor home, which the lease store
 * reports as an absolute path — interpolated from the fixture's own cwd there).
 *
 * The assembler indents continuation lines of a bullet by two spaces (`indentContinuation`); the
 * helpers below keep that indent explicit.
 */

const verdict = (failed: number, total: number): string =>
  `[TO MODEL] [E_BATCH_ABORT] Batch rejected: ${failed} of ${total} edits failed; nothing was written.`;
const bullet = (index: number, path: string, code: string, body: string): string =>
  `- edits[${index}] (${path}) [${code}]: ${body}`;

/** A heading plus `hash│line` rows, joined as one block at the given continuation indent. */
const rowBlock = (
  heading: string,
  hashes: readonly string[],
  lines: readonly string[],
  indent = "  ",
): string =>
  [heading, ...hashes.map((hash, index) => `${hash}│${lines[index]!}`)].join(`\n${indent}`);

/** `ROWS_SERVED_NOTE` — src/mutation/batch-rejection.ts, rendered under a single failure. */
const ROWS_SERVED_NOTE =
  "These rows are the file's current anchors and were recorded as served — retry with them.";

/** The served-or-absent sentence `shiftedBufferProjection` appends (src/mutation/engine.ts). */
const changedBufferNote = (lines: string): string =>
  " An earlier item of this call had already changed the temporary batch buffer, so this " +
  "rejection's rows come from an uncommitted buffer and are not guaranteed current-file rows: " +
  `none are shown, none grant leases and none were recorded as served. An anchored read of current-file lines ${lines} would serve that range.`;

/** Every row of a rendered read, in served order. */
async function anchorsOf(read: Promise<unknown>): Promise<string[]> {
  return getText((await read) as { content: Array<{ text?: string }> })
    .split("\n")
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│")[0]!);
}

async function capture(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return String((error as Error).message);
  }
  throw new Error("expected a refusal");
}

describe("edit rejection goldens (#218)", () => {
  it("s1-stale-range: one row-carrying bullet for the stale span, in a 2-item batch", async () => {
    const content = "left\nmiddle\nright\n";
    const served = lineHashesPure(content.trimEnd());
    const disk = "left\nexternal\nright\n";
    await withTempFile("s1.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await anchorsOf(harness.readTool.execute("read", { path: "s1.txt" }));
      // Premise: read anchors are the content-derived hashes this golden interpolates.
      expect(anchors).toEqual(served);
      await writeFile(path, disk, "utf-8");
      const message = await capture(() =>
        harness.editTool.execute("s1", {
          file: "s1.txt",
          edits: [
            { anchor_from: served[2]!, anchor_to: served[2]!, replace_with: "RIGHT" },
            { anchor_from: served[0]!, anchor_to: served[2]!, replace_with: "X" },
          ],
        }),
      );
      const hashes = lineHashesPure(disk.trimEnd());
      const lines = disk.split("\n").slice(0, -1);
      expect(message).toBe(
        [
          verdict(1, 2),
          bullet(
            1,
            "s1.txt",
            "E_STALE_RANGE",
            `line 2 in s1.txt no longer resolves to the line identity it was served with.\n  ` +
              `${rowBlock("Current range:", hashes, lines)}\n  ${ROWS_SERVED_NOTE}`,
          ),
        ].join("\n"),
      );
      // The refusal wrote nothing.
      expect(await readFile(path, "utf-8")).toBe(disk);
    });
  });

  it("s2-strict-rowless: the strict span refusal is one rowless bullet", async () => {
    const content = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
    const hashes = lineHashesPure(content.trimEnd());
    await withTempFile("s2.txt", content, async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const window1 = await anchorsOf(
        harness.readTool.execute("read", { path: "s2.txt", offset: 1, limit: 3 }),
      );
      const window2 = await anchorsOf(
        harness.readTool.execute("read", { path: "s2.txt", offset: 7, limit: 3 }),
      );
      expect(window1).toEqual(hashes.slice(0, 3));
      expect(window2).toEqual(hashes.slice(6, 9));
      process.env.DSH_BETTER_EDIT_SPAN_MODE = "strict";
      _resetConfigCache();
      try {
        const message = await capture(() =>
          harness.editTool.execute("s2", {
            file: "s2.txt",
            edits: [
              { anchor_from: window1[0]!, anchor_to: window1[0]!, replace_with: "L1" },
              // Span lines 3..7: boundaries served, interior 4-6 never served.
              { anchor_from: window1[2]!, anchor_to: window2[0]!, replace_with: "R" },
            ],
          }),
        );
        expect(message).toBe(
          [
            verdict(1, 2),
            bullet(
              1,
              "s2.txt",
              "E_UNSERVED_RANGE",
              "Strict span mode refused the edit to s2.txt: 3 of the 5 file lines it replaces " +
                "were never served.\n  Unserved file lines: 4-6",
            ),
          ].join("\n"),
        );
      } finally {
        delete process.env.DSH_BETTER_EDIT_SPAN_MODE;
        _resetConfigCache();
      }
    });
  });

  it("s3-foreign: an anchor served only for another file is one rowless bullet", async () => {
    await withTempFile("a3.txt", "shared\nleft\n", async ({ cwd }) => {
      await writeFile(join(cwd, "b3.txt"), "shared\nright\n", "utf-8");
      const harness = setupIntegrationTest(cwd);
      const a = await anchorsOf(harness.readTool.execute("read", { path: "a3.txt" }));
      // Serve ONLY b3's second line: b3's line 1 stays unleased here, so the shared anchor's one
      // lease belongs to a3 — the foreign home the rejection must name.
      const b = await anchorsOf(
        harness.readTool.execute("read", { path: "b3.txt", offset: 2, limit: 1 }),
      );
      const message = await capture(() =>
        harness.editTool.execute("s3", {
          file: "b3.txt",
          edits: [
            { anchor_from: b[0]!, anchor_to: b[0]!, replace_with: "RIGHT" },
            { anchor_from: a[0]!, anchor_to: a[0]!, replace_with: "R" },
          ],
        }),
      );
      expect(message).toBe(
        [
          verdict(1, 2),
          // `foreignAnchorFormat`: the home is the lease store's absolute file_path.
          bullet(
            1,
            "b3.txt",
            "E_FOREIGN_ANCHOR",
            `the anchor "${a[0]!}" is inconsistent with b3.txt; served for ` +
              `${join(cwd, "a3.txt")}; nothing was written.`,
          ),
        ].join("\n"),
      );
    });
  });

  it("s4-malformed-anchor-item: a shape-invalid anchor is one bullet naming the fault", async () => {
    // The ticket's literal `"zzz"` is shape-valid alphanumeric (3 chars), so it lands on
    // E_UNKNOWN_ANCHOR; the MALFORMED arm needs a token that fails `parseRef`'s shape gate.
    const content = "one\ntwo\n";
    const hashes = lineHashesPure(content.trimEnd());
    await withTempFile("s4.txt", content, async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await anchorsOf(harness.readTool.execute("read", { path: "s4.txt" }));
      expect(anchors).toEqual(hashes);
      const message = await capture(() =>
        harness.editTool.execute("s4", {
          file: "s4.txt",
          edits: [
            { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "ONE" },
            { anchor_from: "zz", anchor_to: hashes[1]!, replace_with: "R" },
          ],
        }),
      );
      expect(message).toBe(
        [
          verdict(1, 2),
          bullet(
            1,
            "s4.txt",
            "E_MALFORMED_ANCHOR",
            'Invalid anchor "zz": Expected a 3-char alphanumeric anchor (e.g. "aB3").',
          ),
        ].join("\n"),
      );
    });
  });

  it("s5-noop-loop: the rejected repeat carries the on-disk range and its serve note", async () => {
    const content = "one\ntwo\nthree\nfour\n";
    const hashes = lineHashesPure(content.trimEnd());
    const lines = content.split("\n").slice(0, -1);
    await withTempFile("s5.txt", content, async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      // Bounds-only geometry: line 1 and line 4 are served, lines 2-3 are not.
      const first = await anchorsOf(
        harness.readTool.execute("read", { path: "s5.txt", offset: 1, limit: 1 }),
      );
      const last = await anchorsOf(
        harness.readTool.execute("read", { path: "s5.txt", offset: 4, limit: 1 }),
      );
      expect(first).toEqual([hashes[0]!]);
      expect(last).toEqual([hashes[3]!]);
      const call = () =>
        harness.editTool.execute("s5", {
          file: "s5.txt",
          edits: [
            { anchor_from: first[0]!, anchor_to: last[0]!, replace_with: "one\ntwo\nthree\nfour" },
            { anchor_from: first[0]!, anchor_to: last[0]!, replace_with: "one\ntwo\nthree\nfour" },
          ],
        });
      // WHY two calls: the two identical items advance the per-(session,file) counter twice, so the
      // second submission reaches NOOP_LOOP_THRESHOLD (3) — the first is already the warn tier.
      expect(getText(await call())).toContain("was a noop");
      const message = await capture(call);
      expect(message).toBe(
        [
          verdict(1, 2),
          bullet(
            0,
            "s5.txt",
            "E_NOOP_LOOP",
            `identical edit (${hashes[0]!} → ${hashes[3]!}) submitted 3×, no changes each time. ` +
              "Range already contains this text; resend will reject the batch." +
              `\n  ${rowBlock("Current on-disk range:", hashes, lines)}\n  ${ROWS_SERVED_NOTE}`,
          ),
        ].join("\n"),
      );
    });
  });

  it("s6-one-item-range: a one-item call throws the bare range refusal with its rows", async () => {
    const content = "one\ntwo\nthree\n";
    const disk = "one\nTWO\nthree\n";
    await withTempFile("s6.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await anchorsOf(harness.readTool.execute("read", { path: "s6.txt" }));
      expect(anchors).toEqual(lineHashesPure(content.trimEnd()));
      await writeFile(path, disk, "utf-8");
      const message = await capture(() =>
        harness.editTool.execute("s6", {
          file: "s6.txt",
          edits: [{ anchor_from: anchors[0]!, anchor_to: anchors[2]!, replace_with: "X" }],
        }),
      );
      const hashes = lineHashesPure(disk.trimEnd());
      const lines = disk.split("\n").slice(0, -1);
      // Arity one throws the failure error itself: no verdict, no bullet, no indent.
      expect(message).toBe(
        `[TO MODEL] [E_STALE_RANGE] line 2 in s6.txt no longer resolves to the line identity ` +
          `it was served with.\n${rowBlock("Current range:", hashes, lines, "")}`,
      );
    });
  });

  it("s7-two-failures: two bullets render in item order, each with its own region", async () => {
    const content = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
    const served = lineHashesPure(content.trimEnd());
    const disk = "alpha\nBETA\ngamma\ndelta\nEPSILON\nzeta\n";
    await withTempFile("s7.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await anchorsOf(harness.readTool.execute("read", { path: "s7.txt" }));
      expect(anchors).toEqual(served);
      await writeFile(path, disk, "utf-8");
      const message = await capture(() =>
        harness.editTool.execute("s7", {
          file: "s7.txt",
          edits: [
            { anchor_from: served[0]!, anchor_to: served[2]!, replace_with: "R1" },
            { anchor_from: served[3]!, anchor_to: served[5]!, replace_with: "R2" },
          ],
        }),
      );
      const hashes = lineHashesPure(disk.trimEnd());
      const lines = disk.split("\n").slice(0, -1);
      expect(message).toBe(
        [
          verdict(2, 2),
          bullet(
            0,
            "s7.txt",
            "E_STALE_RANGE",
            `line 2 in s7.txt no longer resolves to the line identity it was served with.\n  ` +
              rowBlock("Current range:", hashes.slice(0, 3), lines.slice(0, 3)),
          ),
          bullet(
            1,
            "s7.txt",
            "E_STALE_RANGE",
            `line 5 in s7.txt no longer resolves to the line identity it was served with.\n  ` +
              rowBlock("Current range:", hashes.slice(3, 6), lines.slice(3, 6)),
          ),
        ].join("\n"),
      );
    });
  });

  it("s8-rowless-stale-anchor: a one-item stale anchor renders the bare rowless refusal", async () => {
    // Substitution note: downstream's `E_TARGET_LOST` needs store surgery (a retired lease with a
    // live counterpart), so this cell pins the other rowless single-item refusal the budget list
    // names — `E_STALE_ANCHOR` when an external rewrite removes both anchors' identities.
    const content = "one\ntwo\nthree\nfour\n";
    const served = lineHashesPure(content.trimEnd());
    const disk = "ONE\nTWO\nTHREE\nFOUR\n";
    await withTempFile("s8.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await anchorsOf(harness.readTool.execute("read", { path: "s8.txt" }));
      expect(anchors).toEqual(served);
      await writeFile(path, disk, "utf-8");
      const message = await capture(() =>
        harness.editTool.execute("s8", {
          file: "s8.txt",
          edits: [{ anchor_from: served[0]!, anchor_to: served[1]!, replace_with: "R" }],
        }),
      );
      expect(message).toBe(
        `[TO MODEL] [E_STALE_ANCHOR] 2 stale anchors in s8.txt: "${served[0]!}", ` +
          `"${served[1]!}". Re-read for fresh anchors.`,
      );
      expect(await readFile(path, "utf-8")).toBe(disk);
    });
  });

  it("s9-changed-buffer: a failure behind a changed buffer is rowless and names the read", async () => {
    const content = "alpha\nbeta\ngamma\ndelta\n";
    const served = lineHashesPure(content.trimEnd());
    await withTempFile("s9.txt", content, async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await anchorsOf(harness.readTool.execute("read", { path: "s9.txt" }));
      expect(anchors).toEqual(served);
      const message = await capture(() =>
        harness.editTool.execute("s9", {
          file: "s9.txt",
          edits: [
            // Item 0 grows line 2, so item 1's served span is no longer current-file geometry.
            { anchor_from: served[1]!, anchor_to: served[1]!, replace_with: "beta\nINSERTED" },
            { anchor_from: served[0]!, anchor_to: served[2]!, replace_with: "R" },
          ],
        }),
      );
      expect(message).toBe(
        [
          verdict(1, 2),
          bullet(
            1,
            "s9.txt",
            "E_STALE_RANGE",
            "served span (3 lines) no longer matches current range (4 lines) in s9.txt. " +
              "Re-read." +
              changedBufferNote("1-3"),
          ),
        ].join("\n"),
      );
    });
  });

  it("s10-control: a two-item batch applies and its success shape is unchanged", async () => {
    const content = "alpha\nbeta\n";
    await withTempFile("s10.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchors = await anchorsOf(harness.readTool.execute("read", { path: "s10.txt" }));
      expect(anchors).toEqual(lineHashesPure(content.trimEnd()));
      const text = getText(
        await harness.editTool.execute("s10", {
          file: "s10.txt",
          edits: [
            { anchor_from: anchors[0]!, anchor_to: anchors[0]!, replace_with: "ALPHA" },
            { anchor_from: anchors[1]!, anchor_to: anchors[1]!, replace_with: "BETA" },
          ],
        }),
      );
      expect(text.startsWith("Successfully edited 1 file(s) — 2 of 2 edit(s) applied")).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("ALPHA\nBETA\n");
    });
  });
});
