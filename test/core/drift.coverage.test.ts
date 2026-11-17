import { describe, it, expect } from "vitest";
import * as driftShim from "../../src/session-view.js";
import { computeDrift } from "../../src/session-view.js";

describe("drift shim re-export", () => {
  it("re-exports computeDrift", () => {
    expect(typeof (driftShim as any).computeDrift).toBe("function");
    const r = (driftShim as any).computeDrift({
      served: ["h00"],
      resultHashes: ["h00"],
      resultLines: ["a"],
      range: { startLine: 1, endLine: 1, startHash: "h00", endHash: "h00", delta: 0 },
      reported: new Set(),
    });
    expect(r).toBeUndefined();
  });

  it("re-exports served helpers", () => {
    expect(typeof (driftShim as any)._mergeServedRows).toBe("function");
    expect(typeof (driftShim as any).servedPositionsOf).toBe("function");
  });
});

describe("drift — file-view roundtrip", () => {
  it("computes drift with served hash vs current for file-view roundtrip", () => {
    // exercise session-view path used by file-view consumers
    const served = ["h00", "h01"];
    const resultHashes = ["h00", "hX1"];
    const resultLines = ["a", "changed"];
    const r = computeDrift({
      served,
      resultHashes,
      resultLines,
      range: { startLine: 1, endLine: 1, startHash: "h00", endHash: "h00", delta: 0 },
      reported: new Set(),
    });
    expect(r).toBeDefined();
    expect(r!.total).toBe(1);
  });
});
