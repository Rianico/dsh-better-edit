import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assertEditRequest, normalizeRequest, prepareEditArguments } from "../../src/contract.js";
import { DomainError } from "../../src/domain-errors.js";
import { parseHashRef, resEdit } from "../../src/hashline/anchor-pipeline.js";
import { setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * #217 refusal budget (spec #214 T2): an admission refusal states the fault and ONE shape line.
 *
 * (a) No refusal echoes the request (`Received: ` and every `describeReceived` variant are gone).
 * (b) No refusal inlines the canonical-payload paragraph (`EDIT_PAYLOAD_HINT` is gone).
 * (c) A malformed payload stays inside the budget and still names the fault.
 * (d) The shape line names every root key the payload contract accepts, and rides exactly once on
 *     the arms that previously carried the paragraph (zero elsewhere).
 * (e) Anchor reasons carry no terminal period; the registry joins exactly one terminator.
 */

const HEADER = "[TO MODEL] [E_BAD_PAYLOAD] ";
const BUDGET = 180;
const SHAPE =
  "Edit payload: { file, edits: [{ anchor_from, anchor_to, replace_with }], mode?, dry_run?, allow_encoding_migration? }";

function refusalOf(input: unknown): string {
  try {
    assertEditRequest(normalizeRequest(input));
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error(`expected an admission refusal for ${String(input)}`);
}

function preparedRefusalOf(input: unknown): string {
  try {
    prepareEditArguments(input);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error(`expected a prepared refusal for ${String(input)}`);
}

function catchOf(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a DomainError");
}

function shapeCount(message: string): number {
  return message.split(SHAPE).length - 1;
}

/** Inputs that land on the generic malformed-payload arm (the one that carried the paragraph). */
const GENERIC_ARM_INPUTS: unknown[] = [
  undefined,
  null,
  "bare-string",
  123,
  ["an", "array"],
  {},
  { file: "s.txt", edits: "nope" },
  { file: "s.txt", edits: [] },
  { file: "s.txt", edits: [{ anchor_from: "aB3", anchor_to: "cD4" }] },
  { file: "s.txt", edits: [{ anchor_from: "aB3", anchor_to: "cD4", replace_with: "x", extra: 1 }] },
  { file: "s.txt", edits: [["aB3", "cD4", "x"]], mode: "bogus" },
  { file: "s.txt", edits: [["aB3", "cD4", "x"]], bogus: true },
];

/** Inputs that land on a named arm that never carried the paragraph. */
const SPECIFIC_ARM_INPUTS: unknown[] = [
  { edits: [["aB3", "cD4", "x"]] },
  { file: null, edits: [["aB3", "cD4", "x"]] },
  { file: "s.txt", edits: [["aB3", "cD4", "x"]], dry_run: "yes" },
  { file: "s.txt", edits: [["aB3", "cD4", "x"]], allow_encoding_migration: "nope" },
];

describe("edit refusal budget (#217, spec #214)", () => {
  it("no rendered refusal repeats the submitted request", () => {
    for (const input of [...GENERIC_ARM_INPUTS, ...SPECIFIC_ARM_INPUTS]) {
      for (const message of [refusalOf(input), preparedRefusalOf(input)]) {
        expect(message).not.toContain("Received: ");
        expect(message).not.toContain("Received no arguments");
        expect(message).not.toContain("Received null");
        expect(message).not.toContain("Received a bare string");
      }
    }
  });

  it("the canonical-payload paragraph is gone from every arm and from src/", () => {
    for (const input of [...GENERIC_ARM_INPUTS, ...SPECIFIC_ARM_INPUTS]) {
      for (const message of [refusalOf(input), preparedRefusalOf(input)]) {
        expect(message).not.toContain("Edit must be called with exactly one payload");
      }
    }
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "contract.ts"),
      "utf-8",
    );
    expect(source).not.toContain("EDIT_PAYLOAD_HINT");
    expect(source).not.toContain("describeReceived");
  });

  it("a malformed payload stays inside the budget and still names the fault", () => {
    for (const input of GENERIC_ARM_INPUTS) {
      for (const message of [refusalOf(input), preparedRefusalOf(input)]) {
        expect(message, message).toMatch(/malformed/i);
        expect(message.length, message).toBeLessThanOrEqual(BUDGET);
        expect(message.startsWith(HEADER), message).toBe(true);
      }
    }
  });

  it("every arm that carried the paragraph now carries the shape line exactly once", () => {
    for (const input of GENERIC_ARM_INPUTS) {
      expect(shapeCount(refusalOf(input)), refusalOf(input)).toBe(1);
      expect(shapeCount(preparedRefusalOf(input)), preparedRefusalOf(input)).toBe(1);
    }
  });

  it("arms that never carried the paragraph stay unchanged (no shape line)", () => {
    for (const input of SPECIFIC_ARM_INPUTS) {
      const message = refusalOf(input);
      expect(shapeCount(message), message).toBe(0);
      expect(message.length, message).toBeLessThanOrEqual(BUDGET);
    }
  });

  it("the shape line names every root key the payload contract accepts", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "contract.ts"),
      "utf-8",
    );
    const block = /const ROOT_INPUT_KS = new Set\(\[([\s\S]*?)\]\)/.exec(source);
    expect(block, "ROOT_INPUT_KS must stay a literal Set in contract.ts").not.toBeNull();
    const rootKeys = [...block![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    for (const key of ["file", "edits", "mode", "dry_run", "allow_encoding_migration"]) {
      expect(rootKeys, `${key} must stay a root key`).toContain(key);
    }
    const EXCLUDED: Record<string, string> = {
      file_path: "legacy alias for file; the shape names the canonical spelling",
      path: "legacy alias for file; the shape names the canonical spelling",
      sandbox_permissions: "dsh escalation passthrough, not a payload field",
      justification: "dsh escalation passthrough, not a payload field",
    };
    for (const key of rootKeys) {
      if (EXCLUDED[key] !== undefined) continue;
      expect(new RegExp(`\\b${key}\\b`).test(SHAPE), `${key} missing from the shape line`).toBe(
        true,
      );
    }
    for (const key of ["file", "edits", "mode", "dry_run", "allow_encoding_migration"]) {
      expect(EXCLUDED[key], `${key} must be named in the shape line, not excluded`).toBeUndefined();
    }
  });

  it("no refusal renders a doubled terminator", () => {
    const messages = [
      ...GENERIC_ARM_INPUTS.map(refusalOf),
      ...SPECIFIC_ARM_INPUTS.map(refusalOf),
      catchOf(() => parseHashRef("5aB3")).message,
      catchOf(() => parseHashRef("abc│content")).message,
      catchOf(() => parseHashRef("")).message,
    ];
    for (const message of messages) expect(message, message).not.toContain("..");
  });

  it("the tool boundary renders the same budgeted refusal", async () => {
    await withTempFile("budget.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      let message = "";
      try {
        await harness.editTool.execute("budget", { file: "budget.txt", edits: [] });
        expect.unreachable();
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message.length, message).toBeLessThanOrEqual(BUDGET);
      expect(message.startsWith(HEADER), message).toBe(true);
      expect(shapeCount(message), message).toBe(1);
      expect(message).not.toContain("Received: ");
    });
  });
});

