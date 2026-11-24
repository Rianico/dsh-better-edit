import { describe, expect, it } from "vitest";
import { type JsonSchemaNode, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

import { editToolSchema } from "../../src/contract.js";

/**
 * Pin the declared `edit` literal (`editToolSchema`, the documented shape) for the `dry_run`
 * member it now shares with the live `buildEditTool(...).parameters` value schema: the literal
 * declares the contract keys, while the live parameters additionally declare `mode` and, in a
 * confining composition, the escalation pair. `dry_run` is a boolean-or-null member added for the
 * read-only preview flag (#145), beside `file` / `edits`.
 */
const payload = {
  file: "sample.ts",
  edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "new" }],
};

const schema = editToolSchema as unknown as JsonSchemaNode;

describe("editToolSchema — dry_run declaration", () => {
  it("declares dry_run beside file and edits as boolean-or-null", () => {
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["file", "edits", "dry_run"]),
    );
    expect(schema.required).toEqual(["file", "edits"]);

    const dryRun = schema.properties?.dry_run;
    expect(dryRun?.oneOf?.map((branch) => branch.type)).toEqual(["boolean", "null"]);
  });

  it("admits true, false, null, and absent", () => {
    expect(validateJsonSchemaValue(schema, { ...payload, dry_run: true })).toEqual([]);
    expect(validateJsonSchemaValue(schema, { ...payload, dry_run: false })).toEqual([]);
    expect(validateJsonSchemaValue(schema, { ...payload, dry_run: null })).toEqual([]);
    expect(validateJsonSchemaValue(schema, payload)).toEqual([]);
  });

  it("refuses a non-boolean dry_run", () => {
    for (const bad of ["yes", 1, {}]) {
      expect(
        validateJsonSchemaValue(schema, { ...payload, dry_run: bad as never }).length,
      ).toBeGreaterThan(0);
    }
  });
});
