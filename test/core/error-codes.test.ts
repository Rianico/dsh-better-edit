import { describe, expect, it } from "vitest";
import { assertEditRequest } from "../../src/contract.js";
import { codeOf } from "../../src/utils.js";
import { DomainError, formatError } from "../../src/domain-errors.js";
import {
  resEdit,
  verifyServedRange,
  AnchorMismatchError,
  EditHashEchoError,
  isAnchorMismatch,
  ServedRejectionError,
  lineHashesPure,
} from "../../src/hashline/index.js";
import { finalizeResult, type EditDetails } from "../../src/edit-response.js";

function codeOfThrow(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return codeOf(error);
  }
  throw new Error("expected throw");
}

describe("structured error codes (#55 S1)", () => {
  it("contract rejects carry bare E_BAD_PAYLOAD", () => {
    try {
      assertEditRequest({ path: 123, edits: [] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError<"E_BAD_PAYLOAD">).code).toBe("E_BAD_PAYLOAD");
      expect(codeOf(error)).toBe("E_BAD_PAYLOAD");
    }
  });

  it("anchor-syntax throws carry E_MALFORMED_ANCHOR", () => {
    expect(
      codeOfThrow(() =>
        resEdit({ remove_from: "MQX│x", remove_to: "MQX", replacement_text: "y" } as any),
      ),
    ).toBe("E_MALFORMED_ANCHOR");
  });

  it("retired anchor with changed canon carries E_STALE_RANGE", () => {
    const hashes = lineHashesPure("a\nb\nc");
    try {
      verifyServedRange({
        served: [...hashes],
        servedCanons: ["zzz", "b", "c"],
        retired: new Set([hashes[0]!]),
        startHash: hashes[0]!,
        endHash: hashes[1]!,
        startLine: 1,
        endLine: 2,
        fileHashes: hashes,
        fileLines: ["a", "b", "c"],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServedRejectionError);
      expect((error as ServedRejectionError).code).toBe("E_STALE_RANGE");
      expect(codeOf(error)).toBe("E_STALE_RANGE");
    }
  });

  it("interior hole carries E_UNSERVED_RANGE with kind", () => {
    const hashes = lineHashesPure("a\nb\nc");
    try {
      verifyServedRange({
        served: [hashes[0]!, null, hashes[2]!],
        startHash: hashes[0]!,
        endHash: hashes[2]!,
        startLine: 1,
        endLine: 3,
        fileHashes: hashes,
        fileLines: ["a", "b", "c"],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServedRejectionError);
      expect((error as ServedRejectionError).code).toBe("E_UNSERVED_RANGE");
      expect((error as ServedRejectionError).unservedKind).toBe("interior");
    }
  });

  it("ambiguous served anchor carries E_UNSERVED_RANGE with boundary kind", () => {
    const hashes = lineHashesPure("a\nb\nc");
    try {
      verifyServedRange({
        served: [hashes[0]!, hashes[0]!, hashes[2]!],
        startHash: hashes[0]!,
        endHash: hashes[1]!,
        startLine: 1,
        endLine: 2,
        fileHashes: hashes,
        fileLines: ["a", "b", "c"],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServedRejectionError);
      expect((error as ServedRejectionError).code).toBe("E_UNSERVED_RANGE");
      expect((error as ServedRejectionError).unservedKind).toBe("boundary");
    }
  });

  it("anchor mismatch carries E_STALE_ANCHOR", () => {
    const error = new AnchorMismatchError("E_STALE_ANCHOR", { headline: "m", servedRows: [] });
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe("E_STALE_ANCHOR");
    expect(error.message).toBe("[MODEL] [E_STALE_ANCHOR] m");
    expect(codeOf(error)).toBe("E_STALE_ANCHOR");
  });

  it("echo refusal is E_SUSPICIOUS_TEXT on every channel (not E_STALE_ANCHOR)", () => {
    const error = new EditHashEchoError({
      target: "edit",
      path: "p",
      line: 2,
      hash: "abc",
      servedLine: 2,
    });
    // Structured code, message header and audience agree …
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe("E_SUSPICIOUS_TEXT");
    expect(error.message.startsWith("[MODEL] [E_SUSPICIOUS_TEXT] ")).toBe(true);
    expect(error.audience).toBe("MODEL");
    // … while the existing reject-and-serve branches still recognise it.
    expect(error).toBeInstanceOf(AnchorMismatchError);
    expect(isAnchorMismatch(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ServedRejectionError);
    expect(codeOf(error)).toBe("E_SUSPICIOUS_TEXT");
  });

  it("codeOf falls back to message convention, else undefined", () => {
    expect(codeOf(new Error("[MODEL] [E_EMPTY_RANGE] x"))).toBe("E_EMPTY_RANGE");
    expect(codeOf(new Error("plain failure"))).toBeUndefined();
    expect(codeOf("nope")).toBeUndefined();
  });

  it("EditDetails accepts structured errCode/unservedKind", () => {
    const details: EditDetails = { diff: "", errCode: "E_BAD_PAYLOAD", unservedKind: "boundary" };
    expect(details.errCode).toBe("E_BAD_PAYLOAD");
  });
});

describe("batch drift note retired (#55 S2)", () => {
  it("passes warnings through with no special-casing", () => {
    const text = finalizeResult({ diff: "d", warnings: ["Batch drift note: x", "other"] });
    expect(text).toContain("Batch drift note: x");
    expect(text).toContain("other");
  });
});

describe("registry range-shape rules (F7)", () => {
  const rows = [{ position: 0, hash: "abc" }];
  it("E_STALE_RANGE with rows and no reread flag carries the heading and hint", () => {
    const message = formatError("E_STALE_RANGE", {
      headline: "line 1 differs from what was served.",
      servedRows: rows,
      servedBlock: "abc│one",
    });
    expect(message).toContain("Current range:\nabc│one");
    expect(message).toContain("Retry with these anchors (no read needed).");
  });
  it("E_STALE_RANGE with reread:true keeps the heading but drops the hint", () => {
    const message = formatError("E_STALE_RANGE", {
      headline:
        "anchor was served at line 1 but now resolves to line 5 (pos-restricted concurrency). Re-read.",
      servedRows: rows,
      servedBlock: "abc│one",
      reread: true,
    });
    expect(message).toContain("Current range:\nabc│one");
    expect(message).not.toContain("Retry with these anchors");
  });
  it("E_STALE_RANGE without rows renders the headline alone", () => {
    const message = formatError("E_STALE_RANGE", {
      headline: "The file changed on disk since it was read.",
      servedRows: [],
      servedBlock: "",
      reread: true,
    });
    expect(message).toBe("[MODEL] [E_STALE_RANGE] The file changed on disk since it was read.");
  });
  it("E_STALE_ANCHOR renders headline plus block, never a heading or hint", () => {
    const message = formatError("E_STALE_ANCHOR", {
      headline: '1 stale anchor: "ZZZ". Re-read for fresh anchors.',
      servedRows: rows,
      servedBlock: "  Current context around resolved anchor.",
    });
    expect(message).not.toContain("Current range:");
    expect(message).not.toContain("Retry with these anchors");
    expect(message).toContain("  Current context around resolved anchor.");
  });
});
