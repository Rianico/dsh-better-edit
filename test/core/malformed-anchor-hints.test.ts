/**
 * #108 — a multi-line anchor paste must be refused by SHAPE alone.
 *
 * The deleted bare-arm extraction mined a 3-char alnum run out of the pasted block
 * and told the model `use bare "<run>" next time`. That token is not a coordinate the
 * read served, so following the hint could edit an unrelated line. Regression: the
 * refusal names no coordinate, writes nothing, and mints no quoted anchor-shaped token.
 *
 * @module dsh-better-edit/test/malformed-anchor-hints
 */
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { setupIntegrationTest, getText, withTempFile } from "../support/fixtures.js";
import { parseHashRef, resEdit } from "../../src/hashline/anchor-pipeline.js";
import { initHasher } from "../../src/hashline/hash-assign.js";

/** The one anchored-shape token the message may quote: the documented example. */
const DOCUMENTED_EXAMPLE = "aB3";

/** Quoted 3-char anchor-shaped tokens, minus the documented example. */
function unlistedQuotedAnchors(message: string): string[] {
  return [...message.matchAll(/"([A-Za-z0-9]{3})"/g)]
    .map((m) => m[1]!)
    .filter((token) => token !== DOCUMENTED_EXAMPLE);
}

/** Hashes served by a read, keyed by line content. */
function servedByContent(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^([ +]?)([A-Za-z0-9]{3})│(.*)$/);
    if (m) map.set(m[3]!, m[2]!);
  }
  return map;
}

const INITIAL = "const alpha = 1;\nconst value274777 = 274777;\nconst beta = 2;\n";

/** The 4-line paste that reproduced the defect: `settlementStatus` yielded the pseudo-anchor "set". */
const PASTED_BLOCK = "settlementStatus: '',\n      remark: ''\n    })\n  })";

beforeAll(async () => {
  await initHasher();
});

describe("#108 multi-line anchor paste — shape refusal, no minted coordinate", () => {
  it("the token extractor is refutable (it finds a quoted pseudo-anchor when one exists)", () => {
    expect(unlistedQuotedAnchors('Invalid anchor "set": use bare "set" next time')).toEqual([
      "set",
      "set",
    ]);
    expect(
      unlistedQuotedAnchors(
        `Expected a 3-char alphanumeric anchor (e.g. "${DOCUMENTED_EXAMPLE}").`,
      ),
    ).toEqual([]);
  });

  it("rejects with E_MALFORMED_ANCHOR, leaves the file byte-identical, names no coordinate", async () => {
    await withTempFile("app.ts", INITIAL, async ({ cwd, path }) => {
      const { editTool } = setupIntegrationTest(cwd);
      let message = "";
      try {
        await editTool.execute("e1", {
          path: "app.ts",
          edits: [{ anchor_from: PASTED_BLOCK, anchor_to: PASTED_BLOCK, replace_with: "REPLACED" }],
        });
        expect.unreachable("multi-line anchor paste must be refused");
      } catch (error) {
        message = String((error as Error).message);
      }

      expect(message).toContain("[E_MALFORMED_ANCHOR]");
      expect(message).toMatch(/must be a single bare 3-char hash/);
      expect(message).toMatch(/4-line block/);
      // T3: the paste is redacted at the echo site — no block byte reaches the transcript.
      expect(message).toContain('Invalid anchor "4-line block"');
      expect(message).not.toContain("settlementStatus");
      expect(message).not.toContain("remark");
      // The deleted hint shipped a coordinate plus an instruction to reuse it.
      expect(message).not.toMatch(/extracted first hash/);
      expect(message).not.toMatch(/use bare "/);
      expect(unlistedQuotedAnchors(message)).toEqual([]);
      expect(message).not.toContain('"set"');
      // No write happened: the refusal grants nothing.
      expect(await readFile(path, "utf-8")).toBe(INITIAL);
    });
  });

  it("a rejected paste does not write its sibling batch item either", async () => {
    await withTempFile("app.ts", INITIAL, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const served = servedByContent(getText(await readTool.execute("r1", { path: "app.ts" })));
      const beta = served.get("const beta = 2;")!;
      expect(beta).toMatch(/^[A-Za-z0-9]{3}$/);

      let message = "";
      try {
        await editTool.execute("e2", {
          path: "app.ts",
          edits: [
            { anchor_from: beta, anchor_to: beta, replace_with: "const beta = 999;" },
            { anchor_from: PASTED_BLOCK, anchor_to: PASTED_BLOCK, replace_with: "REPLACED" },
          ],
        });
        expect.unreachable("multi-line anchor paste must be refused");
      } catch (error) {
        message = String((error as Error).message);
      }

      expect(message).toContain("E_MALFORMED_ANCHOR");
      expect(unlistedQuotedAnchors(message)).toEqual([]);
      expect(await readFile(path, "utf-8")).toBe(INITIAL);
    });
  });
});

