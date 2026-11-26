/**
 * #145 / #185 — `dry_run` is a preview, not a write: the end-to-end acceptance matrix.
 *
 * The admission half (#183) and the execution half (#184) are only trustworthy together if the
 * disclosure the model reads matches the bytes that did (not) land. This spec drives `read`, `edit`
 * and `undo_last_edit` through their tool seams — never the engine — and pins five columns:
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { ANCHOR_LEN, HASH_SEP, initHasher } from "../../src/hashline/index.js";
import { loadServed } from "../../src/session-view.js";
import { withWorkspace } from "../../src/workspace-context.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

type Harness = ReturnType<typeof setupIntegrationTest>;

/** Every rendered diff row: the +/-/space prefix, the gutter, and the content the anchor maps to. */
type DiffRow = { prefix: string; anchor: string; content: string };

const DIFF_ROW = new RegExp(
  `^([ +-])([A-Za-z0-9]{${ANCHOR_LEN}}| {${ANCHOR_LEN}})${HASH_SEP}(.*)$`,
);

/** Read through the hashline tool so the anchors are served, then parse the rendered rows. */
async function servedRows(
  harness: Harness,
  file: string,
): Promise<Array<{ hash: string; content: string }>> {
  const res = await harness.readTool.execute("read", { path: file });
  const rows: Array<{ hash: string; content: string }> = [];
  for (const line of getText(res).split("\n")) {
    const sep = line.indexOf(HASH_SEP);
    if (sep === -1) continue;
    rows.push({ hash: line.slice(0, sep), content: line.slice(sep + 1) });
  }
  return rows;
}

/** The diff rows of a tool answer, dropping the summary, warnings and marker lines. */
function diffRows(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of text.split("\n")) {
    const match = DIFF_ROW.exec(line);
    if (match === null) continue;
    rows.push({ prefix: match[1]!, anchor: match[2]!, content: match[3]! });
  }
  return rows;
}

/** The row identity independent of the anchor: a preview and a live edit must agree here. */
function rowKey(row: DiffRow): string {
  return `${row.prefix}${row.content}`;
}

