import { describe, expect, it } from "vitest";
import { type JsonSchemaNode, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
  assertEditRequest,
  editRequestFrom,
  normalizeRequest,
  normalizedEdit,
  prepareEditArguments,
} from "../../src/contract.js";
import { buildEditTool } from "../../src/tool-edit.js";
import { localIO } from "../../src/fs-bridge.js";
import { FsSandboxController } from "../../src/sandbox.js";

/**
 * Port of pi-better-edit@5dacf56 (#100 downstream: issue #100): pin the `edit` payload's wire
 * shape against third-party shape adapters, so a renamed or newly added key cannot silently arm
 * a foreign consumer of our anchors.
 *
 * The declared shape is the named-object contract from ADR-0015: root `file` / `edits` / `mode` /
 * `dry_run`, item `anchor_from` / `anchor_to` / `replace_with` (the item object is closed to
 * additional properties). Legacy tuple items, the legacy `path` / `file_path` root keys, and the
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
    expect(rootKeys(params)).toEqual([
      "allow_encoding_migration",
      "dry_run",
      "edits",
      "file",
      "mode",
    ]);

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
      "allow_encoding_migration",
      "dry_run",
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
      dry_run: false,
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

/** The canonical single-item payload every dry_run arm folds. */
const payload = {
  file: "sample.ts",
  edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
};

describe("edit payload wire shape — dry_run root field", () => {
  it("declares dry_run beside file and edits; admits boolean, null, and absent", () => {
    const params = paramsOf(false);
    const dryRun = params.properties?.dry_run;
    expect(dryRun?.oneOf?.map((branch) => branch.type)).toEqual(["boolean", "null"]);

    expect(validateJsonSchemaValue(params, { ...payload, dry_run: true })).toEqual([]);
    expect(validateJsonSchemaValue(params, { ...payload, dry_run: false })).toEqual([]);
    expect(validateJsonSchemaValue(params, { ...payload, dry_run: null })).toEqual([]);
    expect(validateJsonSchemaValue(params, payload)).toEqual([]);

    for (const bad of ["yes", 1, {}]) {
      expect(
        validateJsonSchemaValue(params, { ...payload, dry_run: bad as never }).length,
      ).toBeGreaterThan(0);
    }
  });

  it("normalizes absent and null to false and keeps explicit booleans", () => {
    expect(editRequestFrom(payload)?.dry_run).toBe(false);
    expect(editRequestFrom({ ...payload, dry_run: null })?.dry_run).toBe(false);
    expect(editRequestFrom({ ...payload, dry_run: true })?.dry_run).toBe(true);
    expect(editRequestFrom({ ...payload, dry_run: false })?.dry_run).toBe(false);

    const absent = normalizeRequest(payload);
    assertEditRequest(absent);
    expect(absent.dry_run).toBe(false);

    const nulled = normalizeRequest({ ...payload, dry_run: null });
    assertEditRequest(nulled);
    expect(nulled.dry_run).toBe(false);

    const preview = normalizeRequest({ ...payload, dry_run: true });
    assertEditRequest(preview);
    expect(preview.dry_run).toBe(true);
  });

  it("refuses a non-boolean dry_run at admission", () => {
    for (const bad of ["yes", 1, {}]) {
      const request = { ...payload, dry_run: bad };
      expect(editRequestFrom(request)).toBeUndefined();
      expect(() => assertEditRequest(normalizeRequest(request))).toThrow(/E_BAD_PAYLOAD/);
      expect(() => assertEditRequest(normalizeRequest(request))).toThrow(
        /"dry_run" must be a boolean/,
      );
    }
  });

  it("keeps root closure: an extra key is still refused", () => {
    const closed = { ...payload, dry_run: true, extra: 1 };
    expect(editRequestFrom(closed)).toBeUndefined();
    expect(() => prepareEditArguments(closed)).toThrow(/E_BAD_PAYLOAD/);
  });

  it("prepareEditArguments returns the folded dry_run", () => {
    expect(prepareEditArguments({ ...payload, dry_run: true }).dry_run).toBe(true);
    expect(prepareEditArguments(payload).dry_run).toBe(false);
  });

  it("refuses a normalized record whose dry_run was forced non-boolean", () => {
    // The pre-marker predicate in assertEditRequest is the one dry_run type gate:
    // a non-boolean never normalizes, so it refuses the raw record by name.
    const forced: Record<string, unknown> = { ...payload, mode: "general", dry_run: "yes" };
    Object.defineProperty(forced, normalizedEdit, { value: true, enumerable: false });
    expect(() => assertEditRequest(forced)).toThrow(/"dry_run" must be a boolean/);
  });
});

describe("edit payload wire shape — allow_encoding_migration root field", () => {
  it("declares the consent as a plain string enum beside file and edits", () => {
    const params = paramsOf(false);
    const consent = params.properties?.allow_encoding_migration;
    // No null branch: `null` is not a spelling of absent here, so the host refuses it as an
    // out-of-enum value before the contract ever sees it (ADR-0052 §1).
    expect(consent?.type).toBe("string");
    expect(consent?.enum).toEqual(["refuse", "utf8", "utf8bom"]);
    expect(consent?.oneOf).toBeUndefined();

    expect(
      validateJsonSchemaValue(params, { ...payload, allow_encoding_migration: "utf8bom" }),
    ).toEqual([]);
    expect(validateJsonSchemaValue(params, payload)).toEqual([]);

    for (const bad of [null, "utf8BOM", "migrate", true, 1]) {
      expect(
        validateJsonSchemaValue(params, {
          ...payload,
          allow_encoding_migration: bad as never,
        }).length,
      ).toBeGreaterThan(0);
    }
  });

  it("carries the consent only when the caller named one", () => {
    expect(editRequestFrom({ ...payload, allow_encoding_migration: "utf8" })).toEqual({
      ...payload,
      mode: "general",
      dry_run: false,
      allow_encoding_migration: "utf8",
    });
    // Absent stays absent: the config ladder decides, so the fold materializes nothing (a folded
    // "refuse" would outrank the config).
    expect(editRequestFrom(payload)).not.toHaveProperty("allow_encoding_migration");
    expect(prepareEditArguments({ ...payload, allow_encoding_migration: "refuse" })).toMatchObject({
      allow_encoding_migration: "refuse",
    });

    // `null` is a present value outside the enum, never "absent": the fold refuses it and the
    // admission gate names the three accepted values.
    expect(editRequestFrom({ ...payload, allow_encoding_migration: null })).toBeUndefined();
    expect(() =>
      assertEditRequest(normalizeRequest({ ...payload, allow_encoding_migration: null })),
    ).toThrow(/"refuse", "utf8", or "utf8bom"/);

    const normalized = normalizeRequest({ ...payload, allow_encoding_migration: "utf8bom" });
    assertEditRequest(normalized);
    expect(normalized.allow_encoding_migration).toBe("utf8bom");
  });

  it("refuses an unknown value at admission with the three values named", () => {
    for (const bad of [null, "utf8BOM", "migrate", true, 1]) {
      const request = { ...payload, allow_encoding_migration: bad };
      expect(editRequestFrom(request)).toBeUndefined();
      let message = "";
      try {
        assertEditRequest(normalizeRequest(request));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("E_BAD_PAYLOAD");
      for (const consent of ["refuse", "utf8", "utf8bom"]) {
        expect(message).toContain(`"${consent}"`);
      }
    }
  });
});
