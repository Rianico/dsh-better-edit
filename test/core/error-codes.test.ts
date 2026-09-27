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
        resEdit({ anchor_from: "MQX│x", anchor_to: "MQX", replace_with: "y" } as any),
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

  // FU-4 granularity: a boundary anchor with NO served position is a never-served anchor —
  // refused `E_UNKNOWN_ANCHOR` with no rows (upstream b92e0ec:src/hashline/lease-resolve.ts:87-118
  // and its non-leased analogue `served-verification.ts:729-749`), not a range-serve.
  it("boundary anchor with no served position carries E_UNKNOWN_ANCHOR (FU-4)", () => {
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
      expect(error).toBeInstanceOf(DomainError);
      expect(error).not.toBeInstanceOf(ServedRejectionError);
      expect((error as DomainError).code).toBe("E_UNKNOWN_ANCHOR");
      expect(String((error as Error).message)).toContain(
        `has not served the anchor "${hashes[1]!}"`,
      );
    }
  });

  it("ambiguous served anchor carries E_UNSERVED_RANGE with boundary kind", () => {
    const hashes = lineHashesPure("a\nb\nc");
    try {
      verifyServedRange({
        served: [hashes[0]!, hashes[0]!, hashes[2]!],
        startHash: hashes[2]!,
        endHash: hashes[0]!,
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
    expect(error.message).toBe("[TO MODEL] [E_STALE_ANCHOR] m");
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
    expect(error.message.startsWith("[TO MODEL] [E_SUSPICIOUS_TEXT] ")).toBe(true);
    expect(error.audience).toBe("MODEL");
    // … while the existing reject-and-serve branches still recognise it.
    expect(error).toBeInstanceOf(AnchorMismatchError);
    expect(isAnchorMismatch(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ServedRejectionError);
    expect(codeOf(error)).toBe("E_SUSPICIOUS_TEXT");
  });

  it("codeOf falls back to message convention, else undefined", () => {
    expect(codeOf(new Error("[TO MODEL] [E_EMPTY_RANGE] x"))).toBe("E_EMPTY_RANGE");
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
  it("E_STALE_RANGE with rows renders the heading and the named region's rows (T6)", () => {
    const message = formatError("E_STALE_RANGE", {
      headline: "line 1 differs from what was served.",
      servedRows: rows,
      servedBlock: "abc│one",
    });
    expect(message).toContain("Current range:\nabc│one");
    // T6 deleted the `Retry with these anchors (no read needed).` affordance: the payload's
    // rows are the affordance, and the echoed rows are NOT serves (T3f/T4).
    expect(message).not.toContain("Retry with these anchors");
  });
  it("E_STALE_RANGE without rows renders the headline alone", () => {
    const message = formatError("E_STALE_RANGE", {
      headline: "The file changed on disk since it was read.",
      servedRows: [],
      servedBlock: "",
    });
    expect(message).toBe("[TO MODEL] [E_STALE_RANGE] The file changed on disk since it was read.");
  });
  it("E_STALE_ANCHOR renders headline plus block, never a heading or a retry affordance", () => {
    const message = formatError("E_STALE_ANCHOR", {
      headline: '1 stale anchor: "ZZZ". Re-read for fresh anchors.',
      servedRows: rows,
      servedBlock: "  Current context around resolved anchor.",
    });
    expect(message).not.toContain("Current range:");
    expect(message).not.toContain("Retry with these anchors");
    expect(message).toContain("  Current context around resolved anchor.");
  });
  it("E_UNSERVED_RANGE obeys the same row-gated rule as E_STALE_RANGE (T6)", () => {
    const unserved = {
      headline: "line 2 was never served.",
      servedRows: rows,
      servedBlock: "abc│one",
      unservedKind: "interior" as const,
    };
    const withRows = formatError("E_UNSERVED_RANGE", unserved);
    const withoutRows = formatError("E_UNSERVED_RANGE", {
      ...unserved,
      servedRows: [],
      servedBlock: "",
    });
    expect({
      withRowsShowsHeading: withRows.includes("Current range:\nabc│one"),
      withRowsShowsHint: withRows.includes("Retry with these anchors"),
      withoutRowsShowsHeading: withoutRows.includes("Current range:"),
      withoutRowsIsHeadlineOnly:
        withoutRows === "[TO MODEL] [E_UNSERVED_RANGE] line 2 was never served.",
    }).toEqual({
      withRowsShowsHeading: true,
      withRowsShowsHint: false,
      withoutRowsShowsHeading: false,
      withoutRowsIsHeadlineOnly: true,
    });
  });
});

/**
 * FU-R R4c: the E_FOREIGN_ANCHOR homes display. The `and N more` arm is reachable in
 * production (lineage-store's anchorHomes SQL has no LIMIT and the dedup union can
 * exceed three) but no test exercised it — pinned literally per the #75 lesson,
 * together with the three-or-fewer arm it caps against.
 */
describe("E_FOREIGN_ANCHOR homes display (FU-R R4c)", () => {
  const single = { path: "target.ts", anchors: ["aB3"] };
  it("lists up to three homes verbatim", () => {
    expect(
      formatError("E_FOREIGN_ANCHOR", {
        ...single,
        homes: ["one.ts", "two.ts", "three.ts"],
      }),
    ).toBe(
      '[TO MODEL] [E_FOREIGN_ANCHOR] the anchor "aB3" is inconsistent with target.ts; ' +
        "served for one.ts, two.ts, three.ts; nothing was written.",
    );
  });
  it("caps at three homes and counts the remainder", () => {
    expect(
      formatError("E_FOREIGN_ANCHOR", {
        ...single,
        homes: ["one.ts", "two.ts", "three.ts", "four.ts", "five.ts"],
      }),
    ).toBe(
      '[TO MODEL] [E_FOREIGN_ANCHOR] the anchor "aB3" is inconsistent with target.ts; ' +
        "served for one.ts, two.ts, three.ts and 2 more; nothing was written.",
    );
  });
});
