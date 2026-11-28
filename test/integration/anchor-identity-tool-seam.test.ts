/**
 * Issue #138 — anchor identity at the tool seam (the downstream port of upstream `a14fbc7`
 * / ADR-0013): anchors derive from the line's RAW bytes; canon is alignment-only.
 *
 * Canon-keyed pairing is deliberately PRESERVED downstream (`mapStableHashes` keys its survivor
 * index on `canon`), so this file pins both halves of the split:
 *
 *  - identity — the anchor a serve hands back for a written line equals the anchor that line's own
 *    bytes derive on a state-free re-derivation, and it moves when the bytes move;
 *  - alignment — a whitespace-only external rewrite (an edge run: re-indent) still applies through
 *    the pre-rewrite lease, because pairing/verification read the canon.
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import { lineHashes, lineHashesPure } from "../../src/hashline/index.js";
import { codeOf } from "../../src/utils.js";

type Harness = ReturnType<typeof setupIntegrationTest>;

type Rows = Array<{ hash: string; content: string }>;

/** Parse every `HASH│content` row out of a read's text. */
async function servedRows(harness: Harness, path: string): Promise<Rows> {
  const res = await harness.readTool.execute("read", { path });
  const rows: Rows = [];
  for (const line of getText(res).split("\n")) {
    const sep = line.indexOf("│");
    if (sep === -1) continue;
    rows.push({ hash: line.slice(0, sep), content: line.slice(sep + 1) });
  }
  return rows;
}

function anchorFor(rows: Rows, target: string): string {
  const row = rows.find((r) => r.content === target);
  expect(row, `served rows did not contain ${JSON.stringify(target)}`).toBeDefined();
  return row!.hash;
}

/** The anchor an edit's own diff row serves for one written line (`+HASH│content`). */
function diffAnchorFor(diffText: string, written: string): string {
  const row = diffText.split("\n").find((r) => r.startsWith("+") && r.includes(written));
  expect(row, `diff did not carry ${JSON.stringify(written)}`).toBeDefined();
  return row!.slice(1, 1 + 3);
}

/** Apply one named-object edit through the tool path; returns its code and message on rejection. */
async function editOne(
  harness: Harness,
  anchor: string,
  replacement: string,
): Promise<{ error?: unknown; code?: string; message: string; text: string }> {
  try {
    const res = await harness.editTool.execute("edit", {
      file: "t.ts",
      edits: [{ anchor_from: anchor, anchor_to: anchor, replace_with: replacement }],
    });
    return { message: "", text: getText(res) };
  } catch (error) {
    const code = codeOf(error);
    const message = error instanceof Error ? error.message : String(error);
    return { error, code, message, text: "" };
  }
}

describe("issue #138 — anchors identify raw bytes at the tool seam", () => {
  it("#138: a canon-unchanged edit serves the content-derived anchor, not a probe fallback", async () => {
    const served = '\tconst s = "a b";';
    const written = '    const s = "a b";';
    await withTempFile("t.ts", `const a = 1;\n${served}\nconst z = 2;\n`, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const preEditRef = anchorFor(await servedRows(harness, "t.ts"), served);

      const { error, code, text } = await editOne(harness, preEditRef, written);
      expect(error, `canon-unchanged edit must apply (${code ?? "no code"})`).toBeUndefined();

      const onDisk = await readFile(path, "utf-8");
      expect(onDisk).toBe(`const a = 1;\n${written}\nconst z = 2;\n`);

      const derived = await lineHashes(onDisk, path);
      const pure = lineHashesPure(onDisk);
      expect(derived).toEqual(pure);

      const reReadRef = anchorFor(await servedRows(harness, "t.ts"), written);
      expect(diffAnchorFor(text, written)).toBe(derived[1]);
      expect(reReadRef).toBe(derived[1]);
      expect(reReadRef).not.toBe(preEditRef);
    });
  });

  it("applies through the pre-rewrite lease after an external whitespace-only rewrite", async () => {
    const served = "\tconst beta = 2;";
    await withTempFile(
      "t.ts",
      `const alpha = 1;\n${served}\nconst gamma = 3;\n`,
      async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
        const betaRef = anchorFor(await servedRows(harness, "t.ts"), served);

        await writeFile(path, "const alpha = 1;\n  const beta = 2;\nconst gamma = 3;\n", "utf-8");

        const { error, code } = await editOne(harness, betaRef, "  const beta = 22;");
        expect(
          error,
          `re-indent must not break pairing (${code ?? "no code"}) — pairing stays canon-keyed`,
        ).toBeUndefined();
        expect(await readFile(path, "utf-8")).toBe(
          "const alpha = 1;\n  const beta = 22;\nconst gamma = 3;\n",
        );
      },
    );
  });

  it("rejects a brace merged onto the signature line (external token change)", async () => {
    await withTempFile("t.ts", "func hello()\n{\n    }\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const sigRef = anchorFor(await servedRows(harness, "t.ts"), "func hello()");

      const external = "func hello() {\n    }\n";
      await writeFile(path, external, "utf-8");

      const { error, code, message } = await editOne(harness, sigRef, "func hello() /* marked */");
      expect(error, "the merged signature line must reject, not overwrite").toBeDefined();
      expect(code).toBe("E_STALE_ANCHOR");
      expect(message).toContain("[E_STALE_ANCHOR]");
      expect(await readFile(path, "utf-8")).toBe(external);
    });
  });
});