describe("#108 diagRef — no fabricated coordinate on a │ + newline paste", () => {
  it("parseHashRef names neither wUp nor AU6, and mints no quoted anchor", () => {
    let message = "";
    try {
      parseHashRef("x│y\nz│w");
      expect.unreachable("a pipe+newline paste must be refused");
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("[E_MALFORMED_ANCHOR]");
    expect(message).not.toContain("wUp");
    expect(message).not.toContain("AU6");
    expect(message).not.toMatch(/use only the first hash/);
    expect(unlistedQuotedAnchors(message)).toEqual([]);
  });

  it("a pipe-free newline paste still reaches the generic shape tail", () => {
    // The deleted branch's only replacement is the pre-existing tail — no new fallback.
    expect(() => parseHashRef("x\ny")).toThrow(/Expected a 3-char/);
  });

  it("the tool's refusal for the paste names no coordinate and writes nothing", async () => {
    await withTempFile("app.ts", INITIAL, async ({ cwd, path }) => {
      const { editTool } = setupIntegrationTest(cwd);
      let message = "";
      try {
        await editTool.execute("e3", {
          path: "app.ts",
          edits: [{ anchor_from: "x│y\nz│w", anchor_to: "x│y\nz│w", replace_with: "REPLACED" }],
        });
        expect.unreachable("a pipe+newline paste must be refused");
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).toContain("[E_MALFORMED_ANCHOR]");
      expect(message).not.toContain("wUp");
      expect(message).not.toContain("AU6");
      expect(unlistedQuotedAnchors(message)).toEqual([]);
      expect(await readFile(path, "utf-8")).toBe(INITIAL);
    });
  });

  it("following the old hint shape is the model's own input, not a malformed anchor", async () => {
    // `wUp`/`AU6` are ordinary 3-char anchors: the tool must reject them on
    // resolution, never re-label them as a shape failure or suggest them.
    await withTempFile("app.ts", INITIAL, async ({ cwd, path }) => {
      const { editTool } = setupIntegrationTest(cwd);
      let message = "";
      try {
        await editTool.execute("e4", {
          path: "app.ts",
          edits: [{ anchor_from: "wUp", anchor_to: "AU6", replace_with: "REPLACED" }],
        });
        expect.unreachable("unserved anchors must not apply");
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).not.toContain("E_MALFORMED_ANCHOR");
      expect(await readFile(path, "utf-8")).toBe(INITIAL);
    });
  });
});

describe("#108 multi-line rawAnchor redaction", () => {
  it("renders the N-line block redaction, never the pasted bytes", () => {
    let message = "";
    try {
      resEdit({ anchor_from: PASTED_BLOCK, anchor_to: PASTED_BLOCK, replace_with: "REPLACED" });
      expect.unreachable("multi-line anchor paste must be refused");
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain('Invalid anchor "4-line block"');
    // No byte of the pasted block survives into the transcript.
    expect(message).not.toContain("settlementStatus");
    expect(message).not.toContain("remark");
    expect(message).not.toContain("})");
    expect(message).not.toMatch(/\n/);
  });

  it("single-line refs keep the verbatim echo", () => {
    expect(() => resEdit({ anchor_from: "abc│x", anchor_to: "abc", replace_with: "y" })).toThrow(
      /Invalid anchor "abc│x"/,
    );
    expect(() => parseHashRef("abc│content")).toThrow(/Invalid anchor "abc│content"/);
  });
});