describe("edit dry_run — disclosure acceptance", () => {
  it("previews a multi-range edit with a [DRY RUN] header and the live diff's rows", async () => {
    const content = "one\ntwo\nthree\nfour\nfive\n";
    let previewText = "";
    let previewRows: DiffRow[] = [];

    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const before = await stat(path);

      const result = await harness.editTool.execute("e1", {
        file: "t.txt",
        dry_run: true,
        edits: [
          { anchor_from: served[0]!.hash, anchor_to: served[0]!.hash, replace_with: "ONE" },
          { anchor_from: served[4]!.hash, anchor_to: served[4]!.hash, replace_with: "FIVE" },
        ],
      });

      previewText = getText(result);
      previewRows = diffRows(previewText);
      const bytes = await readFile(path, "utf-8");
      const after = await stat(path);
      const undo = await harness.undoTool.execute("u1", { path: "t.txt" });

      expect
        .soft(previewText.split("\n")[0], "the preview leads with the dry-run header")
        .toMatch(/^\[DRY RUN\] /);
      expect
        .soft(previewText, "the header says the edit was not applied")
        .toContain("would be applied");
      expect.soft(bytes, "a multi-range preview writes no bytes").toBe(content);
      expect
        .soft(after.mtimeMs, "a multi-range preview must not touch the file")
        .toBe(before.mtimeMs);
      expect.soft(getText(undo), "a preview appends no undo row").toContain("No undo history");
    });

    let liveText = "";
    let liveRows: DiffRow[] = [];
    let servedByContent = new Map<string, string>();

    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      servedByContent = new Map(served.map((row) => [row.content, row.hash]));

      const result = await harness.editTool.execute("e1", {
        file: "t.txt",
        dry_run: false,
        edits: [
          { anchor_from: served[0]!.hash, anchor_to: served[0]!.hash, replace_with: "ONE" },
          { anchor_from: served[4]!.hash, anchor_to: served[4]!.hash, replace_with: "FIVE" },
        ],
      });

      liveText = getText(result);
      liveRows = diffRows(liveText);
      expect
        .soft(await readFile(path, "utf-8"), "the live control writes")
        .toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    });

    expect
      .soft(liveText, "the live control keeps the live wording")
      .toContain("Successfully edited");
    expect
      .soft(previewRows.map(rowKey), "the preview serves the same rows the write would, in order")
      .toEqual(liveRows.map(rowKey));
    const previewEchoed = previewRows.filter((row) => row.prefix !== "+");
    expect
      .soft(previewEchoed.length, "the preview keeps the context and removed rows")
      .toBeGreaterThan(0);
    expect
      .soft(
        previewEchoed.every((row) => row.anchor === servedByContent.get(row.content)),
        "a context or removed row keeps the anchor the read served for its content",
      )
      .toBe(true);

    const previewAdded = previewRows.filter((row) => row.prefix === "+");
    const liveAdded = liveRows.filter((row) => row.prefix === "+");
    expect.soft(previewAdded.length, "both diffs show the added rows").toBeGreaterThan(0);
    expect.soft(liveAdded.length, "both diffs show the same added rows").toBe(previewAdded.length);
    expect
      .soft(
        previewAdded.every((row) => row.anchor === " ".repeat(ANCHOR_LEN)),
        "a preview's added rows print the blank gutter",
      )
      .toBe(true);
    expect
      .soft(
        liveAdded.every((row) => new RegExp(`^[A-Za-z0-9]{${ANCHOR_LEN}}$`).test(row.anchor)),
        "the live diff's added rows carry real anchors",
      )
      .toBe(true);
  });

  it("refuses a stale anchor in both modes, names the code, and shows no partial diff", async () => {
    const content = "a\nb\nc\n";

    const run = async (dryRun: boolean): Promise<{ message: string; bytes: string }> => {
      let out: { message: string; bytes: string } | undefined;
      await withTempFile("t.txt", content, async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
        const served = await servedRows(harness, "t.txt");
        await writeFile(path, "a\nDRIFTED\nc\n", "utf-8");

        let failure: unknown;
        try {
          await harness.editTool.execute("e1", {
            file: "t.txt",
            dry_run: dryRun,
            edits: [
              { anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, replace_with: "BB" },
            ],
          });
        } catch (error) {
          failure = error;
        }
        out = {
          message:
            failure === undefined
              ? "success"
              : (failure instanceof Error ? failure.message : String(failure))
                  .split(cwd)
                  .join("<cwd>"),
          bytes: await readFile(path, "utf-8"),
        };
      });
      return out!;
    };

    const dry = await run(true);
    const live = await run(false);

    expect
      .soft(dry.message, "a stale anchor is refused, not previewed")
      .toContain("E_STALE_ANCHOR");
    expect.soft(dry.message, "the dry run answers the live refusal verbatim").toBe(live.message);
    expect.soft(dry.bytes, "a refused preview writes nothing").toBe("a\nDRIFTED\nc\n");
    expect.soft(live.bytes, "the live refusal writes nothing either").toBe("a\nDRIFTED\nc\n");
    expect.soft(dry.message, "a refusal must never carry a partial diff").not.toContain("```diff");
  });

  it("creates no reservation: the served mirror is unchanged across preview and external write", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const absolutePath = await harness.io.resolve("t.txt", cwd, undefined);
      const mirror = () =>
        withWorkspace(cwd, async () =>
          JSON.stringify(await loadServed(harness.sessionKey, absolutePath)),
        );
      const before = await mirror();
      expect(before, "the read recorded rows the preview could reserve").not.toBe("[]");
      const edit = {
        file: "t.txt",
        edits: [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, replace_with: "B" }],
      };

      const preview = await harness.editTool.execute("e1", { ...edit, dry_run: true });
      expect
        .soft(getText(preview).split("\n")[0], "the preview leads with the dry-run header")
        .toMatch(/^\[DRY RUN\] /);
      expect.soft(await readFile(path, "utf-8"), "the preview still wrote nothing").toBe(content);
      expect.soft(await mirror(), "the preview records nothing: no row is reserved").toBe(before);

      await writeFile(path, "a\nb-CHANGED\nc\n", "utf-8");
      expect
        .soft(await mirror(), "the external write alone leaves the mirror unchanged")
        .toBe(before);

      let failure: unknown;
      try {
        await harness.editTool.execute("e2", { ...edit, dry_run: false });
      } catch (error) {
        failure = error;
      }
      expect
        .soft(failure, "the live apply must fail on stale served evidence")
        .toBeInstanceOf(Error);
      expect
        .soft(
          failure instanceof Error ? failure.message : "",
          "the preview reservation would have made this stale anchor usable",
        )
        .toContain("E_STALE_ANCHOR");
      expect
        .soft(await readFile(path, "utf-8"), "the failed live call leaves the external bytes")
        .toBe("a\nb-CHANGED\nc\n");
    });
  });

  it("reports a dry-run noop and leaves the live noop tally untouched", async () => {
    const content = "aaa\nbbb\nccc\n";
    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const noop = {
        file: "t.txt",
        edits: [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, replace_with: "bbb" }],
      };

      const firstDry = await harness.editTool.execute("e1", { ...noop, dry_run: true });
      const secondDry = await harness.editTool.execute("e2", { ...noop, dry_run: true });
      for (const [label, result] of [
        ["first", firstDry],
        ["second", secondDry],
      ] as const) {
        const text = getText(result);
        expect
          .soft(text.split("\n")[0], `${label} preview leads with the dry-run header`)
          .toMatch(/^\[DRY RUN\] /);
        expect.soft(text, `${label} preview says nothing would change`).toContain("would be made");
        expect
          .soft(text, `${label} preview classifies as a noop`)
          .toContain("Classification: noop");
      }
      expect.soft(await readFile(path, "utf-8"), "the previews write nothing").toBe(content);

      const firstLive = await harness.editTool.execute("e3", { ...noop, dry_run: false });
      const secondLive = await harness.editTool.execute("e4", { ...noop, dry_run: false });
      expect
        .soft(
          getText(firstLive),
          "the first live noop is tally count 1: the previews never advanced it",
        )
        .not.toContain("[E_NOOP_LOOP]");
      expect
        .soft(getText(firstLive), "tally count 1 is still below the warning tier")
        .not.toContain("[W_NOOP]");
      expect
        .soft(
          getText(secondLive),
          "the second live noop is tally count 2, still below the threshold",
        )
        .not.toContain("[E_NOOP_LOOP]");
      expect.soft(getText(secondLive), "count 2 reaches the warning tier").toContain("[W_NOOP]");
      expect.soft(await readFile(path, "utf-8"), "no noop writes bytes").toBe(content);
    });
  });

  it("keeps the EOL rewrite notice live-only: a preview makes no terminator promise", async () => {
    const mixed = "alpha\r\nbeta\ngamma\r\n";
    const edit = (hash: string) => ({
      file: "t.txt",
      edits: [{ anchor_from: hash, anchor_to: hash, replace_with: "BETA" }],
    });

    let previewText = "";
    await withTempFile("t.txt", mixed, async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const result = await harness.editTool.execute("e1", {
        ...edit(served[1]!.hash),
        dry_run: true,
      });
      previewText = getText(result);
      expect
        .soft(previewText.split("\n")[0], "the preview still answers the would-be diff")
        .toMatch(/^\[DRY RUN\] /);
    });

    let liveText = "";
    await withTempFile("t.txt", mixed, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const result = await harness.editTool.execute("e1", edit(served[1]!.hash));
      liveText = getText(result);
      expect
        .soft(await readFile(path, "utf-8"), "the live control normalizes the file")
        .toBe("alpha\r\nBETA\r\ngamma\r\n");
    });

    expect
      .soft(previewText, "a preview writes no bytes, so it promises no terminator")
      .not.toContain("W_EOL_REWRITTEN");
    expect
      .soft(previewText, "the preview leaves the terminator rewrite it would trigger unsaid")
      .not.toMatch(/would be (?:normalized|rewritten|re-?spelled)/i);
    expect
      .soft(liveText, "the live control discloses the terminator it decided")
      .toContain("W_EOL_REWRITTEN");
  });
});
