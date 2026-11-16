import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * Applied-vs-rejection notice tier, end to end (#115).
 *
 * Two channels, two header families: an applied mutation's notice is a `[W_*]`
 * line (composed by `formatWarning`), a refusal is an `[E_*]` line (composed by
 * `formatError`). #115's report was an `[E_*]` header on a success path — a
 * null-file `Autocorrected` notice rendered from `formatError`. #117 retired
 * that producer at admission (a null file is now `E_BAD_PAYLOAD`), so these
 * cells pin the tier on the paths that remain.
 *
 * The success cells need an APPLIED warning, so one uses the reversed-range
 * heal and one the literal-mode bypass: each applies and its `[USER] [W_*]`
 * notice rides the same rendered output as `Successfully edited` — the exact
 * place a stray `[E_*]` header would surface. The literal path is also the
 * behavioural backstop for source-scan invisibility (`warnings.push(...list)`
 * and variable-carried notices, see `test/arch/applied-notice-tier.test.ts`):
 * the rendered output is observed, not the source shape.
 */

type ToolResult = { content: Array<{ text?: string }> };

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

describe("applied-vs-rejection notice tier (#115)", () => {
  it("an applied edit with a healed reversed range carries a [W_*] notice and no [E_*] header", async () => {
    await withTempFile("tier.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const text = getText(await harness.readTool.execute("read", { path: "tier.txt" }));
      const first = anchorFor(text, "a");
      const last = anchorFor(text, "c");

      // Later anchor first, earlier second: the pipeline heals the range and
      // reports the heal as an applied-tier notice.
      const out = await harness.editTool.execute("edit", {
        file: "tier.txt",
        edits: [[last, first, "X"]],
      } as never);
      const rendered = allText(out);

      expect(rendered).toContain("Successfully edited");
      expect(rendered).toContain("[USER] [W_REVERSED_ANCHORS]");
      // The tier: the applied notice channel never carries an error header.
      expect(rendered).not.toContain("[E_");
      expect(await readFile(path, "utf-8")).toBe("X\n");
    });
  });

  it("a literal-mode applied edit carries [USER] [W_LITERAL_BYPASS] and no [E_*] header", async () => {
    await withTempFile("tier-literal.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const text = getText(await harness.readTool.execute("read", { path: "tier-literal.txt" }));
      const echoed = text.split("\n").find((line) => line.endsWith("│alpha"))!;
      const anchor = anchorFor(text, "alpha");

      // The echoed served row is refused as E_SUSPICIOUS_TEXT without the mode;
      // declared literal it applies with an applied-tier notice.
      const out = await harness.editTool.execute("edit", {
        file: "tier-literal.txt",
        edits: [[anchor, anchor, echoed]],
        mode: "literal",
      } as never);
      const rendered = allText(out);

      expect(rendered).toContain("Successfully edited");
      expect(rendered).toContain("[USER] [W_LITERAL_BYPASS]");
      expect(rendered).not.toContain("[E_");
      expect(await readFile(path, "utf-8")).toBe(`${echoed}\nbeta\n`);
    });
  });

  it("a genuine rejection still carries its [E_*] header (inverse)", async () => {
    await withTempFile("tier-refuse.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const text = getText(await harness.readTool.execute("read", { path: "tier-refuse.txt" }));
      const hash = anchorFor(text, "b");

      let caught: unknown;
      try {
        await harness.editTool.execute("edit", { file: null, edits: [[hash, hash, "B"]] } as never);
      } catch (error) {
        caught = error;
      }

      expect((caught as { code?: string } | undefined)?.code).toBe("E_BAD_PAYLOAD");
      expect((caught as Error).message).toContain("[TO MODEL] [E_BAD_PAYLOAD]");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });
});
