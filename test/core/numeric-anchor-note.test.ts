import { describe, expect, it } from "vitest";

import { ERROR_REGISTRY } from "../../src/domain-errors.js";
import { applyEdit, resEdit } from "../../src/hashline/anchor-pipeline.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";

/**
 * Numeric-anchor diagnosis (B, upstream 33ccb0d): an all-digit anchor is
 * shape evidence that steers away from line numbers.
 *
 * T4 (CP1-r3) deleted the declaration-only `E_UNKNOWN_ANCHOR`; FU-4 re-introduced it
 * WITH its producer (the never-served anchor refusals in `anchor-pipeline.ts`), exactly
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
    expect(message).toContain('2 stale anchors in a.py: "833", "833". Re-read for fresh anchors.');
    expect(message).toContain('Note: anchors "833", "833" consist only of digits');
    expect(message).toContain("resemble line numbers");
    expect(message).toContain('3-character alphanumeric content hashes (e.g. "aB3")');
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
