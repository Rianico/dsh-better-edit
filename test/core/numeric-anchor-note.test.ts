import { describe, expect, it } from "vitest";

import { ERROR_REGISTRY } from "../../src/domain-errors.js";
import { applyEdit, resEdit } from "../../src/hashline/anchor-pipeline.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";

import { type LeaseSpanSource, verifyServedRange } from "../../src/hashline/index.js";

/** Count non-overlapping matches of `needle` — e.g. how often one anchor is named. */
function countMatches(haystack: string, needle: RegExp): number {
  return [...haystack.matchAll(new RegExp(needle.source, "g"))].length;
}

/**
 * Numeric-anchor diagnosis (B, upstream 33ccb0d): an all-digit anchor is
 * shape evidence that steers away from line numbers.
 *
 * T4 (CP1-r3) deleted the declaration-only `E_UNKNOWN_ANCHOR`; FU-4 re-introduced it
 * WITH its producer (the never-served anchor refusals in `served-evidence.ts`), exactly
 * as this file's own rule demanded ("a future absorb that ports its upstream producer
 * must reintroduce it WITH the producer"). The `E_STALE_ANCHOR` not_found headline still
 * carries the note, pinned end-to-end below.
 */
describe("numeric-anchor diagnosis", () => {
  it("the numeric note survives E_UNKNOWN_ANCHOR's FU-4 re-introduction with its producer", () => {
    // The declaration is back only because a producer exists: pin both halves, so a
    // re-addition without a producer still fails here and in the arch oracle.
    expect("E_UNKNOWN_ANCHOR" in ERROR_REGISTRY).toBe(true);

    const content = "alpha\nbeta\n";
    const hashes = lineHashesPure(content);
    const edit = resEdit({ anchor_from: "833", anchor_to: "833", replace_with: "x" });
    let message = "";
    try {
      applyEdit(content, edit, undefined, hashes, "a.py", [], undefined, undefined, undefined);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toMatch(/\[TO MODEL\] \[E_STALE_ANCHOR\]/);
    // #107: the duplicate bounds are ONE anchor — singular count, one name in the list,
    // one numeric note, and no context block (an unresolved anchor has no resolved neighbour).
    expect(message).toBe(
      `[TO MODEL] [E_STALE_ANCHOR] 1 stale anchor in a.py: "833". Re-read for fresh anchors. ` +
        `Note: anchor "833" consists only of digits and resembles a line number. ` +
        `Edit anchors are 3-character alphanumeric content hashes (e.g. "aB3") served by the read tool, not line numbers.`,
    );
    expect(message).toContain('3-character alphanumeric content hashes (e.g. "aB3")');
  });

  // #107 (upstream pi-better-edit@3b22008, a missed line inside the absorbed range): a rejection
  // counts and names distinct anchors, never bounds — one single-line edit submits one anchor as
  // both bounds, so both slots report the same mismatch.
  it("a non-numeric anchor used as both bounds is one stale anchor, named once", () => {
    const content = "alpha\nbeta\n";
    const hashes = lineHashesPure(content);
    const edit = resEdit({ anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "x" });
    let message = "";
    try {
      applyEdit(content, edit, undefined, hashes, "a.py", [], undefined, undefined, undefined);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toBe(
      '[TO MODEL] [E_STALE_ANCHOR] 1 stale anchor in a.py: "ZZZ". Re-read for fresh anchors.',
    );
    expect(countMatches(message, /"ZZZ"/)).toBe(1);
    expect(message).not.toContain("2 stale anchors");
  });

  // A4 lock: the lease-path producer already dedupes via `new Set`, so both rejection families
  // agree that one anchor used as both bounds is named once.
  it("the lease path names a duplicate bound once (E_UNKNOWN_ANCHOR)", () => {
    const content = "alpha\nbeta\n";
    const hashes = lineHashesPure(content);
    const bound = hashes[0]!;
    const unleased: LeaseSpanSource = {
      leaseFor: () => undefined,
      rebasedLineOf: () => undefined,
      anchorHomes: () => [],
    };
    let message = "";
    try {
      verifyServedRange({
        served: [hashes[0]!, hashes[1]!],
        startHash: bound,
        endHash: bound,
        startLine: 1,
        endLine: 1,
        fileHashes: [...hashes],
        fileLines: ["alpha", "beta"],
        filePath: "a.py",
        leaseSource: unleased,
      });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toBe(
      `[TO MODEL] [E_UNKNOWN_ANCHOR] a.py has not served the anchor "${bound}"; nothing was written.`,
    );
    expect(countMatches(message, new RegExp(`"${bound}"`))).toBe(1);
  });

  // Coverage kept from the deleted E_UNKNOWN_ANCHOR cells: the singular branch
  // and the mixed-pair rule, now driven through the surviving end-to-end path.
  it("a single numeric anchor among non-numeric ones keeps the singular wording", () => {
    const content = "alpha\nbeta\n";
    const hashes = lineHashesPure(content);
    const edit = resEdit({ anchor_from: "833", anchor_to: "ZZZ", replace_with: "x" });
    let message = "";
    try {
      applyEdit(content, edit, undefined, hashes, "a.py", [], undefined, undefined, undefined);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain('2 stale anchors in a.py: "833", "ZZZ". Re-read for fresh anchors.');
    expect(message).toContain('Note: anchor "833" consists only of digits');
    expect(message).toContain("resembles a line number");
    expect(message).not.toContain('"ZZZ" consists');
  });

  it("E_STALE_ANCHOR without numeric anchors renders no note", () => {
    const content = "alpha\nbeta\n";
    const hashes = lineHashesPure(content);
    const edit = resEdit({ anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "x" });
    let message = "";
    try {
      applyEdit(content, edit, undefined, hashes, "a.py", [], undefined, undefined, undefined);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toMatch(/\[TO MODEL\] \[E_STALE_ANCHOR\]/);
    expect(message).not.toContain("Note:");
  });
});
