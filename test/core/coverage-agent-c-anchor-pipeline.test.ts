import { describe, expect, it, vi } from "vitest";
import {
  parseHashRef,
  resEdit,
  applyEdit,
  verifyServedRange,
  buildRangeEcho,
  fmtServedRows,
  findNewEdge,
  parseText,
} from "../../src/hashline/anchor-pipeline.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";
import { initHasher } from "../../src/hashline/hash-assign.js";

describe("coverage: anchor-pipeline parseHashRef / diagRef branches", () => {
  it("rejects empty and numeric anchors", () => {
    expect(() => parseHashRef("")).toThrow(/E_BAD_REF.*Invalid anchor/);
    expect(() => parseHashRef("123abc")).toThrow(/no line numbers/);
    expect(() => parseHashRef("ab")).toThrow(/Expected a 3-char/);
    expect(() => parseHashRef("toolong!")).toThrow(/Expected a 3-char/);
  });
  it("rejects anchors with pipe", () => {
    expect(() => parseHashRef("abc│content")).toThrow(/remove everything from/);
  });
  it("rejects multiline block with pipes", () => {
    const block = "abc│line one\ndef│line two";
    expect(() => parseHashRef(block)).toThrow(/Invalid anchor — remove_from must be a single bare/);
  });
  it("parses valid 3-char alphanumeric", () => {
    // generate a valid hash via hasher
    const hashes = lineHashesPure("a\nb\nc");
    expect(parseHashRef(hashes[0]!).hash).toBe(hashes[0]!);
    // also simple
    expect(parseHashRef("aB3").hash).toBe("aB3");
  });
});

describe("coverage: anchor-pipeline resEdit warnings", () => {
  it("strips HASH│ prefix from remove_from/to and warns", () => {
    const warnings: string[] = [];
    const edit: any = { remove_from: "abc│content", remove_to: "def│content", replacement_text: "new" };
    const res = resEdit(edit, warnings);
    expect(res.hash_bounds[0].hash).toBe("abc");
    expect(res.hash_bounds[1].hash).toBe("def");
    expect(warnings.some((w) => w.includes("stripped"))).toBe(true);
  });
  it("strips diff markers +/- and warns", () => {
    const w1: string[] = [];
    resEdit({ remove_from: "+abc│x", remove_to: "abc", replacement_text: "y" } as any, w1);
    expect(w1.some((w) => w.includes("diff-preview"))).toBe(true);
    const w2: string[] = [];
    resEdit({ remove_from: "-abc│x", remove_to: "abc", replacement_text: "y" } as any, w2);
    expect(w2.some((w) => w.includes("leading \"-\""))).toBe(true);
  });
  it("extracts first hash from multiline block", () => {
    const warnings: string[] = [];
    const block = "abc│first\nother line\ndef│second";
    const edit: any = { remove_from: block, remove_to: "def", replacement_text: "new" };
    const res = resEdit(edit, warnings);
    expect(res.hash_bounds[0].hash).toBe("abc");
    expect(warnings.some((w) => w.includes("extracted first hash"))).toBe(true);
  });
  it("rejects missing fields", () => {
    // remove_from must be string
    expect(() => resEdit({ remove_from: 123 as any, remove_to: "abc", replacement_text: "x" } as any)).toThrow();
    expect(() => resEdit({ remove_from: "abc", remove_to: "abc", replacement_text: 123 as any } as any)).toThrow();
    expect(() => resEdit({ remove_from: "abc", remove_to: "abc" } as any)).toThrow();
    expect(() => resEdit({ remove_from: "abc" } as any, [] as any)).toThrow();
    expect(() => resEdit({ replacement_text: "x" } as any)).toThrow();
  });
  it("parseText handles various inputs", () => {
    expect(parseText("")).toEqual([]);
    expect(parseText("\n")).toEqual([""]);
    expect(parseText("a\nb")).toEqual(["a", "b"]);
    expect(parseText("a\r\nb")).toEqual(["a", "b"]);
    expect(parseText("a\rb")).toEqual(["a", "b"]);
    expect(() => parseText(123 as any)).toThrow();
  });
});

