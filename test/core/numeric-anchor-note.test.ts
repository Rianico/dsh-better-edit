import { describe, expect, it } from "vitest";

import { DomainError, ERROR_REGISTRY } from "../../src/domain-errors.js";
import { applyEdit, resEdit } from "../../src/hashline/anchor-pipeline.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";

/**
 * Numeric-anchor diagnosis (B, upstream 33ccb0d): an all-digit anchor is
 * shape evidence that steers away from line numbers. The note renders in
 * E_UNKNOWN_ANCHOR (deferred production, constructed directly here) and in
 * the E_STALE_ANCHOR not_found headline we do produce (end-to-end).
 */
describe("numeric-anchor diagnosis", () => {
  it("single numeric anchor notes that it resembles a line number", () => {
    const error = new DomainError("E_UNKNOWN_ANCHOR", { path: "a.py", anchors: ["833"] });
    expect(error.code).toBe("E_UNKNOWN_ANCHOR");
    expect(error.message.startsWith("[MODEL] [E_UNKNOWN_ANCHOR] ")).toBe(true);
    expect(error.message).toContain('a.py has not served the anchor "833"; nothing was written.');
    expect(error.message).toContain('Note: anchor "833" consists only of digits');
    expect(error.message).toContain("resembles a line number");
    expect(error.message).toContain('3-character alphanumeric content hashes (e.g. "aB3")');
  });

  it("multiple numeric anchors use plural wording", () => {
    const error = new DomainError("E_UNKNOWN_ANCHOR", { path: "a.py", anchors: ["12", "833"] });
    expect(error.message).toContain('Note: anchors "12", "833" consist only of digits');
    expect(error.message).toContain("resemble line numbers");
  });

  it("mixed pair notes only the numeric anchor", () => {
    const error = new DomainError("E_UNKNOWN_ANCHOR", { path: "a.py", anchors: ["ZZZ", "733"] });
    expect(error.message).toContain(
      'has not served the anchors "ZZZ", "733"; nothing was written.',
    );
    expect(error.message).toContain('Note: anchor "733" consists only of digits');
    expect(error.message).not.toContain('"ZZZ" consists');
  });

  it("non-numeric anchor renders no note", () => {
    const error = new DomainError("E_UNKNOWN_ANCHOR", { path: "a.py", anchors: ["ZZZ"] });
    expect(error.message).toBe(
      '[MODEL] [E_UNKNOWN_ANCHOR] a.py has not served the anchor "ZZZ"; nothing was written.',
    );
    expect(error.message).not.toContain("Note:");
  });

  it("E_UNKNOWN_ANCHOR carries no remedy", () => {
    expect("remedy" in ERROR_REGISTRY.E_UNKNOWN_ANCHOR).toBe(false);
  });

  it("E_STALE_ANCHOR producer path appends the note end-to-end", () => {
    const content = "alpha\nbeta\n";
    const hashes = lineHashesPure(content);
    const edit = resEdit({ anchor_from: "833", anchor_to: "833", replace_with: "x" });
    let message = "";
    try {
      applyEdit(
        content,
        edit,
        undefined,
        hashes,
        "a.py",
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toMatch(/\[MODEL\] \[E_STALE_ANCHOR\]/);
    expect(message).toContain('2 stale anchors in a.py: "833", "833". Re-read for fresh anchors.');
    expect(message).toContain('Note: anchors "833", "833" consist only of digits');
  });

  it("E_STALE_ANCHOR without numeric anchors renders no note", () => {
    const content = "alpha\nbeta\n";
    const hashes = lineHashesPure(content);
    const edit = resEdit({ anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "x" });
    let message = "";
    try {
      applyEdit(
        content,
        edit,
        undefined,
        hashes,
        "a.py",
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toMatch(/\[MODEL\] \[E_STALE_ANCHOR\]/);
    expect(message).not.toContain("Note:");
  });
});
