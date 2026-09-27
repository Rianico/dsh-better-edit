import { describe, expect, it } from "vitest";
import {
  itemFromTuple,
  editRequestFrom,
  normalizeRequest,
  prepareEditArguments,
  assertEditRequest,
  assertReadRequest,
  assertUndoRequest,
  isNormalizedEdit,
  normalizedEdit,
  EDIT_PAYLOAD_HINT,
} from "../../src/contract.js";

describe("coverage: contract.ts", () => {
  it("itemFromTuple valid and invalid", () => {
    expect(itemFromTuple(["a", "b", "c"])).toEqual({
      anchor_from: "a",
      anchor_to: "b",
      replace_with: "c",
    });
    expect(itemFromTuple(["a", "b"])).toBeUndefined();
    expect(itemFromTuple(["a", "b", "c", "d"])).toBeUndefined();
    expect(itemFromTuple(["a", "b", 123 as any])).toBeUndefined();
    expect(itemFromTuple("not-array" as any)).toBeUndefined();
    expect(itemFromTuple(null as any)).toBeUndefined();
  });

  it("editRequestFrom validates path and edits", () => {
    expect(editRequestFrom({ path: "file.txt", edits: [["a", "b", "c"]] })).toBeDefined();
    expect(editRequestFrom({ path: null, edits: [["a", "b", "c"]] })).toBeDefined();
    // empty path string -> undefined
    expect(editRequestFrom({ path: "", edits: [["a", "b", "c"]] })).toBeUndefined();
    expect(editRequestFrom({ path: 123 as any, edits: [["a", "b", "c"]] })).toBeUndefined();
    expect(editRequestFrom({ path: "a", edits: [] })).toBeUndefined();
    expect(editRequestFrom({ path: "a", edits: "not-array" as any })).toBeUndefined();
    expect(editRequestFrom({ path: "a", edits: [["a", "b"]] as any })).toBeUndefined();
    expect(editRequestFrom({ notPath: "a" } as any)).toBeUndefined();
    expect(editRequestFrom(null as any)).toBeUndefined();
    expect(editRequestFrom("string" as any)).toBeUndefined();
    // file_path alias handling (just ensures not throwing, returns undefined due to invalid shape after alias? but should handle)
    expect(
      editRequestFrom({ path: "a", edits: [["a", "b", "c"]], file_path: "other" } as any),
    ).toBeDefined();
  });

  it("normalizeRequest handles non-record, tuple normalization, and preserves sandbox fields", () => {
    expect(normalizeRequest(null)).toBeNull();
    expect(normalizeRequest("string")).toBe("string");
    const rec = {
      path: "a.txt",
      edits: [["h1", "h2", "content"]] as any,
      sandbox_permissions: "rw",
      justification: "test",
    };
    const norm = normalizeRequest(rec) as any;
    expect(norm.file).toBe("a.txt");
    expect(norm.edits[0].anchor_from).toBe("h1");
    expect(norm[normalizedEdit]).toBe(true);
    // F9: sandbox fields survive normalization unchanged and the
    // normalized record is accepted by the contract gate (refutable:
    // deleting the preservation loop in normalizeRequest goes red here).
    expect(norm.sandbox_permissions).toBe("rw");
    expect(norm.justification).toBe("test");
    expect(() => assertEditRequest(norm)).not.toThrow();
    // file_path alias
    const withAlias = {
      file_path: "b.txt",
      path: undefined as any,
      edits: [["h1", "h2", "x"]],
    } as any;
    // normalizeFilePath will map file_path to path - test via normalizeRequest
    const normAlias = normalizeRequest({
      file_path: "b.txt",
      path: "b.txt",
      edits: [["h1", "h2", "x"]],
    } as any) as any;
    expect(normAlias.file).toBe("b.txt");
    // invalid shape returns record unchanged
    const invalid = normalizeRequest({ path: "a", edits: [] } as any) as any;
    expect(invalid.path).toBe("a");
  });

  it("declared schema admits mode and sandbox fields; contract rejects unknown mode (F1/F9)", async () => {
    const { buildEditTool } = await import("../../src/tool-edit.js");
    const { localIO } = await import("../../src/fs-bridge.js");
    const { FsSandboxController } = await import("../../src/sandbox.js");
    const { validateJsonSchemaValue } = await import("@deepseek-ai/dsh-tools");
    const sandbox = new FsSandboxController({
      fs: { sandboxMode: "readOnly" },
      get: (key: string) => (key === "sandboxPolicy" ? { allowExec: true } : undefined),
    } as any);
    expect(sandbox.escalationModes.length).toBeGreaterThan(0);
    const tool = buildEditTool(localIO() as any, sandbox);
    const params = tool.parameters as any;
    const item = { anchor_from: "a", anchor_to: "a", replace_with: "b" };
    // F1: the declared mode enum admits literal on object and tuple payloads
    // (refutable: removing mode from parameters fails admission here).
    expect(
      validateJsonSchemaValue(params, { file: "f.ts", edits: [item], mode: "literal" }),
    ).toEqual([]);
    expect(
      validateJsonSchemaValue(params, { file: "f.ts", edits: [["a", "a", "b"]], mode: "literal" }),
    ).toEqual([]);
    // F9: sandbox fields pass admission under an escalating backend.
    expect(
      validateJsonSchemaValue(params, {
        file: "f.ts",
        edits: [["a", "a", "b"]],
        sandbox_permissions: sandbox.escalationModes[0],
        justification: "need wider access for this exact file operation",
      }),
    ).toEqual([]);
    // Discoverability: the schema must DECLARE the enum — the open root
    // admits undeclared fields, so this structural assertion is the
    // refutable half (removing `mode` from parameters fails here).
    expect((tool.parameters as any).properties?.mode?.enum).toEqual(["general", "literal"]);
    expect(() =>
      assertEditRequest({ file: "f.ts", edits: [item], mode: "verbatim" } as any),
    ).toThrow(/E_BAD_PAYLOAD/);
  });
  it("normalizeRequest handles edits already normalized (object form via editRequestFrom)", () => {
    const rec = { path: null, edits: [["a", "b", "c"]] } as any;
    const result = normalizeRequest(rec) as any;
    expect(isNormalizedEdit(result)).toBe(true);
  });

  it("isNormalizedEdit checks symbol", () => {
    expect(isNormalizedEdit({ [normalizedEdit]: true } as any)).toBe(true);
    expect(isNormalizedEdit({})).toBe(false);
    expect(isNormalizedEdit(null)).toBe(false);
    expect(isNormalizedEdit({ [normalizedEdit]: false } as any)).toBe(false);
  });

  it("prepareEditArguments throws with hint on bad shape", () => {
    expect(() => prepareEditArguments({ path: "a", edits: [["a", "b", "c"]] })).not.toThrow();
    expect(() => prepareEditArguments(null)).toThrow(/E_BAD_PAYLOAD/);
    expect(() => prepareEditArguments({ path: "", edits: [] } as any)).toThrow(/E_BAD_PAYLOAD/);
    expect(() => prepareEditArguments("bare string" as any)).toThrow(/Received a bare string/);
    expect(() => prepareEditArguments(undefined as any)).toThrow(/Received no arguments/);
    expect(() => prepareEditArguments(null as any)).toThrow(/Received null/);
    const longInput = { path: "a", edits: "bad" as any, extra: "x".repeat(200) };
    expect(() => prepareEditArguments(longInput)).toThrow(/E_BAD_PAYLOAD/);
  });

  it("assertEditRequest validates all fields", () => {
    const good = normalizeRequest({ path: "a.txt", edits: [["h1", "h2", "content"]] } as any);
    expect(() => assertEditRequest(good)).not.toThrow();

    // not normalized
    expect(() =>
      assertEditRequest({
        path: "a",
        edits: [{ anchor_from: "a", anchor_to: "b", replace_with: "c" }],
      } as any),
    ).toThrow(/E_BAD_PAYLOAD/);

    // unknown fields
    const withExtra = { ...(good as any), extraField: "bad" };
    // need to add symbol again because spread loses symbol
    Object.defineProperty(withExtra, normalizedEdit, { value: true, enumerable: false });
    expect(() => assertEditRequest(withExtra)).toThrow();

    // empty path
    const emptyPath: any = {
      file: "",
      edits: [{ anchor_from: "a", anchor_to: "b", replace_with: "c" }],
    };
    Object.defineProperty(emptyPath, normalizedEdit, { value: true, enumerable: false });
    expect(() => assertEditRequest(emptyPath)).toThrow(/file must be a non-empty string/);

    // empty edits
    const emptyEdits: any = { file: "a", edits: [] };
    Object.defineProperty(emptyEdits, normalizedEdit, { value: true, enumerable: false });
    expect(() => assertEditRequest(emptyEdits)).toThrow(/non-empty/);

    // too many edits
    const many: any = {
      file: "a",
      edits: Array.from({ length: 33 }, () => ({
        anchor_from: "a",
        anchor_to: "b",
        replace_with: "c",
      })),
    };
    Object.defineProperty(many, normalizedEdit, { value: true, enumerable: false });
    expect(() => assertEditRequest(many)).toThrow(/at most/);

    // bad edit item type
    const badItem: any = {
      file: "a",
      edits: [{ anchor_from: 123 as any, anchor_to: "b", replace_with: "c" }],
    };
    Object.defineProperty(badItem, normalizedEdit, { value: true, enumerable: false });
    expect(() => assertEditRequest(badItem)).toThrow(/edits\[0\]/);
  });

  it("assertReadRequest validates", () => {
    expect(() => assertReadRequest({ path: "a.txt" })).not.toThrow();
    expect(() => assertReadRequest({ path: "a.txt", offset: 1, limit: 10 } as any)).not.toThrow();
    expect(() => assertReadRequest(null as any)).toThrow(/Read request must be an object/);
    expect(() => assertReadRequest({ path: "" } as any)).toThrow(/non-empty/);
    expect(() => assertReadRequest({ path: 123 as any } as any)).toThrow();
    expect(() => assertReadRequest({ path: "a.txt", unknown: "field" } as any)).toThrow();
  });

  it("assertUndoRequest validates and normalizes file_path", () => {
    expect(() => assertUndoRequest({ path: "a.txt" })).not.toThrow();
    expect(() => assertUndoRequest({ file_path: "a.txt" } as any)).not.toThrow();
    expect(() => assertUndoRequest(null as any)).toThrow();
    expect(() => assertUndoRequest({ path: "" } as any)).toThrow();
    expect(() => assertUndoRequest({} as any)).toThrow();
  });
});

