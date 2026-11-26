/**
 * #147 / #172 — the EOL matrix, end to end through the public tools only.
 *
 * #169 gave an edit ONE effective terminator, #170 made a mixed pre-image disclose itself on the
 * read, and #171 made the undo restore at the ending the edit used. Those three claims only hold
 * together if the bytes and the two disclosures agree in the same run, so this spec drives
 * `read`, `edit` and `undo_last_edit` through their tool seams — never the engine — and pins all
 * five observable columns per fixture:
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initHasher } from "../../src/hashline/index.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { extractHash, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/** The terminator a file with no terminator of its own gets on this platform (the `system` rung). */
const SYSTEM_ENDING = process.platform === "win32" ? "\r\n" : "\n";

/** The read tier's bare header — no `[MODEL]`/`[USER]` audience prefix by contract. */
const MIXED_MARK = "[W_MIXED_EOL]";
/** The applied tier's header, audience included. */
const REWRITTEN_MARK = "[W_EOL_REWRITTEN]";

/** A served row: three anchor characters, the separator, then the line's text. */
const ANCHOR_ROW = /^([A-Za-z0-9]{3})│(.*)$/;

beforeAll(async () => {
  await initHasher();
});

afterEach(() => {
  _resetConfigCache();
  delete process.env.DSH_BETTER_EDIT_EOL;
});

type ToolResult = { content: Array<{ text?: string }> };

/** Every text block of a tool result — a warning can ride a block after the diff. */
function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

/** Occurrences of a literal substring: a disclosure must appear exactly once. */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The served anchors of a read result, keyed by the row's content. */
function anchorsByContent(text: string): Map<string, string> {
  const rows: RegExpExecArray[] = [];
  for (const line of text.split("\n")) {
    const match = ANCHOR_ROW.exec(line);
    if (match !== null) rows.push(match);
  }
  return new Map(rows.map((match) => [match[2]!, extractHash(match[0])]));
}

/** Seed the plugin YAML config with one `eol` setting, before any read (the cache is large). */
async function seedEol(cwd: string, setting: "AUTO" | "LF" | "CRLF" | "CR"): Promise<void> {
  const dir = join(cwd, ".dsh", "plugins", "dsh-better-edit");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.yaml"), `eol: ${setting}\n`, "utf-8");
  _resetConfigCache();
}

/** One fixture's full expectation: what goes in, what each of the three tools then says and does. */
interface MatrixCase {
  readonly name: string;
  readonly original: string;
  /** The line content to replace (it must be served as a row) and its replacement. */
  readonly from: string;
  readonly to: string;
  /** The whole-file read warning line this fixture ends on, or `undefined` when it must be absent. */
  readonly readWarning: string | undefined;
  /** The bytes `edit` leaves on disk. */
  readonly postEdit: string;
  /** The applied warning this edit renders, or `undefined` when it must be absent. */
  readonly editWarning: string | undefined;
  /** The bytes `undo_last_edit` leaves on disk. */
  readonly postUndo: string;
  /** The undo's mixture clause, or `undefined` when it must stay silent about a mixture. */
  readonly undoClause: string | undefined;
}

