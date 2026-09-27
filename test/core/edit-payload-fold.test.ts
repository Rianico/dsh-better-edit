import { describe, expect, it } from "vitest";

import {
  assertEditRequest,
  editRequestFrom,
  normalizeRequest,
  prepareEditArguments,
} from "../../src/contract.js";
import { buildEditTool } from "../../src/tool-edit.js";
import { localIO } from "../../src/fs-bridge.js";
import { FsSandboxController } from "../../src/sandbox.js";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

/**
 * Named-object payload fold battery (A4, mirrors upstream's fold battery).
 * The taught shape is { file, edits: [{ anchor_from, anchor_to, replace_with }] };
 * legacy tuples, legacy root keys and legacy item keys fold pre-validation.
 */
describe("edit payload fold (named-object + legacy)", () => {
  it("tuple items fold to named objects", () => {
    const req = editRequestFrom({ file: "a.txt", edits: [["h1", "h2", "x"]] });
    expect(req).toEqual({
      file: "a.txt",
      edits: [{ anchor_from: "h1", anchor_to: "h2", replace_with: "x" }],
      mode: "general",
    });
  });

  it("path folds to file, and file is preferred over path", () => {
    expect(editRequestFrom({ path: "a.txt", edits: [["h1", "h2", "x"]] })?.file).toBe("a.txt");
    expect(
      editRequestFrom({ file: "f.txt", path: "a.txt", edits: [["h1", "h2", "x"]] })?.file,
    ).toBe("f.txt");
    expect(editRequestFrom({ file_path: "g.txt", edits: [["h1", "h2", "x"]] })?.file).toBe("g.txt");
  });

  it("legacy item keys fold to the named triple", () => {
    const req = editRequestFrom({
      file: "a.txt",
      edits: [{ remove_from: "h1", remove_to: "h2", replacement_text: "x" }],
    });
    expect(req?.edits).toEqual([{ anchor_from: "h1", anchor_to: "h2", replace_with: "x" }]);
  });

  it("mixed old/new keys are rejected", () => {
    expect(
      editRequestFrom({
        file: "a.txt",
        edits: [{ anchor_from: "h1", anchor_to: "h2", replacement_text: "x" }],
      }),
    ).toBeUndefined();
    expect(() =>
      prepareEditArguments({
        file: "a.txt",
        edits: [{ anchor_from: "h1", anchor_to: "h2", replacement_text: "x" }],
      }),
    ).toThrow(/E_BAD_PAYLOAD/);
  });

  it("extra item keys are rejected", () => {
    expect(
      editRequestFrom({
        file: "a.txt",
        edits: [{ anchor_from: "h1", anchor_to: "h2", replace_with: "x", extra: 1 }],
      }),
    ).toBeUndefined();
  });

  it("2- and 4-position tuples are rejected", () => {
    expect(editRequestFrom({ file: "a.txt", edits: [["h1", "h2"]] as any })).toBeUndefined();
    expect(
      editRequestFrom({ file: "a.txt", edits: [["h1", "h2", "x", "y"]] as any }),
    ).toBeUndefined();
    expect(() => prepareEditArguments({ file: "a.txt", edits: [["h1", "h2"]] as any })).toThrow(
      /E_BAD_PAYLOAD/,
    );
  });

  it("mode folding and validation are unchanged", () => {
    expect(
      editRequestFrom({ file: "a.txt", edits: [["h1", "h2", "x"]], mode: "literal" })?.mode,
    ).toBe("literal");
    expect(editRequestFrom({ file: "a.txt", edits: [["h1", "h2", "x"]] })?.mode).toBe("general");
    expect(
      editRequestFrom({ file: "a.txt", edits: [["h1", "h2", "x"]], mode: "verbatim" }),
    ).toBeUndefined();
  });

  it("prepareEditArguments returns schema-ready folded objects", () => {
    expect(
      prepareEditArguments({
        path: "a.txt",
        edits: [["h1", "h2", "x"], { remove_from: "h3", remove_to: "h4", replacement_text: "y" }],
      }),
    ).toEqual({
      file: "a.txt",
      edits: [
        { anchor_from: "h1", anchor_to: "h2", replace_with: "x" },
        { anchor_from: "h3", anchor_to: "h4", replace_with: "y" },
      ],
      mode: "general",
    });
  });

  it("assertEditRequest names the new shape", () => {
    const good = normalizeRequest({
      file: "a.txt",
      edits: [{ anchor_from: "h1", anchor_to: "h2", replace_with: "x" }],
    });
    expect(() => assertEditRequest(good)).not.toThrow();
    expect(() => assertEditRequest({ file: "a.txt", edits: [["h1", "h2"]] as any })).toThrow(
      /E_BAD_PAYLOAD/,
    );
  });

  it("declared edits items admit named objects and legacy tuples (A3)", async () => {
    const tool = buildEditTool(
      localIO() as any,
      new FsSandboxController({ fs: {}, get: () => undefined } as any),
    );
    const params = tool.parameters as any;
    const named = {
      file: "f.ts",
      edits: [{ anchor_from: "a", anchor_to: "a", replace_with: "b" }],
    };
    const tuple = { file: "f.ts", edits: [["a", "a", "b"]] };
    expect(validateJsonSchemaValue(params, named)).toEqual([]);
    expect(validateJsonSchemaValue(params, tuple)).toEqual([]);
    // Structurally strict: the object branch forbids undeclared keys.
    expect(params.properties.edits.items.oneOf[0].additionalProperties).toBe(false);
    // N1: the null file branch stays admissible but undescribed — ADR-0015
    // keeps the legacy null path undocumented. Re-adding a description here
    // must turn this red.
    expect(params.properties.file.oneOf[1]).toEqual({ type: "null" });
    // Mixed-key items die at admission (strict object branch forbids them)
    // and in the fold with E_BAD_PAYLOAD for direct contract callers.
    expect(
      validateJsonSchemaValue(params, {
        file: "f.ts",
        edits: [{ anchor_from: "a", anchor_to: "a", replacement_text: "b" }],
      }).length,
    ).toBeGreaterThan(0);
    expect(() =>
      prepareEditArguments({
        file: "f.ts",
        edits: [{ anchor_from: "a", anchor_to: "a", replacement_text: "b" }],
      }),
    ).toThrow(/E_BAD_PAYLOAD/);
  });
});
