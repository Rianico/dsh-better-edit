import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hasher.js";

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
 *  2. CONTROL (a): the same content minus the `HASH│` prefixes writes fine — the edit
 *     itself is well-formed; only the prefix shape is in question.
 *  3. CONTROL (b): a REAL served-echo line (line-start hash ∈ the file's anchor set, served
 *     at that position — the `HASH│alpha` row from the read output) must STILL be rejected
 *     and write nothing — the require-a-delimiter side: the guard keeps firing on the
 *     genuinely illegitimate.
 *
 * The verdict instrument is the file BYTES through the real `readTool`/`editTool` seam —
 * not a `stripBarePrefixes` unit probe (the unit is already read in
 * `src/hashline/anchor-pipeline.ts:314-341`; this cell decides whether the lane actually
 * makes literal `HASH│` content unwritable).
 */

// The issue's repro fixture: "Prepare a target file (any text, e.g. three lines)".
const SOURCE = "alpha\nbeta\ngamma\n";
// The issue's literal lines verbatim; hashes `abc`/`KEY` are not anchors of this file.
const LITERAL_LINES = ["abc│text", "KEY│value"];
const LITERAL_REPLACEMENT = LITERAL_LINES.join("\n");

describe("P0-63 — literal HASH│-shaped replacement content must write through (issue #63)", () => {
  it("writes 0-matched literal `abc│text`/`KEY│value` through unchanged (treatment, acceptance criterion 1)", async () => {
    await withTempFile("target.txt", SOURCE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);

      // Full read serves anchors for the 3 lines (the edit needs a served anchor).
      const read = getText(await readTool.execute("read-full", { path: "target.txt" }));
      const rows = read.split("\n");
      const row1 = rows.find((l) => l.endsWith("│alpha"));
      expect(row1, "line 1 (`alpha`) served").toBeDefined();
      const anchor1 = extractHash(row1!);
      // Collision guard: the literal prefixes must be 0-matched against this file's
      // real anchors, or the treatment would exercise the echo arm, not literal content.
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
      try {
        await editTool.execute("write-literal", {
          path: "target.txt",
          anchor_from: anchor1,
          anchor_to: anchor1,
          replace_with: LITERAL_REPLACEMENT,
        });
      } catch (e) {
        error = e;
      }

      // VERDICT carrier #1 (the assertion that reddens while the over-broad guard lives):
      // 0-matched literal content must not be rejected. Under the bug this catches
      // E_MALFORMED_ANCHOR (`stripped "HASH│" prefix … 0 matched`).
      expect(
        error,
        "0-matched literal HASH│ content must write through, not reject the batch",
      ).toBeUndefined();
      // VERDICT carrier #2: the bytes landed literally, prefixes intact, rest untouched.
      expect(await readFile(path, "utf-8")).toBe(`${LITERAL_REPLACEMENT}\nbeta\ngamma\n`);
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

      // The edit shape is well-formed; only the prefix shape is under dispute.
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

      // The genuinely illegitimate case: paste the served read row back as replacement
      // content — line-start hash is a real anchor AND matches the served echo at that
      // position. The guard must keep rejecting this (E_SUSPICIOUS_TEXT in this tree;
      // 0.7.1 surfaced E_BAD_ANCHOR — the code is pinned loosely on purpose).
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
      // P3 remediation (acceptance criterion 2, pinned here at the reject arm): the
      // denial must state the blast radius honestly — whole batch rejected, nothing
      // written (wording as actually observed in the round-3 run).
      expect(message, "rejection must state whole-batch rejection").toMatch(
        /whole batch was rejected/i,
      );
      expect(message, "rejection must state nothing was written").toMatch(/nothing was written/i);
      // Nothing written: the file is byte-identical to the source.
      expect(await readFile(path, "utf-8")).toBe(SOURCE);
    });
  });
});
