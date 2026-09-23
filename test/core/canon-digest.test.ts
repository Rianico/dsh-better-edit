import { describe, expect, it } from "vitest";
import { canon } from "../../src/hashline/index.js";
import { canonDigest, xxh32 } from "../../src/hashline/hash-assign.js";

describe("canonDigest", () => {
  it("is the xxh32 of the canonical form, not the text", () => {
    expect(canonDigest("  alpha  ")).toBe(String(xxh32("alpha")));
    expect(canonDigest("alpha")).toBe(String(xxh32(canon("  alpha\t"))));
  });

  it("is equal for canon-equal variants and differs across canons", () => {
    expect(canonDigest("alpha")).toBe(canonDigest("  alpha\t"));
    expect(canonDigest("alpha")).not.toBe(canonDigest("beta"));
  });
});
