import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * Issue #117: `file: null` is an admission error, never an inference request.
 *
 * Before #117 the edit tool quietly resolved a null `file` by looking the anchors
 * up in the snapshot store (`resolveNullPath`), so a caller that forgot the file
 * could still mutate a file it never named. The retired arm must reject with
 * `E_BAD_PAYLOAD` and leave every candidate file untouched — the `path` /
 * `file_path` alias folds stay a pre-validation convenience, not a fallback for
 * an explicitly-null file.
 *
 * Red until the inference seam lands (t2/t3); the alias-fold and no-`[E_` pins
 * hold on the current tree.
 */

type ToolResult = { content: Array<{ text?: string }> };

/**
 * The exact refusal ADR-0030 quotes. Asserted byte-for-byte so the specific
 * sentence stays reachable — the generic payload hint also quotes `"file"`,
 * so a loose match would pass on the wrong branch.
 */
const UNNAMED_FILE_REFUSAL =
  "[TO MODEL] [E_BAD_PAYLOAD] Edit request file must be a non-empty string; name the file to edit.";

/** All server blocks (result text + any warning block), joined for header scans. */
function allText(result: ToolResult): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

/** Served anchor of the first row whose content matches `label`. */
function anchorFor(readText: string, label: string): string {
  const row = readText.split("\n").find((line) => line.includes(`│${label}`));
  if (!row) throw new Error(`no served row for ${JSON.stringify(label)}`);
  return row.split("│")[0]!;
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the edit call to reject, but it resolved");
}

describe("edit admission: file: null (#117)", () => {
  it("rejects with E_BAD_PAYLOAD and leaves the only matching file untouched", async () => {
    await withTempFile("only.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", { path: "only.txt" });
      const hash = anchorFor(getText(read), "b");

      const error = await caught(() =>
        harness.editTool.execute("edit", { file: null, edits: [[hash, hash, "B"]] } as never),
      );

      expect(error).toMatchObject({ code: "E_BAD_PAYLOAD" });
      expect((error as Error).message).toBe(UNNAMED_FILE_REFUSAL);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });

  it("rejects `path: null` (alias fold) with E_BAD_PAYLOAD instead of inferring", async () => {
    await withTempFile("only.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", { path: "only.txt" });
      const hash = anchorFor(getText(read), "b");

      const error = await caught(() =>
        harness.editTool.execute("edit", { path: null, edits: [[hash, hash, "B"]] } as never),
      );

      expect(error).toMatchObject({ code: "E_BAD_PAYLOAD" });
      expect((error as Error).message).toBe(UNNAMED_FILE_REFUSAL);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });

  it("rejects `file_path: null` (alias fold) with E_BAD_PAYLOAD instead of inferring", async () => {
    await withTempFile("only.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", { path: "only.txt" });
      const hash = anchorFor(getText(read), "b");

      const error = await caught(() =>
        harness.editTool.execute("edit", { file_path: null, edits: [[hash, hash, "B"]] } as never),
      );

      expect(error).toMatchObject({ code: "E_BAD_PAYLOAD" });
      expect((error as Error).message).toBe(UNNAMED_FILE_REFUSAL);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });
  it('rejects `file: ""` with the exact unnamed-file refusal', async () => {
    await withTempFile("only.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", { path: "only.txt" });
      const hash = anchorFor(getText(read), "b");

      const error = await caught(() =>
        harness.editTool.execute("edit", { file: "", edits: [[hash, hash, "B"]] } as never),
      );

      expect(error).toMatchObject({ code: "E_BAD_PAYLOAD" });
      expect((error as Error).message).toBe(UNNAMED_FILE_REFUSAL);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });

  it("rejects an absent file with the exact unnamed-file refusal", async () => {
    await withTempFile("only.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", { path: "only.txt" });
      const hash = anchorFor(getText(read), "b");

      const error = await caught(() =>
        harness.editTool.execute("edit", { edits: [[hash, hash, "B"]] } as never),
      );

      expect(error).toMatchObject({ code: "E_BAD_PAYLOAD" });
      expect((error as Error).message).toBe(UNNAMED_FILE_REFUSAL);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });

  it("rejects a two-item batch with file: null and writes neither item", async () => {
    await withTempFile("only.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", { path: "only.txt" });
      const text = getText(read);
      const first = anchorFor(text, "a");
      const last = anchorFor(text, "c");

      const error = await caught(() =>
        harness.editTool.execute("edit", {
          file: null,
          edits: [
            [first, first, "A"],
            [last, last, "C"],
          ],
        } as never),
      );

      expect(error).toMatchObject({ code: "E_BAD_PAYLOAD" });
      expect((error as Error).message).toBe(UNNAMED_FILE_REFUSAL);
      // Whole-request refusal: neither item reached the file.
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });

  it.each(["path", "file_path"] as const)(
    "keeps the legacy %s alias fold working for a named file",
    async (alias) => {
      await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
        const read = await harness.readTool.execute("read", { path: "t.txt" });
        const hash = anchorFor(getText(read), "b");

        const out = await harness.editTool.execute("edit", {
          [alias]: "t.txt",
          edits: [[hash, hash, "B"]],
        } as never);

        expect(allText(out)).toContain("Successfully");
        expect(await readFile(path, "utf-8")).toBe("a\nB\nc\n");
      });
    },
  );

  // #115 acceptance pinned by construction: a successful edit's output carries no
  // `[E_*]` header (error headers are the rejection channel only).
  it("successful edit output carries no [E_ header", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", { path: "t.txt" });
      const hash = anchorFor(getText(read), "b");

      const out = await harness.editTool.execute("edit", {
        file: "t.txt",
        edits: [[hash, hash, "B"]],
      } as never);

      expect(allText(out)).toContain("Successfully");
      expect(allText(out)).not.toMatch(/\[E_/);
    });
  });
});
