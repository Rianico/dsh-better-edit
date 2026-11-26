import { readFile, writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import {
  canon,
  lineHashesPure,
  ServedRejectionError,
  verifyServedRange,
} from "../../src/hashline/index.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { codeOf } from "../../src/utils.js";

beforeAll(async () => {
  await initHasher();
});

/**
 * CONTRACT: a served span is verified against the file EXACTLY. Each boundary anchor
 * must have exactly one served position, the served span's length must equal the
 * requested range's length, and every line's hash must equal the served hash at its
 * served position. Since FU-4 the rejections are granular: a leased boundary whose line
 * identity is gone rejects `E_TARGET_LOST` at the interception
 * (`src/hashline/served-evidence.ts`, `interceptLeaseBoundaries`), a zero-served-position anchor
 * rejects `E_UNKNOWN_ANCHOR` (`verifyServedRange`), an ambiguous boundary keeps
 * `E_UNSERVED_RANGE` with rows,
 * and the `verifyRebasedSpan` gate keeps `E_STALE_RANGE`. The edit NEVER re-binds onto a
 * surviving twin. Under the aligned edit load (T3, ADR-0050) a deleted twin's anchor is
 */
describe("deleted twin anchor (exact position lock)", () => {
  it("rejects E_STALE_ANCHOR and writes nothing when the anchored line was deleted externally", async () => {
    const initial =
      "export function alpha() {\n" +
      "  return compute(value);\n" +
      "}\n" +
      "\n" +
      "export function beta() {\n" +
      "  return compute(value);\n" +
      "}\n";

    await withTempFile("twins.ts", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "twins.ts" });
      const rows = getText(read).split("\n");
      const twinRows = rows.filter((line) => line.endsWith("│  return compute(value);"));
      expect(twinRows).toHaveLength(2);
      const firstAnchor = extractHash(twinRows[0]!);
      const secondAnchor = extractHash(twinRows[1]!);
      expect(firstAnchor).not.toBe(secondAnchor);

      const external = initial.replace("  return compute(value);\n", "");
      expect(external).not.toBe(initial);
      await writeFile(path, external, "utf-8");

      let error: unknown;
      try {
        await editTool.execute("stale-twin", {
          path: "twins.ts",
          anchor_from: firstAnchor,
          anchor_to: firstAnchor,
          replace_with: "  return changed;",
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      const message = String((error as Error).message);
      expect(message).toMatch(/E_STALE_ANCHOR/);
      expect(message).toContain(
        `1 stale anchor in twins.ts: "${firstAnchor}". Re-read for fresh anchors.`,
      );
      expect(message).not.toContain("Current range:");
      expect(message).not.toContain("Retry with these anchors");
      expect(await readFile(path, "utf-8")).toBe(external);
    });
  });

  it("rejects E_UNSERVED_RANGE when an orphaned serve leaves the boundary ambiguous", () => {
    const fileLines = ["alpha", "beta", "gamma"];
    const fileHashes = lineHashesPure(fileLines.join("\n"));
    const hAlpha = fileHashes[0]!;
    const hBeta = fileHashes[1]!;
    const servedCanons = fileLines.map((line) => canon(line));

    expect(() =>
      verifyServedRange({
        served: [...fileHashes],
        servedCanons: [...servedCanons],
        startHash: hAlpha,
        endHash: hBeta,
        startLine: 1,
        endLine: 2,
        fileHashes: [...fileHashes],
        fileLines: [...fileLines],
      }),
    ).not.toThrow();

    let code: string | undefined;
    let message = "";
    try {
      verifyServedRange({
        served: [hAlpha, hBeta, hAlpha],
        servedCanons: [...servedCanons],
        startHash: hAlpha,
        endHash: hBeta,
        startLine: 1,
        endLine: 2,
        fileHashes: [...fileHashes],
        fileLines: [...fileLines],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ServedRejectionError);
      code = codeOf(error);
      message = error instanceof Error ? error.message : String(error);
    }
    expect(code).toBe("E_UNSERVED_RANGE");
    expect(message).toContain("was served at 2 positions");
  });

  it("rejects E_STALE_RANGE on the pos-free path too — the position check is unconditional", () => {
    const fileLines = ["twin", "other"];
    const fileHashes = lineHashesPure(fileLines.join("\n"));
    const hTwin = fileHashes[0]!;
    const hOther = fileHashes[1]!;

    const served = [hOther, hTwin];
    const servedCanons = [canon("other"), canon("twin")];

    const reject = (): string | undefined => {
      try {
        verifyServedRange({
          served,
          servedCanons,
          startHash: hTwin,
          endHash: hTwin,
          startLine: 1,
          endLine: 1,
          fileHashes,
          fileLines,
        });
        return undefined;
      } catch (error) {
        expect(error).toBeInstanceOf(ServedRejectionError);
        return codeOf(error);
      }
    };

    expect(reject()).toBe("E_STALE_RANGE");
    expect(served).toEqual([hOther, hTwin]);
    expect(servedCanons).toEqual([canon("other"), canon("twin")]);
  });

  it("rejects E_STALE_ANCHOR when a WINDOWED read served the twin (alignment makes the spelling absent)", async () => {
    const initial =
      "export function alpha() {\n" +
      "  return compute(value);\n" +
      "}\n" +
      "\n" +
      "export function beta() {\n" +
      "  return compute(value);\n" +
      "}\n";

    await withTempFile("windowed-twin.ts", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("windowed-route", {
        path: "windowed-twin.ts",
        offset: 1,
        limit: 3,
      });
      const rows = getText(read).split("\n");
      const twinRows = rows.filter((line) => line.endsWith("│  return compute(value);"));
      expect(twinRows).toHaveLength(1);
      const firstAnchor = extractHash(twinRows[0]!);

      const external = initial.replace("  return compute(value);\n", "");
      expect(external).not.toBe(initial);
      await writeFile(path, external, "utf-8");

      let error: unknown;
      try {
        await editTool.execute("windowed-route", {
          path: "windowed-twin.ts",
          anchor_from: firstAnchor,
          anchor_to: firstAnchor,
          replace_with: "  return changed;",
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(String((error as Error).message)).toMatch(/E_STALE_ANCHOR/);
      expect(await readFile(path, "utf-8")).toBe(external);
    });
  });
});
