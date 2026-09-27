import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { getText, setupIntegrationTest, useTestHome, withTempFile } from "../support/fixtures.js";
import { applyEdit, canon, lineHashes, resEdit, type HTEdit } from "../../src/hashline/index.js";
import { initHasher } from "../../src/hashline/hasher.js";
import {
  ANCHOR_PREFIX_REMEDY,
  buildNeverServedEditHint,
  buildServedEditPrefixNote,
} from "../../src/hashline/served-guard.js";

/**
 * FU-5 (§4.7 conformance): the applied-bytes warn tiers beside the 0-matched
 * write-through (#63 / ADR-0025). The write-through KEEPS writing — upstream
 * conformance is the WARNING behavior, not a new refusal. Upstream referents:
 * `pi-better-edit@b92e0ec:src/hashline/served-guard.ts:202,279` and the stages
 * at `src/hashline/apply.ts:403-427`.
 *
 * FU-R (upstream `never-served-soft-hint.test.ts`): the never-served count travels
 * as structured data and the batch engine renders ONE counted hint per call; the
 * applyEdit-level cells below pin the data channel, the tool-level cells pin the
 * aggregation, and the registry cells pin both format bodies literally.
 */

const home = useTestHome();
beforeAll(async () => {
  await initHasher();
});
const file = "alpha\nbeta\ngamma\ndelta";

/** Local hint detector for rendered warnings (test-only), mirroring upstream :31-36.
 * Production no longer matches warning strings per item; the count travels as data. */
const HINT_MARK = "never served for this session and file";
function isRenderedHint(warning: string): boolean {
  return warning.includes(HINT_MARK);
}

function applyTool(toolEdit: HTEdit, precomputedHashes?: string[], mode?: "literal") {
  return applyEdit(
    file,
    resEdit(toolEdit),
    undefined,
    precomputedHashes,
    undefined,
    undefined,
    undefined,
    undefined,
    mode,
  );
}

describe("FU-5 — never-served shape tier on the applied write-through", () => {
  it("carries the offending count as data — no rendered hint at the apply level (upstream apply.ts:399-431)", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const result = applyTool(
      { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "ZZZ│one\nreal\nZZP│two" },
      hashes,
    );
    expect(result.content).toBe("ZZZ│one\nreal\nZZP│two\nbeta\ngamma\ndelta");
    expect(result.neverServedCount).toBe(2);
    expect((result.warnings ?? []).filter(isRenderedHint)).toHaveLength(0);
  });

  it("fires regardless of the literal declaration (upstream apply.ts:399-402)", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const result = applyTool(
      { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "abc│text" },
      hashes,
      "literal",
    );
    expect(result.content).toBe("abc│text\nbeta\ngamma\ndelta");
    expect(result.neverServedCount).toBe(1);
    expect((result.warnings ?? []).filter(isRenderedHint)).toHaveLength(0);
  });

  it("stays silent when the replacement carries no anchor shape", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const result = applyTool(
      { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "+ abc│def\nplain" },
      hashes,
    );
    expect(result.warnings ?? []).toEqual([]);
    expect(result.neverServedCount).toBeUndefined();
  });
});

describe("FU-5 — served prefix mismatch tier (evidence-gated middle tier)", () => {
  // `OLD` was served at position 2 but is no longer a file anchor (post-drift):
  // the strip arm sees 0 matched and writes through; the mismatch tier owns the line.
  function staleServe(replacement: string, servedCanonAtOld: string) {
    return async () => {
      const hashes = await lineHashes(file, home.testPath);
      const served = [hashes[0]!, "OLD", null, null];
      const servedCanons = [canon("alpha"), canon(servedCanonAtOld), null, null];
      const result = applyEdit(
        file,
        resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: replacement }),
        undefined,
        hashes,
        undefined,
        served,
        servedCanons,
      );
      return result;
    };
  }

  it("notes a served anchor whose remainder differs from the serve", async () => {
    const result = await staleServe("OLD│newtext", "beta-old")();
    expect(result.content).toBe("OLD│newtext\nbeta\ngamma\ndelta");
    expect(result.warnings ?? []).toEqual([
      buildServedEditPrefixNote({ k: 1, anchor: "OLD", servedLine: 2 }),
    ]);
  });

  it("excludes exact reproductions — the gate owns them, no hint fires", async () => {
    const result = await staleServe("OLD│beta", "beta")();
    expect(result.content).toBe("OLD│beta\nbeta\ngamma\ndelta");
    expect(result.warnings ?? []).toEqual([]);
  });
});

