import { describe, expect, it } from "vitest";
import { type JsonSchemaNode, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { editRequestFrom, prepareEditArguments } from "../../src/contract.js";
import { buildEditTool } from "../../src/tool-edit.js";
import { localIO } from "../../src/fs-bridge.js";
import { FsSandboxController } from "../../src/sandbox.js";

/**
 * Port of pi-better-edit@5dacf56 (#100 downstream: issue #100): pin the `edit` payload's wire
 * shape against third-party shape adapters, so a renamed or newly added key cannot silently arm
 * a foreign consumer of our anchors.
 *
 * The declared shape is the named-object contract from ADR-0015: root `file` / `edits` / `mode`,
 * item `anchor_from` / `anchor_to` / `replace_with` (the item object is closed to additional
 * properties). Legacy tuple items, the legacy `path` / `file_path` root keys, and the legacy
 * `remove_from` / `remove_to` / `replacement_text` item keys survive ONLY as pre-validation fold
 * inputs — they are never declared wire keys, so no adapter can see a shape it recognizes.
 *
 * WHY: a third-party adapter that recognizes one of the alias key sets below (pi-lens's
 * `mutating-tool.js` accepts `set_line` / `replace_lines`, `operations` / `ops`, and
 * `remove_from` + `remove_to` + `replacement_lines`; its path resolver takes `path` / `filePath` /
 * `file_path`, never `file`) would begin judging line identity with a divergent scheme and report
 * false stale / out-of-range verdicts on edits our own verification accepts. Change this list
 * deliberately, never casually: the coupling is the consequence.
 */

function paramsOf(confining: boolean): JsonSchemaNode {
  // An unconfined backend advertises no escalation fields; a confining one adds
  // sandbox_permissions + justification (the closed retry vocabulary).
  const sandbox = confining
    ? new FsSandboxController({
        fs: { sandboxMode: "workspace" },
        get: (key: string) =>
          key === "sandboxPolicy" ? { root: "/tmp/ws", mode: "workspace" } : undefined,
      } as never)
    : new FsSandboxController({ fs: {}, get: () => undefined } as never);
  // SAFETY: defineTool hands back the registration record, whose `parameters` is the
  // value-schema spec the host compiles; the enforced JSON Schema subset is exactly
  // JsonSchemaNode's shape, which TypeScript cannot see through the untyped registration.
  return buildEditTool(localIO(), sandbox).parameters as unknown as JsonSchemaNode;
}

function rootKeys(params: JsonSchemaNode): string[] {
  return Object.keys(params.properties ?? {}).sort();
}

/** The named-object branch of the `edits` item union. */
function namedItemBranch(params: JsonSchemaNode): JsonSchemaNode {
  const branches = params.properties?.edits?.items?.oneOf ?? [];
  const named = branches.find((branch) => branch.type === "object");
  if (!named) throw new Error("the declared edits item has no named-object branch");
  return named;
}

/** The legacy tuple branch of the `edits` item union. */
function tupleItemBranch(params: JsonSchemaNode): JsonSchemaNode {
  const branches = params.properties?.edits?.items?.oneOf ?? [];
  const tuple = branches.find((branch) => branch.type === "array");
  if (!tuple) throw new Error("the declared edits item has no tuple branch");
  return tuple;
}

describe("edit payload wire shape", () => {
  it("declares exactly the named-object keys and closes the item object", () => {
    const params = paramsOf(false);
    expect(rootKeys(params)).toEqual(["edits", "file", "mode"]);

    const named = namedItemBranch(params);
    expect(Object.keys(named.properties ?? {}).sort()).toEqual([
      "anchor_from",
      "anchor_to",
      "replace_with",
    ]);
    expect([...(named.required ?? [])].sort()).toEqual([
      "anchor_from",
      "anchor_to",
      "replace_with",
    ]);
    // The item object is closed; the root is not (dsh's value-schema root carries no
    // additionalProperties), so root closure lives in the fold — pinned below.
    expect(named.additionalProperties).toBe(false);
    // The legacy tuple branch stays an unconstrained string array: arity is the fold's gate.
    const tuple = tupleItemBranch(params);
    expect(tuple.items?.type).toBe("string");
    expect(tuple.additionalProperties).toBeUndefined();

    // Escalation fields are the ONLY extra root keys a confining composition may add.
    expect(rootKeys(paramsOf(true))).toEqual([
      "edits",
      "file",
      "justification",
      "mode",
      "sandbox_permissions",
    ]);
  });

  it("admits the canonical payload and the legacy tuple wire shape", () => {
    const params = paramsOf(false);
    expect(
      validateJsonSchemaValue(params, {
        file: "sample.ts",
        edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
      }),
    ).toEqual([]);
    expect(
      validateJsonSchemaValue(params, { file: "sample.ts", edits: [["aB3", "cD4", "new"]] }),
    ).toEqual([]);
    // Schema admission is shape-only: tuple arity is the fold's gate, not the wire schema's.
    expect(validateJsonSchemaValue(params, { file: "sample.ts", edits: [["aB3", "cD4"]] })).toEqual(
      [],
    );
    expect(editRequestFrom({ file: "sample.ts", edits: [["aB3", "cD4"]] })).toBeUndefined();
  });

  it("never declares a third-party adapter alias", () => {
    const params = paramsOf(false);
    const named = namedItemBranch(params);
    const declaredRootKeys = new Set(rootKeys(params));
    const declaredItemKeys = new Set(Object.keys(named.properties ?? {}));

    const aliases = [
      "path",
      "filePath",
      "file_path",
      "set_line",
      "replace_lines",
      "operations",
      "ops",
      "remove_from",
      "remove_to",
      "replacement_lines",
      "replacement_text",
    ];
    for (const alias of aliases) {
      expect(declaredRootKeys).not.toContain(alias);
      expect(declaredItemKeys).not.toContain(alias);
    }
  });

  it("folds legacy spellings pre-validation onto the declared shape", () => {
    const params = paramsOf(false);

    const folded = editRequestFrom({
      path: "sample.ts",
      edits: [
        ["aB3", "cD4", "new"],
        { remove_from: "qWe", remove_to: "rTy", replacement_text: "" },
      ],
    });
    expect(folded).toEqual({
      file: "sample.ts",
      edits: [
        { anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" },
        { anchor_from: "qWe", anchor_to: "rTy", replace_with: "" },
      ],
      mode: "general",
    });
    // Fold output IS the declared wire shape: adapters may hand us legacy input, but the
    // canonical form always validates against the declared schema.
    expect(validateJsonSchemaValue(params, folded)).toEqual([]);

    // Root closure lives in the fold: an adapter alias at the root is rejected, not ignored.
    expect(
      editRequestFrom({
        file: "sample.ts",
        operations: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
        edits: [["aB3", "cD4", "new"]],
      }),
    ).toBeUndefined();
    expect(() =>
      prepareEditArguments({
        file: "sample.ts",
        operations: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
        edits: [["aB3", "cD4", "new"]],
      }),
    ).toThrow(/E_BAD_PAYLOAD/);

    // Mixed legacy/named item keys are rejected rather than half-folded.
    expect(
      editRequestFrom({
        file: "sample.ts",
        edits: [{ anchor_from: "aB3", anchor_to: "cD4", replacement_text: "new" }],
      }),
    ).toBeUndefined();
  });
});