describe("coverage: anchor-pipeline applyEdit", () => {
  it("strips bare HASH│ prefixes from content lines and warns", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const edit: any = { hash_bounds: [{ hash: hashes[0]! }, { hash: hashes[0]! }], content_lines: [`${hashes[1]!}│b`, "new line"] };
    const result = applyEdit(content, edit, undefined, hashes);
    // should have stripped prefix from first replacement line
    expect(result.warnings?.some((w) => w.includes("HASH│"))).toBe(true);
    expect(result.content).toContain("new line");
  });

  it("strips diff +/- prefixes from content lines", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const edit: any = { hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }], content_lines: ["+new", "-old", "keep"] };
    const result = applyEdit(content, edit, undefined, hashes);
    expect(result.content).toContain("keep");
  });
  it("swaps reversed anchors", () => {
    const content = "a\nb\nc\nd";
    const hashes = lineHashesPure(content);
    // reversed: remove_from is line 3, remove_to is line 1
    const edit: any = { hash_bounds: [{ hash: hashes[2]! }, { hash: hashes[0]! }], content_lines: ["X"] };
    const result = applyEdit(content, edit, undefined, hashes);
    expect(result.warnings?.some((w) => w.includes("reversed"))).toBe(true);
    expect(result.content).toContain("X");
  });

  it("detects boundary dups trailing/leading and auto-fixes", () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = lineHashesPure(content);
    // edit replacing lines 2-3 (b,c) but include trailing dup d which equals file line after range
    const edit: any = { hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[2]! }], content_lines: ["B", "C", "d"] };
    const result = applyEdit(content, edit, undefined, hashes);
    expect(result.autoFixes?.length).toBeGreaterThan(0);
    // also test leading dup
    const edit2: any = { hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[2]! }], content_lines: ["a", "B", "C"] };
    const result2 = applyEdit(content, edit2, undefined, hashes);
    expect(result2.autoFixes?.length).toBeGreaterThan(0);
  });

  it("throws on stale anchors", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const edit: any = { hash_bounds: [{ hash: "zzz" }, { hash: "zzz" }], content_lines: ["X"] };
    expect(() => applyEdit(content, edit, undefined, hashes)).toThrow(/E_STALE_ANCHOR/);
  });

  it("throws on ambiguous anchors", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    // forge hashes with duplicate
    const dupHashes = [...hashes];
    dupHashes[2] = hashes[0]!;
    const edit: any = { hash_bounds: [{ hash: hashes[0]! }, { hash: hashes[0]! }], content_lines: ["X"] };
    expect(() => applyEdit(content, edit, undefined, dupHashes)).toThrow(/E_AMBIGUOUS_ANCHOR/);
  });

  it("detects edit hash echo and throws", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const served = [...hashes];
    // make replacement start with served hash + │
    const edit: any = { hash_bounds: [{ hash: hashes[0]! }, { hash: hashes[0]! }], content_lines: [`${hashes[0]!}│a`, "new"] };
    expect(() => applyEdit(content, edit, undefined, hashes, "file.txt", served as any)).toThrow(/E_EDIT_HASH_ECHO/);
  });

  it("noop returns noopEdit", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const edit: any = { hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }], content_lines: ["b"] };
    const result = applyEdit(content, edit, undefined, hashes);
    expect(result.content).toBe(content);
    expect(result.noopEdit).toBeDefined();
    expect(result.firstChangedLine).toBeUndefined();
  });

  it("empty file and empty replacement edge cases", () => {
    const content = "a";
    const hashes = lineHashesPure(content);
    const edit: any = { hash_bounds: [{ hash: hashes[0]! }, { hash: hashes[0]! }], content_lines: [] };
    expect(() => applyEdit(content, edit, undefined, hashes)).toThrow(/E_WOULD_EMPTY/);
  });
  it("findNewEdge works for leading/trailing new content", () => {
    expect(findNewEdge(["new", "b", "c"], ["b", "c"], false)).toBeDefined();
    expect(findNewEdge(["a", "b", "new"], ["a", "b"], true)).toBeDefined();
    expect(findNewEdge(["a", "b"], ["a", "b"], false)).toBeUndefined();
    expect(findNewEdge(["", "new"], ["a"], false)).toBeDefined();
  });

  it("warnUnicodeEsc adds warning", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const edit: any = { hash_bounds: [{ hash: hashes[0]! }, { hash: hashes[0]! }], content_lines: ["\\uDDDD test"] };
    const result = applyEdit(content, edit, undefined, hashes);
    expect(result.warnings?.some((w) => w.includes("uDDDD"))).toBe(true);
  });

  it("abort signal throws", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const edit: any = { hash_bounds: [{ hash: hashes[0]! }, { hash: hashes[0]! }], content_lines: ["X"] };
    const controller = new AbortController();
    controller.abort();
    expect(() => applyEdit(content, edit, controller.signal, hashes)).toThrow();
  });
});

describe("coverage: anchor-pipeline verifyServedRange / buildRangeEcho", () => {
  it("buildRangeEcho and fmtServedRows", () => {
    const hashes = lineHashesPure("a\nb\nc\nd");
    const rows = buildRangeEcho(1, 2, hashes);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.hash).toBe(hashes[0]!);
    const txt = fmtServedRows(rows, ["a", "b", "c", "d"]);
    expect(txt).toContain("│a");
  });

  it("verifyServedRange throws E_RANGE_UNVERIFIED when no served positions", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const served: (string | null)[] = [null, null, null];
    expect(() =>
      verifyServedRange({
        served,
        startHash: hashes[0]!,
        endHash: hashes[1]!,
        startLine: 1,
        endLine: 2,
        fileHashes: hashes,
        fileLines: ["a", "b", "c"],
      }),
    ).toThrow(/E_RANGE_UNVERIFIED/);
  });

  it("verifyServedRange throws E_RANGE_UNSERVED when served null in range", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    // served has one null inside verified span
    const served: (string | null)[] = [hashes[0]!, null, hashes[2]!];
    expect(() =>
      verifyServedRange({
        served,
        startHash: hashes[0]!,
        endHash: hashes[2]!,
        startLine: 1,
        endLine: 3,
        fileHashes: hashes,
        fileLines: ["a", "b", "c"],
      }),
    ).toThrow(/E_RANGE_UNSERVED/);
  });

  it("verifyServedRange succeeds when served matches", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    expect(() =>
      verifyServedRange({
        served,
        startHash: hashes[0]!,
        endHash: hashes[1]!,
        startLine: 1,
        endLine: 2,
        fileHashes: hashes,
        fileLines: ["a", "b", "c"],
      }),
    ).not.toThrow();
  });

  it("verifyServedRange detects E_RANGE_STALE when hashes differ", () => {
    const content = "a\nb\nc";
    const hashes = lineHashesPure(content);
    // modify hashes to simulate stale
    const staleHashes = [...hashes];
    staleHashes[0] = "zzz";
    const served: (string | null)[] = [hashes[0]!, hashes[1]!, hashes[2]!];
    expect(() =>
      verifyServedRange({
        served,
        startHash: hashes[0]!,
        endHash: hashes[1]!,
        startLine: 1,
        endLine: 2,
        fileHashes: staleHashes,
        fileLines: ["a", "b", "c"],
      }),
    ).toThrow(/E_RANGE_STALE/);
  });
});
