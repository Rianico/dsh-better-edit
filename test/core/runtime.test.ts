import { describe, expect, it } from "vitest";
import { abortIf } from "../../src/utils.js";

describe("abortIf", () => {
  it("does nothing when signal is undefined", () => {
    expect(() => abortIf(undefined)).not.toThrow();
  });

  it("does nothing when signal is not aborted", () => {
    const controller = new AbortController();
    expect(() => abortIf(controller.signal)).not.toThrow();
  });

  it("throws when signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => abortIf(controller.signal)).toThrow(
      "Operation aborted",
    );
  });
});
