import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * W_LITERAL_BYPASS producer lock: `mode: "literal"` declares reproduced
 * served rows as intended file content. The served-echo guard is bypassed,
 * the edit applies verbatim, and the applied-tier warning records the
 * declaration. Without the flag the same bytes are E_SUSPICIOUS_TEXT.
 */
describe("literal mode bypass (W_LITERAL_BYPASS)", () => {
  it("applies served-echo bytes verbatim with a bypass warning under mode literal", async () => {
    const initial = "alpha\nbeta\n";
    await withTempFile("literal.txt", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "literal.txt" });
      const row = getText(read)
        .split("\n")
        .find((line) => line.endsWith("│alpha"))!;
      const anchor = extractHash(row);

      const echoed = await editTool.execute("echo-literal", {
        path: "literal.txt",
        edits: [[anchor, anchor, row]],
        mode: "literal",
      });
      const text = getText(echoed);
      expect(text).toMatch(/\[USER\] \[W_LITERAL_BYPASS\]/);
      expect(await readFile(path, "utf-8")).toBe(`${row}\nbeta\n`);
    });
  });

  it("refuses the same bytes as E_SUSPICIOUS_TEXT without the literal flag", async () => {
    const initial = "alpha\nbeta\n";
    await withTempFile("literal-refuse.txt", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "literal-refuse.txt" });
      const row = getText(read)
        .split("\n")
        .find((line) => line.endsWith("│alpha"))!;
      const anchor = extractHash(row);

      await expect(
        editTool.execute("echo-general", {
          path: "literal-refuse.txt",
          edits: [[anchor, anchor, row]],
        }),
      ).rejects.toThrow(/E_SUSPICIOUS_TEXT/);
      expect(await readFile(path, "utf-8")).toBe(initial);
    });
  });

  it("rejects an unknown mode with E_BAD_PAYLOAD", async () => {
    const initial = "alpha\nbeta\n";
    await withTempFile("literal-badmode.txt", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "literal-badmode.txt" });
      const anchor = extractHash(
        getText(read)
          .split("\n")
          .find((line) => line.endsWith("│alpha"))!,
      );

      await expect(
        editTool.execute("bad-mode", {
          path: "literal-badmode.txt",
          edits: [[anchor, anchor, "ALPHA"]],
          mode: "verbatim",
        }),
      ).rejects.toThrow(/E_BAD_PAYLOAD/);
      expect(await readFile(path, "utf-8")).toBe(initial);
    });
  });
});
