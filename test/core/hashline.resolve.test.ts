import { describe, expect, it } from "vitest";
import { resEdit, type Anchor, type HTEdit } from "../../src/hashline/index.js";

describe("resEdit", () => {
  it("resolves replace with anchor_from/anchor_to", () => {
    const edit: HTEdit = { anchor_from: "ZZP", anchor_to: "PPW", replace_with: "a\nb" };
    const resolved = resEdit(edit);
    expect(resolved).toHaveProperty("hash_bounds");
    expect(resolved).toHaveProperty("content_lines");
  });

  it("resolves a 1-line edit (same anchor)", () => {
    const edit: HTEdit = { anchor_from: "MQX", anchor_to: "MQX", replace_with: "new" };
    const resolved = resEdit(edit);
    const r = resolved as {
      hash_bounds: [Anchor, Anchor];
      content_lines: string[];
    };
    expect(r.hash_bounds[0].hash).toBe("MQX");
    expect(r.hash_bounds[1].hash).toBe("MQX");
  });

  it("throws on replace with no anchor_from/anchor_to (E_BAD_PAYLOAD)", () => {
    const edit = { replace_with: "new" } as any;
    expect(() => resEdit(edit)).toThrow(/\[E_BAD_PAYLOAD\]/);
  });

  it("throws on malformed anchor_from/anchor_to", () => {
    const edit: HTEdit = {
      anchor_from: "not-valid",
      anchor_to: "not-valid",
      replace_with: "x",
    };
    expect(() => resEdit(edit)).toThrow(/Invalid anchor/);
  });

  it("rejects array replace_with input", () => {
    const edit = {
      anchor_from: "ZZP",
      anchor_to: "ZZP",
      replace_with: ["hello", "world"],
    } as unknown as HTEdit;
    expect(() => resEdit(edit)).toThrow(/must be a string with \\n line separators, not an array/i);
  });

  it("splits string replace_with on line separators", () => {
    const edit = {
      anchor_from: "ZZP",
      anchor_to: "ZZP",
      replace_with: "line1\nline2\n",
    } as unknown as HTEdit;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["line1", "line2", ""]);
  });

  it("normalizes CRLF in replace_with", () => {
    const edit = {
      anchor_from: "ZZP",
      anchor_to: "ZZP",
      replace_with: "a\r\nb",
    } as unknown as HTEdit;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["a", "b"]);
  });

  it("rejects null replace_with input", () => {
    const edit = {
      anchor_from: "ZZP",
      anchor_to: "ZZP",
      replace_with: null,
    } as unknown as HTEdit;
    expect(() => resEdit(edit)).toThrow(/must be a string with \\n line separators, not an array/i);
  });

  it("rejects unknown fields", () => {
    const edit = {
      anchor_from: "ZZP",
      anchor_to: "ZZP",
      replace_with: "x",
      extra: true,
    } as any;
    expect(() => resEdit(edit)).toThrow(/unknown or unsupported fields/i);
  });

  it("rejects missing replace_with", () => {
    const edit = { anchor_from: "ZZP", anchor_to: "ZZP" } as any;
    expect(() => resEdit(edit)).toThrow(/requires a "replace_with" field/i);
  });

  it("rejects a HASH│content row pasted into anchor_from/anchor_to with E_MALFORMED_ANCHOR", () => {
    const edit: HTEdit = {
      anchor_from: "MQX│const x = 1;",
      anchor_to: "MQX│const x = 1;",
      replace_with: "new",
    };
    const warnings: string[] = [];
    expect(() => resEdit(edit, warnings)).toThrow(/\[E_MALFORMED_ANCHOR\]/);
    expect(() => resEdit(edit, warnings)).toThrow('stripped "HASH│" prefix');
    expect(() => resEdit(edit, warnings)).toThrow("from anchor_from/anchor_to");
    expect(warnings).toEqual([]);
  });

  it("rejects diff-preview rows pasted into anchor_from/anchor_to with E_MALFORMED_ANCHOR", () => {
    const edit: HTEdit = {
      anchor_from: "+MQX│const x = 1;",
      anchor_to: "-MQX│const x = 1;",
      replace_with: "new",
    };
    const warnings: string[] = [];
    expect(() => resEdit(edit, warnings)).toThrow(/\[E_MALFORMED_ANCHOR\]/);
    expect(() => resEdit(edit, warnings)).toThrow("stripped diff-preview marker");
    const edit2: HTEdit = {
      anchor_from: "-MQX│const x = 1;",
      anchor_to: "MQX",
      replace_with: "new",
    };
    expect(() => resEdit(edit2, warnings)).toThrow('leading "-" marker');
    expect(warnings).toEqual([]);
  });

  it("leaves bare anchors untouched and emits no warning", () => {
    const edit: HTEdit = { anchor_from: "MQX", anchor_to: "MQX", replace_with: "new" };
    const warnings: string[] = [];
    const resolved = resEdit(edit, warnings);
    expect(resolved.hash_bounds[0].hash).toBe("MQX");
    expect(warnings).toHaveLength(0);
  });

  it("still rejects rows without a leading hash", () => {
    const edit: HTEdit = {
      anchor_from: "│const x = 1;",
      anchor_to: "MQX",
      replace_with: "new",
    };
    expect(() => resEdit(edit)).toThrow(/\[E_MALFORMED_ANCHOR\]/);
  });
});
