import { describe, it, expect } from "vitest";
import { setupIntegrationTest, withTempFile } from "../support/fixtures.js";

describe("coverage-last-90-2", () => {
  it("covers fixtures makeTestSandbox", async () => {
    await withTempFile("a.txt", "hello", async ({ cwd }) => {
      const harness: any = setupIntegrationTest(cwd);
      expect(harness).toBeDefined();
      expect(harness.io).toBeDefined();
      // This should hit makeTestSandbox
      const { FsSandboxController } = await import("../../src/sandbox.js");
      const ctrl = new (FsSandboxController as any)({ fs: { sandboxMode: undefined }, get: () => undefined } as any);
      expect(ctrl).toBeDefined();
    });
  });

  it("covers utils", async () => {
    const { cntDiff, errCode, splitLines } = await import("../../src/utils.js");
    expect(cntDiff("", "+")).toBe(0);
    expect(cntDiff("a\n", "+")).toBe(0);
    expect(errCode(new Error("x"))).toBeUndefined();
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("covers encoding", async () => {
    const m: any = await import("../../src/encoding.js");
    expect(m.isValidUtf8(new Uint8Array([]))).toBe(true);
    expect(m.hasReplacementChar("a")).toBe(false);
    expect(m.decodeBytes(Buffer.from([0x61]), "utf8")).toBe("a");
  });
});
