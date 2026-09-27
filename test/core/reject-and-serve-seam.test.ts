import { describe, expect, it, beforeAll } from "vitest";
import { ServedRejectionError } from "../../src/hashline/served.js";
import { finalizeToolResult } from "../../src/edit-response.js";
import { applyEdit, lineHashesPure, type HEdit } from "../../src/hashline/index.js";
import { initHasher } from "../../src/hashline/hasher.js";

beforeAll(async () => {
  await initHasher();
});

describe("applyEdit — stale range beats would-empty", () => {
  it("rejects E_STALE_RANGE before E_EMPTY_RANGE when both apply", () => {
    const content = "aaa\nbbb\nccc";
    const hashes = lineHashesPure(content);
    const served = [hashes[0]!, "S1", hashes[2]!];
    let error: unknown;
    try {
      applyEdit(
        content,
        {
          hash_bounds: [{ hash: hashes[0]! }, { hash: hashes[2]! }],
          content_lines: [],
        },
        undefined,
        hashes,
        "a.ts",
        served,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServedRejectionError);
    expect((error as ServedRejectionError).code).toBe("E_STALE_RANGE");
  });
});
describe("finalizeToolResult", () => {
  it("assembles diff, warnings, and drift notice and returns served rows", () => {
    const result = finalizeToolResult({
      diff: "+a\n-b",
      warnings: ["W1"],
      driftNotice: "drift: 1 line(s) changed outside the range:",
      servedRows: [{ position: 0, hash: "abc" }],
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "+a\n-b\n\nW1",
      },
    ]);
    expect(result.servedRows).toEqual([{ position: 0, hash: "abc" }]);
  });

  it("omits served rows and blocks when absent", () => {
    const result = finalizeToolResult({ diff: "+a\n-b" });
    expect(result.content).toEqual([{ type: "text", text: "+a\n-b" }]);
    expect(result.servedRows).toBeUndefined();
  });
});

describe("applyEdit — resolved range geometry", () => {
  it("returns startLine, endLine, boundary hashes, and delta as one value", () => {
    const content = "aaa\nbbb\nccc";
    const hashes = lineHashesPure(content);
    const edit: HEdit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }],
      content_lines: ["BBB", "B2"],
    };
    const result = applyEdit(content, edit);
    expect(result.range).toEqual({
      startLine: 2,
      endLine: 2,
      startHash: hashes[1]!,
      endHash: hashes[1]!,
      delta: 1,
    });
  });

  it("reports zero delta for a noop and negative delta for a deletion", () => {
    const content = "aaa\nbbb\nccc";
    const hashes = lineHashesPure(content);
    const noop = applyEdit(content, {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }],
      content_lines: ["bbb"],
    });
    expect(noop.range.delta).toBe(0);
    const deleted = applyEdit(content, {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }],
      content_lines: [],
    });
    expect(deleted.range.delta).toBe(-1);
  });
});