const CASES: readonly MatrixCase[] = [
  {
    name: "mixed-CRLF-majority",
    original: "alpha\r\nbeta\ngamma\r\n",
    from: "beta",
    to: "BETA",
    readWarning: `${MIXED_MARK} Mixed EOL: 2 CRLF, 1 LF. All edits normalize to CRLF (file).`,
    postEdit: "alpha\r\nBETA\r\ngamma\r\n",
    editWarning:
      "[MODEL] [W_EOL_REWRITTEN] EOL normalized to CRLF (file): 1 terminators changed. " +
      "Undo restores normalized content.",
    postUndo: "alpha\r\nbeta\r\ngamma\r\n",
    undoClause: "Restored at CRLF; the pre-edit mixture is not restored.",
  },
  {
    name: "mixed-CRLF-majority-lf-first",
    original: "alpha\nbeta\r\ngamma\r\n",
    from: "alpha",
    to: "ALPHA",
    readWarning: `${MIXED_MARK} Mixed EOL: 2 CRLF, 1 LF. All edits normalize to CRLF (file).`,
    postEdit: "ALPHA\r\nbeta\r\ngamma\r\n",
    editWarning:
      "[MODEL] [W_EOL_REWRITTEN] EOL normalized to CRLF (file): 1 terminators changed. " +
      "Undo restores normalized content.",
    postUndo: "alpha\r\nbeta\r\ngamma\r\n",
    undoClause: "Restored at CRLF; the pre-edit mixture is not restored.",
  },
  {
    name: "mixed-LF-majority",
    original: "alpha\r\nbeta\ngamma\n",
    from: "alpha",
    to: "ALPHA",
    readWarning: `${MIXED_MARK} Mixed EOL: 1 CRLF, 2 LF. All edits normalize to LF (file).`,
    postEdit: "ALPHA\nbeta\ngamma\n",
    editWarning:
      "[MODEL] [W_EOL_REWRITTEN] EOL normalized to LF (file): 1 terminators changed. " +
      "Undo restores normalized content.",
    postUndo: "alpha\nbeta\ngamma\n",
    undoClause: "Restored at LF; the pre-edit mixture is not restored.",
  },
  {
    name: "mixed-CR-majority",
    original: "alpha\rbeta\rgamma\r\ndelta\n",
    from: "alpha",
    to: "ALPHA",
    readWarning: `${MIXED_MARK} Mixed EOL: 1 CRLF, 1 LF, 2 CR. All edits normalize to CR (file).`,
    postEdit: "ALPHA\rbeta\rgamma\rdelta\r",
    editWarning:
      "[MODEL] [W_EOL_REWRITTEN] EOL normalized to CR (file): 2 terminators changed. " +
      "Undo restores normalized content.",
    postUndo: "alpha\rbeta\rgamma\rdelta\r",
    undoClause: "Restored at CR; the pre-edit mixture is not restored.",
  },
  {
    name: "mixed-tie-prefers-lf",
    original: "alpha\r\nbeta\rgamma\n",
    from: "alpha",
    to: "ALPHA",
    readWarning: `${MIXED_MARK} Mixed EOL: 1 CRLF, 1 LF, 1 CR. All edits normalize to LF (file).`,
    postEdit: "ALPHA\nbeta\ngamma\n",
    editWarning:
      "[MODEL] [W_EOL_REWRITTEN] EOL normalized to LF (file): 2 terminators changed. " +
      "Undo restores normalized content.",
    postUndo: "alpha\nbeta\ngamma\n",
    undoClause: "Restored at LF; the pre-edit mixture is not restored.",
  },
  {
    name: "uniform LF",
    original: "alpha\nbeta\n",
    from: "alpha",
    to: "ALPHA",
    readWarning: undefined,
    postEdit: "ALPHA\nbeta\n",
    editWarning: undefined,
    postUndo: "alpha\nbeta\n",
    undoClause: undefined,
  },
  {
    name: "uniform CRLF",
    original: "alpha\r\nbeta\r\n",
    from: "alpha",
    to: "ALPHA",
    readWarning: undefined,
    postEdit: "ALPHA\r\nbeta\r\n",
    editWarning: undefined,
    postUndo: "alpha\r\nbeta\r\n",
    undoClause: undefined,
  },
  {
    name: "uniform CR",
    original: "alpha\rbeta\r",
    from: "alpha",
    to: "ALPHA",
    readWarning: undefined,
    postEdit: "ALPHA\rbeta\r",
    editWarning: undefined,
    postUndo: "alpha\rbeta\r",
    undoClause: undefined,
  },
  {
    name: "zero-terminator",
    original: "alpha",
    from: "alpha",
    to: "ALPHA\nBETA",
    readWarning: undefined,
    postEdit: `ALPHA${SYSTEM_ENDING}BETA`,
    editWarning: undefined,
    postUndo: "alpha",
    undoClause: undefined,
  },
];

describe("EOL matrix — read, edit and undo agree on one effective terminator", () => {
  for (const matrixCase of CASES) {
    it(`${matrixCase.name}: serves, writes and reverts at the same ending`, async () => {
      await withTempFile("t.txt", matrixCase.original, async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);

        const readText = textOf(await harness.readTool.execute("r1", { path: "t.txt" }));
        const anchor = anchorsByContent(readText).get(matrixCase.from);
        expect(anchor, `read served no row for ${JSON.stringify(matrixCase.from)}`).toBeDefined();

        if (matrixCase.readWarning === undefined) {
          expect.soft(countOf(readText, MIXED_MARK), "a uniform file discloses nothing").toBe(0);
        } else {
          expect
            .soft(
              readText.endsWith(`\n\n${matrixCase.readWarning}`),
              `read text did not end on ${JSON.stringify(matrixCase.readWarning)}`,
            )
            .toBe(true);
          expect.soft(countOf(readText, MIXED_MARK)).toBe(1);
        }

        const editText = textOf(
          await harness.editTool.execute("e1", {
            path: "t.txt",
            anchor_from: anchor!,
            anchor_to: anchor!,
            replace_with: matrixCase.to,
          }),
        );

        expect.soft(await readFile(path, "utf-8"), "post-edit bytes").toBe(matrixCase.postEdit);

        if (matrixCase.editWarning === undefined) {
          expect
            .soft(countOf(editText, REWRITTEN_MARK), "nothing changed, so nothing is claimed")
            .toBe(0);
        } else {
          expect.soft(editText, "applied warning").toContain(matrixCase.editWarning);
          expect.soft(countOf(editText, REWRITTEN_MARK)).toBe(1);
        }

        const undoText = textOf(await harness.undoTool.execute("u1", { path: "t.txt" }));

        expect.soft(await readFile(path, "utf-8"), "post-undo bytes").toBe(matrixCase.postUndo);

        if (matrixCase.undoClause === undefined) {
          expect
            .soft(undoText, "a uniform revert must not claim a mixture")
            .not.toContain("Restored at");
        } else {
          expect.soft(undoText, "undo mixture clause").toContain(matrixCase.undoClause);
        }
        expect.soft(undoText, "undo must not fail").not.toContain("[E_");
      });
    });
  }
});

