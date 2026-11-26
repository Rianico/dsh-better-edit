import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hash-assign.js";

beforeAll(async () => {
  await initHasher();
});

/**
 * Deciding cell for GitHub issue #63 — "`edit` rejects any `HASH│`-prefixed line in
 * replacement_text (over-broad guard misfires on legitimate content)".
 *
 * The issue's acceptance criteria, verbatim, are the assertions:
 *
 *  1. TREATMENT: a 3-line target file; an edit whose `replace_with` contains the literal
 *     lines `abc│text` / `KEY│value` — 3-char prefixes NOT anchors of the file (`0 matched`
 *     per the issue) — must WRITE THROUGH unchanged. The guard may reject only when the
 *     line-start hash is a real anchor matching the served echo at that position
 *     (`E_SERVED_ECHO` semantics), not on the bare pattern.
 */

const SOURCE = "alpha\nbeta\ngamma\n";
const LITERAL_LINES = ["abc│text", "KEY│value"];
const LITERAL_REPLACEMENT = LITERAL_LINES.join("\n");

describe("P0-63 — literal HASH│-shaped replacement content must write through (issue #63)", () => {
  it("writes 0-matched literal `abc│text`/`KEY│value` through unchanged (treatment, acceptance criterion 1)", async () => {
    await withTempFile("target.txt", SOURCE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);

      const read = getText(await readTool.execute("read-full", { path: "target.txt" }));
      const rows = read.split("\n");
      const row1 = rows.find((l) => l.endsWith("│alpha"));
      expect(row1, "line 1 (`alpha`) served").toBeDefined();
      const anchor1 = extractHash(row1!);
      const fileAnchors = rows
        .filter((l) => /│(alpha|beta|gamma)$/.test(l))
        .map((l) => extractHash(l));
      expect(fileAnchors).toHaveLength(3);
      for (const line of LITERAL_LINES) {
        const prefix = line.slice(0, 3);
        expect(fileAnchors, `literal prefix '${prefix}' must not be a real anchor`).not.toContain(
          prefix,
        );
      }

      let error: unknown;
      let outcome: Awaited<ReturnType<typeof editTool.execute>> | undefined;
      try {
        outcome = await editTool.execute("write-literal", {
          path: "target.txt",
          anchor_from: anchor1,
          anchor_to: anchor1,
          replace_with: LITERAL_REPLACEMENT,
        });
      } catch (e) {
        error = e;
      }

      expect(
        error,
        "0-matched literal HASH│ content must write through, not reject the batch",
      ).toBeUndefined();
      expect(await readFile(path, "utf-8")).toBe(`${LITERAL_REPLACEMENT}\nbeta\ngamma\n`);
      const out = getText(outcome!);
      expect(out).toContain("[W_NEVER_SERVED_SHAPE]");
      expect(out).toContain("2 replacement lines open with anchor-shaped tokens");
      expect(out).toContain("Applied verbatim.");
      expect(out).toContain("If the hash anchor prefix was unintended, `undo_last_edit`");
    });
  });

  it("control (a): the same replacement without the HASH│ prefixes writes fine", async () => {
    await withTempFile("target.txt", SOURCE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);

      const read = getText(await readTool.execute("read-full", { path: "target.txt" }));
      const row1 = read.split("\n").find((l) => l.endsWith("│alpha"));
      expect(row1).toBeDefined();
      const anchor1 = extractHash(row1!);

      await editTool.execute("write-unprefixed", {
        path: "target.txt",
        anchor_from: anchor1,
        anchor_to: anchor1,
        replace_with: "text\nvalue",
      });

      expect(await readFile(path, "utf-8")).toBe("text\nvalue\nbeta\ngamma\n");
    });
  });

  it("control (b): a real served-echo line is still rejected and writes nothing (acceptance criterion 3)", async () => {
    await withTempFile("target.txt", SOURCE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);

      const read = getText(await readTool.execute("read-full", { path: "target.txt" }));
      const rows = read.split("\n");
      const row1 = rows.find((l) => l.endsWith("│alpha"));
      expect(row1).toBeDefined();
      const anchor1 = extractHash(row1!);

      let error: unknown;
      try {
        await editTool.execute("paste-echo", {
          path: "target.txt",
          anchor_from: anchor1,
          anchor_to: anchor1,
          replace_with: row1!,
        });
      } catch (e) {
        error = e;
      }

      expect(error, "a real served-echo replacement must be rejected").toBeDefined();
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/E_SUSPICIOUS_TEXT/);
      expect(await readFile(path, "utf-8")).toBe(SOURCE);
    });
  });
});
