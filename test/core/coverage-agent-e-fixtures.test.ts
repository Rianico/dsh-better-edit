import { describe, it, expect } from "vitest";
import { withTempBytes, withTempSubdir, withTempDir, makeTempDir, getWritableTempRoot } from "../support/fixtures.js";
import { rm } from "node:fs/promises";

describe("coverage-agent-e fixtures", () => {
  it("withTempBytes", async () => {
    await withTempBytes("b.bin", Buffer.from([1,2,3]), async ({ path }) => {
      expect(path.endsWith("b.bin")).toBe(true);
    });
  });
  it("withTempSubdir", async () => {
    await withTempSubdir("sub", async ({ path }) => {
      expect(path.endsWith("sub")).toBe(true);
    });
  });
  it("withTempDir", async () => {
    await withTempDir("prefix-", async (dir) => {
      expect(dir.includes("prefix-")).toBe(true);
    });
  });
  it("makeTempDir and getWritableTempRoot", async () => {
    const dir = await makeTempDir("mk-");
    expect(dir.includes("mk-")).toBe(true);
    await rm(dir, { recursive: true, force: true });
    const root = await getWritableTempRoot();
    expect(typeof root).toBe("string");
  });
});
