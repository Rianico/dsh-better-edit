import { describe, expect, it, beforeAll } from "vitest";

import { canon, canonDigest, lineHashesPure } from "../../src/hashline/hash-assign.js";
import { initHasher } from "../../src/hashline/hash-assign.js";

beforeAll(async () => {
  await initHasher();
});

type EdgeDisposition = "normalize" | "significant";

interface CpRow {
  cp: string;
  name: string;
  edge: EdgeDisposition;
}

/**
 * The executable record of the canon v4 class (issues #135, ADR-0002 + ADR-0040): every code point
 * the policy names, with its EDGE disposition — whether it belongs to the frozen 28-code-point trim
 * class, so a leading or trailing run of it is stripped before the canon digest is taken.
 *
 * The middle position is significant for EVERY row, class member or not (#135): the canon is
 * trim-only, it strips one leading and one trailing run and never an interior one, so
 * `a<cp>b` keeps `<cp>` in every row and only the edges of a `normalize` row collapse. A future
 * class change must consciously edit a row here. Hash identity is asserted uniformly through
 * `canonDigest`; `lineHashesPure` backs the raw-byte identity surface for representative rows
 * at the bottom (anchors hash the RAW line: #138 / upstream ADR-0013).
 */
const DISPOSITIONS: CpRow[] = [
  { cp: "\u0009", name: "TAB U+0009", edge: "normalize" },
  { cp: "\u000A", name: "LF U+000A", edge: "normalize" },
  { cp: "\u000B", name: "VT U+000B", edge: "normalize" },
  { cp: "\u000C", name: "FF U+000C", edge: "normalize" },
  { cp: "\u000D", name: "CR U+000D", edge: "normalize" },
  { cp: "\u0020", name: "SPACE U+0020", edge: "normalize" },
  { cp: "\u0085", name: "NEL U+0085", edge: "normalize" },
  { cp: "\u00A0", name: "NBSP U+00A0", edge: "normalize" },
  { cp: "\u1680", name: "OGHAM SPACE MARK U+1680", edge: "normalize" },
  { cp: "\u2000", name: "EN QUAD U+2000", edge: "normalize" },
  { cp: "\u2001", name: "EM QUAD U+2001", edge: "normalize" },
  { cp: "\u2002", name: "EN SPACE U+2002", edge: "normalize" },
  { cp: "\u2003", name: "EM SPACE U+2003", edge: "normalize" },
  { cp: "\u2004", name: "THREE-PER-EM SPACE U+2004", edge: "normalize" },
  { cp: "\u2005", name: "FOUR-PER-EM SPACE U+2005", edge: "normalize" },
  { cp: "\u2006", name: "SIX-PER-EM SPACE U+2006", edge: "normalize" },
  { cp: "\u2007", name: "FIGURE SPACE U+2007", edge: "normalize" },
  { cp: "\u2008", name: "PUNCTUATION SPACE U+2008", edge: "normalize" },
  { cp: "\u2009", name: "THIN SPACE U+2009", edge: "normalize" },
  { cp: "\u200A", name: "HAIR SPACE U+200A", edge: "normalize" },
  { cp: "\u2028", name: "LINE SEPARATOR U+2028", edge: "normalize" },
  { cp: "\u2029", name: "PARAGRAPH SEPARATOR U+2029", edge: "normalize" },
  { cp: "\u202F", name: "NARROW NO-BREAK SPACE U+202F", edge: "normalize" },
  { cp: "\u205F", name: "MEDIUM MATHEMATICAL SPACE U+205F", edge: "normalize" },
  { cp: "\u3000", name: "IDEOGRAPHIC SPACE U+3000", edge: "normalize" },
  { cp: "\u200E", name: "LEFT-TO-RIGHT MARK U+200E", edge: "normalize" },
  { cp: "\u200F", name: "RIGHT-TO-LEFT MARK U+200F", edge: "normalize" },
  { cp: "\uFEFF", name: "ZERO WIDTH NO-BREAK SPACE U+FEFF", edge: "normalize" },
  { cp: "\u200B", name: "ZERO WIDTH SPACE U+200B", edge: "significant" },
  { cp: "\u200C", name: "ZERO WIDTH NON-JOINER U+200C", edge: "significant" },
  { cp: "\u200D", name: "ZERO WIDTH JOINER U+200D", edge: "significant" },
  { cp: "\u00AD", name: "SOFT HYPHEN U+00AD", edge: "significant" },
  { cp: "\u2060", name: "WORD JOINER U+2060", edge: "significant" },
  { cp: "\u180E", name: "MONGOLIAN VOWEL SEPARATOR U+180E", edge: "significant" },
  { cp: "\u001C", name: "FILE SEPARATOR U+001C", edge: "significant" },
  { cp: "\u001D", name: "GROUP SEPARATOR U+001D", edge: "significant" },
  { cp: "\u001E", name: "RECORD SEPARATOR U+001E", edge: "significant" },
  { cp: "\u001F", name: "UNIT SEPARATOR U+001F", edge: "significant" },
  { cp: "\u0080", name: "PADDING CHARACTER U+0080", edge: "significant" },
  { cp: "\u0081", name: "HIGH OCTET PRESET U+0081", edge: "significant" },
  { cp: "\u009F", name: "APPLICATION PROGRAM COMMAND U+009F", edge: "significant" },
];