describe("anchor reasons join the registry terminator exactly once", () => {
  const REF_PROBES = ["", "ab", "5aB3", "aB3:trailing", "abc│content", "x│"];

  for (const probe of REF_PROBES) {
    it(`parseHashRef(${JSON.stringify(probe)}) carries no reason period and one message terminator`, () => {
      const error = catchOf(() => parseHashRef(probe));
      expect(error.code).toBe("E_MALFORMED_ANCHOR");
      const reason = (error.payload as { reason: string }).reason;
      expect(reason.endsWith("."), reason).toBe(false);
      expect(error.message.endsWith("."), error.message).toBe(true);
      expect(error.message.includes(".."), error.message).toBe(false);
    });
  }

  const EDIT_PROBES: Record<string, () => unknown> = {
    "pasted multi-line block": () =>
      resEdit({ anchor_from: "abc│one\ndef│two", anchor_to: "abc│one", replace_with: "x" }),
    "diff-preview + marker": () =>
      resEdit({ anchor_from: "+aB3│row", anchor_to: "+aB3│row", replace_with: "x" }),
    "leading - marker": () =>
      resEdit({ anchor_from: "-aB3│row", anchor_to: "-aB3│row", replace_with: "x" }),
    "HASH│ prefix": () =>
      resEdit({ anchor_from: "aB3│row", anchor_to: "aB3│row", replace_with: "x" }),
  };

  for (const [name, run] of Object.entries(EDIT_PROBES)) {
    it(`${name} carries no reason period and one message terminator`, () => {
      const error = catchOf(run);
      expect(error.code).toBe("E_MALFORMED_ANCHOR");
      const reason = (error.payload as { reason: string }).reason;
      expect(reason.endsWith("."), reason).toBe(false);
      expect(error.message.endsWith("."), error.message).toBe(true);
      expect(error.message.includes(".."), error.message).toBe(false);
    });
  }

  it("the pre-#217 terminated reason literals are gone from the pipeline source", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "hashline", "anchor-pipeline.ts"),
      "utf-8",
    );
    for (const old of [
      '(e.g. "aB3").',
      "no line numbers or trailing content.",
      'from "│" onward.',
      "or re-read the file.",
      "pass the bare anchor.",
      "from ${locations} (${evidence}).",
      "stripped diff-preview marker from ${locations}.",
      "use bare content without HASH│ next time.",
    ]) {
      expect(source, `terminal period returned: ${old}`).not.toContain(old);
    }
  });
});
