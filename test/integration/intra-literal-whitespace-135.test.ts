/**
 * Issue #135 — intra-line whitespace is significant (canon v4, trim-only; ADR-0040 amends ADR-0002).
 *
 * The canon is the pairing evidence a served anchor is verified against: `canonDigest` must
 * reproduce the digest the lease recorded, or the edit refuses fail-closed. v4 strips ONE leading
 * and ONE trailing run of the frozen 28-code-point whitespace class and never an interior run, so:
 *
 *  - an external writer that rewrites whitespace INSIDE a line — inside a string literal too,
 *    `"a b"` -> `"ab"` — changes the canon and the edit must reject with the on-disk bytes intact;
 *  - a pure re-indent (edge run) or an appended trailing run folds to the same canon and the edit
 *    still applies — the formatter tolerance the seam keeps.
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import { codeOf } from "../../src/utils.js";

const SERVED = 'class A {\n\tString s = "a b";\n}\n';
const TARGET_LINE = '\tString s = "a b";';

type Harness = ReturnType<typeof setupIntegrationTest>;

type Rows = Array<{ hash: string; content: string }>;

function servedRows(harness: Harness, path: string): Promise<Rows> {
  return harness.readTool.execute("read", { path }).then((res) => {
    const rows: Rows = [];
    for (const line of getText(res).split("\n")) {
      const sep = line.indexOf("│");
      if (sep === -1) continue;
      rows.push({ hash: line.slice(0, sep), content: line.slice(sep + 1) });
    }
    return rows;
  });
}

function anchorFor(rows: Rows, target: string): string {
  const row = rows.find((r) => r.content === target);
  expect(row, `served rows did not contain ${JSON.stringify(target)}`).toBeDefined();
  return row!.hash;
}

/** Apply one named-object edit through the tool path; returns its code and message when it rejects. */
async function editOne(
  harness: Harness,
  anchor: string,
  replacement: string,
): Promise<{ error?: unknown; code?: string; message: string }> {
  try {
    await harness.editTool.execute("edit", {
      file: "t.ts",
      edits: [{ anchor_from: anchor, anchor_to: anchor, replace_with: replacement }],
    });
    return { message: "" };
  } catch (error) {
    const code = codeOf(error);
    const message = error instanceof Error ? error.message : String(error);
    return code === undefined ? { error, message } : { error, code, message };
  }
}

describe("issue #135 — intra-literal whitespace is significant (canon v4)", () => {
  it("(a) rejects an intra-literal rewrite and preserves the external writer's bytes", async () => {
    await withTempFile("t.ts", SERVED, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchor = anchorFor(await servedRows(harness, "t.ts"), TARGET_LINE);

      const external = 'class A {\n\tString s = "ab";\n}\n';
      await writeFile(path, external, "utf-8");

      const { error, code, message } = await editOne(harness, anchor, '\tString s = "a c";');
      const onDisk = await readFile(path, "utf-8");

      expect(error, "the intra-literal rewrite must reject, not overwrite").toBeDefined();
      expect(code).toBe("E_STALE_ANCHOR");
      expect(message).toContain("[E_STALE_ANCHOR]");
      expect(onDisk).toBe(external);
    });
  });

  it("(b) applies across a pure re-indent (edge whitespace folds)", async () => {
    await withTempFile("t.ts", SERVED, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchor = anchorFor(await servedRows(harness, "t.ts"), TARGET_LINE);

      await writeFile(path, 'class A {\n    String s = "a b";\n}\n', "utf-8");

      const { error, code } = await editOne(harness, anchor, '\tString s = "a c";');
      expect(error, `re-indent must not break pairing (${code ?? "no code"})`).toBeUndefined();
      expect(await readFile(path, "utf-8")).toBe('class A {\n\tString s = "a c";\n}\n');
    });
  });

  it("(c) applies across an appended trailing run (edge whitespace folds)", async () => {
    await withTempFile("t.ts", SERVED, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchor = anchorFor(await servedRows(harness, "t.ts"), TARGET_LINE);

      await writeFile(path, 'class A {\n\tString s = "a b";   \n}\n', "utf-8");

      const { error, code } = await editOne(harness, anchor, '\tString s = "a c";');
      expect(
        error,
        `trailing padding must not break pairing (${code ?? "no code"})`,
      ).toBeUndefined();
      expect(await readFile(path, "utf-8")).toBe('class A {\n\tString s = "a c";\n}\n');
    });
  });

  it("(d) pins the deliberate narrowing: a parenthesis-spacing rewrite rejects", async () => {
    await withTempFile("t.ts", "foo( a, b );\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const anchor = anchorFor(await servedRows(harness, "t.ts"), "foo( a, b );");

      const external = "foo(a,b);\n";
      await writeFile(path, external, "utf-8");

      const { error, code, message } = await editOne(harness, anchor, "foo(c, d);");
      expect(error, "the interior rewrite must reject").toBeDefined();
      expect(code).toBe("E_STALE_ANCHOR");
      expect(message).toContain("[E_STALE_ANCHOR]");
      expect(await readFile(path, "utf-8")).toBe(external);
    });
  });
});