/** One rung of the config ladder: what is in the environment, what is in the config file. */
interface LadderCase {
  readonly name: string;
  readonly original: string;
  readonly env: string | undefined;
  readonly config: "AUTO" | "LF" | "CRLF" | "CR" | undefined;
  /** The ending name both disclosures must spell, or `undefined` when neither may appear. */
  readonly warningEnding: string | undefined;
  /** The rung-spelling both disclosures must name: `env`, `config`, `file` or `system`. */
  readonly source: "env" | "config" | "file" | "system";
  /** The bytes the edit leaves on disk. */
  readonly postEdit: string;
}

const MIXED_LADDER_FILE = "alpha\r\nbeta\ngamma\r\n";

const LADDER: readonly LadderCase[] = [
  {
    name: "AUTO, no env and no config: the file's dominant ending wins",
    original: MIXED_LADDER_FILE,
    env: undefined,
    config: undefined,
    warningEnding: "CRLF",
    source: "file",
    postEdit: "ALPHA\r\nbeta\r\ngamma\r\n",
  },
  {
    name: "config LF overrides the file",
    original: MIXED_LADDER_FILE,
    env: undefined,
    config: "LF",
    warningEnding: "LF",
    source: "config",
    postEdit: "ALPHA\nbeta\ngamma\n",
  },
  {
    name: "env AUTO stops the ladder: config LF is ignored",
    original: MIXED_LADDER_FILE,
    env: "AUTO",
    config: "LF",
    warningEnding: "CRLF",
    source: "file",
    postEdit: "ALPHA\r\nbeta\r\ngamma\r\n",
  },
  {
    name: "env LF overrides the file",
    original: MIXED_LADDER_FILE,
    env: "LF",
    config: undefined,
    warningEnding: "LF",
    source: "env",
    postEdit: "ALPHA\nbeta\ngamma\n",
  },
  {
    name: "env CR beats config LF",
    original: MIXED_LADDER_FILE,
    env: "CR",
    config: "LF",
    warningEnding: "CR",
    source: "env",
    postEdit: "ALPHA\rbeta\rgamma\r",
  },
  {
    name: "config CR beats the file's CRLF majority",
    original: MIXED_LADDER_FILE,
    env: undefined,
    config: "CR",
    warningEnding: "CR",
    source: "config",
    postEdit: "ALPHA\rbeta\rgamma\r",
  },
];

describe("EOL config ladder — one mixed file, every rung that can decide it", () => {
  for (const ladderCase of LADDER) {
    it(ladderCase.name, async () => {
      await withTempFile("t.txt", ladderCase.original, async ({ cwd, path }) => {
        if (ladderCase.config !== undefined) await seedEol(cwd, ladderCase.config);
        if (ladderCase.env !== undefined) process.env.DSH_BETTER_EDIT_EOL = ladderCase.env;

        const harness = setupIntegrationTest(cwd);
        const readText = textOf(await harness.readTool.execute("r1", { path: "t.txt" }));
        const anchor = anchorsByContent(readText).get("alpha");
        expect(anchor).toBeDefined();

        expect
          .soft(readText, "read rung")
          .toContain(`All edits normalize to ${ladderCase.warningEnding} (${ladderCase.source}).`);

        const editText = textOf(
          await harness.editTool.execute("e1", {
            path: "t.txt",
            anchor_from: anchor!,
            anchor_to: anchor!,
            replace_with: "ALPHA",
          }),
        );

        expect.soft(await readFile(path, "utf-8"), "post-edit bytes").toBe(ladderCase.postEdit);
        expect
          .soft(editText, "applied rung")
          .toContain(
            `[MODEL] [W_EOL_REWRITTEN] EOL normalized to ${ladderCase.warningEnding} ` +
              `(${ladderCase.source}):`,
          );
      });
    });
  }

  it("a uniform file stays silent on the read even when a forced rung re-spells it", async () => {
    await withTempFile("t.txt", "alpha\r\nbeta\r\n", async ({ cwd, path }) => {
      await seedEol(cwd, "LF");

      const harness = setupIntegrationTest(cwd);
      const readText = textOf(await harness.readTool.execute("r1", { path: "t.txt" }));
      const anchor = anchorsByContent(readText).get("alpha");
      expect(anchor).toBeDefined();

      expect
        .soft(countOf(readText, MIXED_MARK), "a uniform CRLF file discloses no mixture")
        .toBe(0);

      const editText = textOf(
        await harness.editTool.execute("e1", {
          path: "t.txt",
          anchor_from: anchor!,
          anchor_to: anchor!,
          replace_with: "ALPHA",
        }),
      );

      expect.soft(await readFile(path, "utf-8"), "post-edit bytes").toBe("ALPHA\nbeta\n");
      expect
        .soft(editText, "applied rung")
        .toContain(
          "[MODEL] [W_EOL_REWRITTEN] EOL normalized to LF (config): 2 terminators changed.",
        );
      expect.soft(countOf(editText, REWRITTEN_MARK)).toBe(1);
    });
  });
});