describe("FU-5 — the remedy clause is byte-identical across both builders", () => {
  it("both applied-hint builders carry ANCHOR_PREFIX_REMEDY verbatim", () => {
    const note = buildServedEditPrefixNote({ k: 1, anchor: "aB3", servedLine: 2 });
    const hint = buildNeverServedEditHint({ count: 1 });
    expect(note.endsWith(ANCHOR_PREFIX_REMEDY)).toBe(true);
    expect(hint.endsWith(ANCHOR_PREFIX_REMEDY)).toBe(true);
    expect(ANCHOR_PREFIX_REMEDY).toContain("`undo_last_edit`");
  });
});

describe("FU-R — both warn-format bodies are pinned literally", () => {
  it("the count===1 arm of neverServedShapeFormat renders the singular body verbatim", () => {
    expect(buildNeverServedEditHint({ count: 1 })).toBe(
      "[MODEL] [W_NEVER_SERVED_SHAPE] 1 replacement line opens with an anchor-shaped token " +
        "never served for this session and file. Applied verbatim. " +
        ANCHOR_PREFIX_REMEDY,
    );
  });

  it("the plural arm of neverServedShapeFormat renders the counted body verbatim", () => {
    expect(buildNeverServedEditHint({ count: 5 })).toBe(
      "[MODEL] [W_NEVER_SERVED_SHAPE] 5 replacement lines open with anchor-shaped tokens " +
        "never served for this session and file. Applied verbatim. " +
        ANCHOR_PREFIX_REMEDY,
    );
  });

  it("servedPrefixMismatchFormat renders the k/anchor/servedLine body verbatim", () => {
    expect(buildServedEditPrefixNote({ k: 3, anchor: "aB3", servedLine: 7 })).toBe(
      "[MODEL] [W_SERVED_PREFIX_MISMATCH] Line 3 begins with the exact aB3│ anchor " +
        "served for this session and file for line 7, " +
        "but its content differs from what was served. Applied verbatim. " +
        ANCHOR_PREFIX_REMEDY,
    );
  });
});

describe("FU-R — the batch engine renders ONE counted hint per call (upstream never-served-soft-hint.test.ts:150-218)", () => {
  it("reports success with one counted hint and keeps file bytes verbatim", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", home.testPath);
      await readTool.execute("r1", { path });
      expect(hashes).not.toContain("ZZZ");
      const submitted = "ZZZ│alpha";
      const result = await editTool.execute("e1", {
        path,
        edits: [[hashes[1]!, hashes[1]!, submitted]],
      });
      const text = getText(result);
      expect(text).toContain("Successfully edited");
      const hints = text.split("\n").filter(isRenderedHint);
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain("[MODEL] [W_NEVER_SERVED_SHAPE]");
      expect(hints[0]).toContain("1");
      expect(hints[0]).toContain(ANCHOR_PREFIX_REMEDY);
      expect(hints[0]).not.toContain("No action is required");
      expect(await readFile(path, "utf-8")).toContain(submitted);
    });
  });

  it("emits exactly one hint for the whole call when 2 batch items offend", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\nfour\n", async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\nfour\n", home.testPath);
      await readTool.execute("r1", { path });
      expect(hashes).not.toContain("ZZZ");
      expect(hashes).not.toContain("QQQ");
      const first = "ZZZ│alpha";
      const second = "QQQ│beta";
      const result = await editTool.execute("e1", {
        path,
        edits: [
          [hashes[0]!, hashes[0]!, first],
          [hashes[2]!, hashes[2]!, second],
        ],
      });
      const text = getText(result);
      expect(text).toContain("Successfully edited");
      const hints = text.split("\n").filter(isRenderedHint);
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain("[MODEL] [W_NEVER_SERVED_SHAPE]");
      expect(hints[0]).toContain("2");
      expect(hints[0]).toContain(ANCHOR_PREFIX_REMEDY);
      expect(hints[0]).not.toContain("No action is required");
      const bytes = await readFile(path, "utf-8");
      expect(bytes).toContain(first);
      expect(bytes).toContain(second);
    });
  });
});
