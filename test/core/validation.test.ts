import { describe, expect, it } from "vitest";
import { errCode } from "../../src/utils.js";

describe("errCode", () => {
  it("returns code from NodeJS.ErrnoException", () => {
    const error = new Error("test") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    expect(errCode(error)).toBe("ENOENT");
  });

  it("returns undefined for non-Error values", () => {
    expect(errCode("string")).toBeUndefined();
    expect(errCode(null)).toBeUndefined();
    expect(errCode(undefined)).toBeUndefined();
    expect(errCode(42)).toBeUndefined();
  });

  it("returns undefined for Error without code", () => {
    expect(errCode(new Error("test"))).toBeUndefined();
  });
});
