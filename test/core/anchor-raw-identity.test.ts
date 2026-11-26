import { beforeAll, describe, expect, it } from "vitest";
import { ANCHOR_GENERATION, canon, initHasher, lineHashesPure } from "../../src/hashline/index.js";

/**
 * The identity half of the canon split (ticket #138, the downstream port of upstream `a14fbc7`
 * / ADR-0013): a served anchor keys on the line's RAW bytes. `canon` still folds the frozen
 * 28-code-point whitespace class at the line's edges, but only as an alignment and verification
 * digest — never as an identity function.
 *
 * WHY these three lines: downstream canon v4 is TRIM-ONLY (ADR-0040), so a canon-equal trio has to
 * differ at the EDGES, not inside the line. All three spell `const a = 1;` once trimmed, so a
 * canon-keyed allocator cannot tell them apart and falls back to its positional probe. Measured
 * before the fix: each line derived alone spelled `7rq`, and inside one file they spelled
 * `7rq`, `8sr`, `9ts` — the last two are probe offsets, not identities.
 */
const CANON_EQUAL_LINES = ["const a = 1;", "\tconst a = 1;", "   const a = 1;  "];

beforeAll(async () => {
  await initHasher();
});

describe("anchor identity derives from raw bytes (#138)", () => {
  it("pins ANCHOR_GENERATION at 2 — the raw-byte seeding generation", () => {
    expect(ANCHOR_GENERATION).toBe(2);
  });

  it("#138: three canon-equal lines derive three distinct, content-derived anchors", () => {
    const folded = canon("const a = 1;");
    for (const line of CANON_EQUAL_LINES) expect(canon(line)).toBe(folded);

    const solo: (string | undefined)[] = [];
    for (const line of CANON_EQUAL_LINES) {
      const [anchor] = lineHashesPure(`${line}\n`);
      solo.push(anchor);
    }
    expect(solo).toEqual(["7rq", "nzW", "olD"]);

    const inFile = lineHashesPure(`${CANON_EQUAL_LINES.join("\n")}\n`);
    expect(new Set(inFile).size).toBe(3);
    expect(inFile).toEqual(solo);
  });
});
