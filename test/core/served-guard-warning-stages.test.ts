import { describe, expect, it } from "vitest";

import { useTestHome } from "../support/fixtures.js";
import { applyEdit, canon, lineHashes, resEdit, type HTEdit } from "../../src/hashline/index.js";
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
 */

const home = useTestHome();
const file = "alpha\nbeta\ngamma\ndelta";

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
  it("names the 0-matched write-through with one counted hint (upstream apply.ts:424-427)", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const result = applyTool(
      { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "ZZZ│one\nreal\nZZP│two" },
      hashes,
    );
    expect(result.content).toBe("ZZZ│one\nreal\nZZP│two\nbeta\ngamma\ndelta");
    expect(result.warnings ?? []).toEqual([buildNeverServedEditHint({ count: 2 })]);
  });

  it("fires regardless of the literal declaration (upstream apply.ts:399-402)", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const result = applyTool(
      { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "abc│text" },
      hashes,
      "literal",
    );
    expect(result.content).toBe("abc│text\nbeta\ngamma\ndelta");
    expect(result.warnings ?? []).toEqual([buildNeverServedEditHint({ count: 1 })]);
  });

  it("stays silent when the replacement carries no anchor shape", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const result = applyTool(
      { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "+ abc│def\nplain" },
      hashes,
    );
    expect(result.warnings ?? []).toEqual([]);
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