describe("canon v4 disposition table — executable record (issues #135, ADR-0002 + ADR-0040)", () => {
  it.each(DISPOSITIONS.map((row) => [row.name, row] as const))(
    "%s",
    (_name: string, row: CpRow) => {
      const { cp, edge } = row;
      const edges: [string, string][] = [
        ["leading", `${cp}ab`],
        ["trailing", `ab${cp}`],
      ];
      for (const [position, probe] of edges) {
        if (edge === "normalize") {
          expect(canon(probe), `${row.name} ${position}`).toBe(canon("ab"));
          expect(canonDigest(probe), `${row.name} ${position}`).toBe(canonDigest("ab"));
        } else {
          expect(canon(probe), `${row.name} ${position}`).not.toBe(canon("ab"));
          expect(canonDigest(probe), `${row.name} ${position}`).not.toBe(canonDigest("ab"));
        }
      }
      const middle = `a${cp}b`;
      expect(canon(middle), `${row.name} middle`).not.toBe(canon("ab"));
      expect(canonDigest(middle), `${row.name} middle`).not.toBe(canonDigest("ab"));
    },
  );

  it("trims C1 code points at the edges only, and only NEL U+0085 is in the trim class", () => {
    for (let cp = 0x0080; cp <= 0x009f; cp++) {
      const char = String.fromCharCode(cp);
      const name = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(canon(`a${char}b`), `${name} middle`).toBe(`a${char}b`);
      expect(canonDigest(`a${char}b`), `${name} middle`).not.toBe(canonDigest("ab"));
      if (cp === 0x0085) {
        expect(canon(`${char}ab`), `${name} leading`).toBe(canon("ab"));
        expect(canon(`ab${char}`), `${name} trailing`).toBe(canon("ab"));
        continue;
      }
      expect(canon(`${char}ab`), `${name} leading`).not.toBe(canon("ab"));
      expect(canon(`ab${char}`), `${name} trailing`).not.toBe(canon("ab"));
    }
  });

  it("carries the edge disposition through the canon, not through the anchor (#138)", () => {
    const base = lineHashesPure("ab\n");
    for (const cp of ["\u00A0", "\u2003", "\u3000", "\uFEFF"]) {
      const label = `normalize ${cp.codePointAt(0)}`;
      expect(canon(`a${cp}b`), `${label} middle`).not.toBe(canon("ab"));
      expect(canonDigest(`a${cp}b`), `${label} middle`).not.toBe(canonDigest("ab"));
      expect(lineHashesPure(`a${cp}b\n`)[0], `raw ${cp.codePointAt(0)}`).not.toBe(base[0]);
      for (const probe of [`${cp}ab`, `ab${cp}`]) {
        expect(canon(probe), `${label} edge ${cp.codePointAt(0)}`).toBe(canon("ab"));
        expect(lineHashesPure(`${probe}\n`)[0], `raw ${cp.codePointAt(0)}`).not.toBe(base[0]);
      }
    }
    for (const cp of ["\u200B", "\u00AD", "\u2060"]) {
      for (const probe of [`a${cp}b`, `${cp}ab`, `ab${cp}`]) {
        expect(canon(probe), `significant ${cp.codePointAt(0)}`).not.toBe(canon("ab"));
        expect(lineHashesPure(`${probe}\n`)[0], `raw ${cp.codePointAt(0)}`).not.toBe(base[0]);
      }
    }
  });
});