describe("object-form edits entries (#64)", () => {
  it("accepts object entries", () => {
    const req = editRequestFrom({
      path: "file.txt",
      edits: [{ anchor_from: "a", anchor_to: "b", replace_with: "c" }],
    });
    expect(req?.edits).toEqual([{ anchor_from: "a", anchor_to: "b", replace_with: "c" }]);
  });

  it("accepts mixed tuple/object batches", () => {
    const req = editRequestFrom({
      path: "file.txt",
      edits: [["a", "a", "x"], { anchor_from: "b", anchor_to: "b", replace_with: "y" }],
    });
    expect(req?.edits).toHaveLength(2);
    expect(req?.edits[1]).toEqual({ anchor_from: "b", anchor_to: "b", replace_with: "y" });
  });

  it("still rejects invalid objects (missing/unknown fields)", () => {
    expect(editRequestFrom({ path: "file.txt", edits: [{ anchor_from: "a" }] })).toBeUndefined();
    expect(
      editRequestFrom({
        path: "file.txt",
        edits: [{ anchor_from: "a", anchor_to: "b", replace_with: "c", path: "z" }],
      }),
    ).toBeUndefined();
    expect(
      editRequestFrom({
        path: "file.txt",
        edits: [{ anchor_from: 1 as unknown as string, anchor_to: "b", replace_with: "c" }],
      }),
    ).toBeUndefined();
    expect(
      editRequestFrom({
        path: "file.txt",
        edits: ["not-an-entry" as unknown as [string, string, string]],
      }),
    ).toBeUndefined();
  });
});
