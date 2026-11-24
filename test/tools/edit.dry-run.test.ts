/**
 * Port of pi-better-edit@56047a30 (downstream #184, parent #145): `dry_run` is a read-only preview —
 * the edit answers with the would-be diff and touches nothing else. No byte write, no undo row, no
 * snapshot/lineage/lease upsert, no served rows, and no noop-loop tally. Added rows therefore print
 * the empty gutter (a dry run commits nothing a later call could honour) while context rows keep the
 * anchors the session already holds. Failures stay the live failures: a dry run is never more
 * permissive than the write it predicts.
 *
 * Downstream deviation: this is a new branch, not a restore. Upstream keeps a `noPersist`/`preview`
 * route in its engine; here ADR-0019 deleted it, so the preview is the `dryRun` gate on the commit
 * steps in `src/mutation.ts` plus the two withheld store writes in `src/mutation/engine.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getText,
  makeExec,
  makeTestSandbox,
  setupIntegrationTest,
  withTempFile,
} from "../support/fixtures.js";
import { ANCHOR_LEN, HASH_SEP, initHasher, lineHashesPure } from "../../src/hashline/index.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { driftReported, loadServed } from "../../src/session-view.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";
import { buildBatchResult } from "../../src/edit-response.js";
import type { BatchSection } from "../../src/edit-response.js";
import { genDiff } from "../../src/edit-diff.js";
import { execute } from "../../src/mutation.js";
import type { PreparedItem } from "../../src/mutation/engine.js";
import { localIO } from "../../src/fs-bridge.js";
import { NOOP_LOOP_THRESHOLD } from "../../src/constants.js";
import { withWorkspace } from "../../src/workspace-context.js";

beforeAll(async () => {
  await initHasher();
});

type Harness = ReturnType<typeof setupIntegrationTest>;
type Tool = {
  execute: (callId: string, params: unknown) => Promise<{ content: Array<{ text?: string }> }>;
};

/** Read through the hashline `read` tool so the anchors are served, then parse the rendered rows. */
async function servedRows(
  harness: Harness,
  path: string,
): Promise<Array<{ hash: string; content: string }>> {
  const res = await harness.readTool.execute("read", { path });
  const rows: Array<{ hash: string; content: string }> = [];
  for (const line of getText(res).split("\n")) {
    const sep = line.indexOf(HASH_SEP);
    if (sep === -1) continue;
    rows.push({ hash: line.slice(0, sep), content: line.slice(sep + 1) });
  }
  return rows;
}

/** The one anchor a hypothetical `+` row would carry, derived from its own line content. */
function hypotheticalAnchor(line: string): string {
  return lineHashesPure(line)[0]!;
}

describe("edit dry_run — zero persistence", () => {
  it("leaves bytes, mtime, undo history, the served mirror and leases untouched", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const absolutePath = await harness.io.resolve("t.txt", cwd, undefined);
      // The hash store is per-workspace, so every direct probe runs inside the workspace context.
      const mirror = () =>
        withWorkspace(cwd, async () =>
          JSON.stringify(await loadServed(harness.sessionKey, absolutePath)),
        );

      const before = {
        bytes: await readFile(path, "utf-8"),
        mtimeMs: (await stat(path)).mtimeMs,
        served: await mirror(),
      };
      expect(before.served, "the serve must have recorded rows to protect").not.toBe("[]");

      const result = await harness.editTool.execute("e1", {
        file: "t.txt",
        dry_run: true,
        edits: [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, replace_with: "B" }],
      });

      expect(await readFile(path, "utf-8"), "a dry run writes no bytes").toBe(content);
      expect((await stat(path)).mtimeMs, "a dry run must not touch the file").toBe(before.mtimeMs);
      expect(await mirror(), "a dry run serves no row").toBe(before.served);

      const undo = await harness.undoTool.execute("u1", { path: "t.txt" });
      expect(getText(undo), "a dry run appends no undo row").toContain("No undo history");

      const lease = await withWorkspace(cwd, async () => {
        const store = (await loadHashStore()) as InternalHashStore;
        return store.leaseFor(harness.sessionKey, absolutePath, hypotheticalAnchor("B"));
      });
      expect(lease, "the hypothetical result anchor must own no lease").toBeUndefined();

      const lineage = await withWorkspace(cwd, async () => {
        const store = (await loadHashStore()) as InternalHashStore;
        return store.lineageFor(absolutePath, snapshotHashFor("a\nB\nc\n"));
      });
      expect(lineage, "no anchor snapshot is persisted for the hypothetical result").toEqual([]);

      const text = getText(result);
      expect(text, "the removed row keeps the old anchor").toMatch(
        new RegExp(`^-${"[A-Za-z0-9]{" + ANCHOR_LEN + "}"}${HASH_SEP}b$`, "m"),
      );
      expect(text, "the hypothetical row is shown").toContain("B");
      expect(text, "the preview never claims its rows went unrecorded").not.toContain(
        "NOT recorded as served",
      );
    });
  });

  it("prints added rows with the empty gutter while context rows keep their anchors", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");

      const result = await harness.editTool.execute("e1", {
        file: "t.txt",
        dry_run: true,
        edits: [
          { anchor_from: served[0]!.hash, anchor_to: served[0]!.hash, replace_with: "a\nNEW" },
        ],
      });

      const text = getText(result);
      expect(text, "an added row renders the empty gutter").toMatch(
        new RegExp(`^\\+ {${ANCHOR_LEN}}${HASH_SEP}NEW$`, "m"),
      );
      expect(text, "a dry run prints no added anchor").not.toMatch(
        new RegExp(`^\\+[A-Za-z0-9]{${ANCHOR_LEN}}${HASH_SEP}`, "m"),
      );
      expect(text, "a context row keeps the anchor the session already holds").toMatch(
        new RegExp(`^ [A-Za-z0-9]{${ANCHOR_LEN}}${HASH_SEP}`, "m"),
      );
      expect(await readFile(path, "utf-8")).toBe(content);
    });
  });

  it("the response projection publishes no rows and marks the details as a dry run", () => {
    const original = "a\nb\nc\n";
    const result = "a\nB\nc\n";
    const served = lineHashesPure(original);
    // The tool seam answers with text only (like `edit.unserved-warning.test.ts`), so the response
    // details are projected through the same builder the tool calls.
    const section: BatchSection = {
      path: "t.txt",
      originalNormalized: original,
      result,
      originalHashes: served,
      resultHashes: lineHashesPure(result),
      warnings: undefined,
      driftNotice: undefined,
      appliedCount: 1,
      noopCount: 0,
      totalAddedLines: 1,
      totalRemovedLines: 1,
      served,
    };

    const preview = buildBatchResult([section], true);
    expect(preview.details.servedRows, "no hypothetical anchor may be published").toEqual([]);
    expect(preview.details.servedByPath, "no hypothetical file entry may be published").toEqual([]);
    expect(preview.details.dryRun, "the payload marks the run as hypothetical").toBe(true);

    const live = buildBatchResult([section]);
    expect(
      live.details.servedRows!.length,
      "a live edit still publishes its anchors",
    ).toBeGreaterThan(0);
    expect(live.details.servedByPath!.length).toBeGreaterThan(0);
    expect("dryRun" in live.details, "a live edit publishes no dryRun marker").toBe(false);
  });

  it("keeps the live path writing and serving its rows", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const absolutePath = await harness.io.resolve("t.txt", cwd, undefined);

      const preview = await harness.editTool.execute("e1", {
        file: "t.txt",
        dry_run: true,
        edits: [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, replace_with: "B" }],
      });
      expect(getText(preview), "the would-be diff is answered").toContain("B");
      expect(await readFile(path, "utf-8")).toBe(content);

      await harness.editTool.execute("e2", {
        file: "t.txt",
        dry_run: false,
        edits: [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, replace_with: "B" }],
      });
      expect(await readFile(path, "utf-8"), "a live edit writes").toBe("a\nB\nc\n");

      const after = await withWorkspace(cwd, () => loadServed(harness.sessionKey, absolutePath));
      expect(after, "a live edit serves the result rows").toContain(hypotheticalAnchor("B"));
      const lineage = await withWorkspace(cwd, async () => {
        const store = (await loadHashStore()) as InternalHashStore;
        return store.lineageFor(absolutePath, snapshotHashFor("a\nB\nc\n"));
      });
      expect(lineage.length, "a live edit persists the result's anchor snapshot").toBeGreaterThan(
        0,
      );
    });
  });
  it("previews two edits in one call without writing or publishing a serve", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const absolutePath = await harness.io.resolve("t.txt", cwd, undefined);
      // Two items take the batch projection, whose `details` never reach the tool's text answer, so
      // the store is read directly: both its own view and the session-view projection must hold.
      const storeServed = () =>
        withWorkspace(cwd, async () => {
          const store = (await loadHashStore()) as InternalHashStore;
          return JSON.stringify(store.getServed(harness.sessionKey, absolutePath));
        });
      const mirror = () =>
        withWorkspace(cwd, async () =>
          JSON.stringify(await loadServed(harness.sessionKey, absolutePath)),
        );

      const before = { store: await storeServed(), served: await mirror() };
      expect(before.served, "the read must have recorded rows to protect").not.toBe("[]");

      const result = await harness.editTool.execute("e1", {
        file: "t.txt",
        dry_run: true,
        edits: [
          { anchor_from: served[0]!.hash, anchor_to: served[0]!.hash, replace_with: "A" },
          { anchor_from: served[2]!.hash, anchor_to: served[2]!.hash, replace_with: "C" },
        ],
      });

      const text = getText(result);
      expect(text, "the first change is answered in the diff").toMatch(
        new RegExp(`^\\+ {${ANCHOR_LEN}}${HASH_SEP}A$`, "m"),
      );
      expect(text, "the second change is answered in the diff").toMatch(
        new RegExp(`^\\+ {${ANCHOR_LEN}}${HASH_SEP}C$`, "m"),
      );
      expect(await readFile(path, "utf-8"), "a multi-item dry run writes no bytes").toBe(content);
      expect(await storeServed(), "a multi-item dry run records no store row").toBe(before.store);
      expect(await mirror(), "a multi-item dry run leaves the served mirror alone").toBe(
        before.served,
      );

      await harness.editTool.execute("e2", {
        file: "t.txt",
        edits: [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, replace_with: "B" }],
      });
      expect(await readFile(path, "utf-8"), "the pre-batch anchors still serve a live edit").toBe(
        "a\nB\nc\n",
      );
    });
  });
});

describe("edit dry_run — the drift scan", () => {
  it("records nothing for a preview and still records the live drift", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const absolutePath = await harness.io.resolve("t.txt", cwd, undefined);
      const mirror = () =>
        withWorkspace(cwd, async () =>
          JSON.stringify(await loadServed(harness.sessionKey, absolutePath)),
        );
      const reported = () =>
        withWorkspace(cwd, async () => [
          ...(await driftReported(harness.sessionKey, absolutePath)),
        ]);
      // A line outside the edited range changed on disk after the read: the classic drift episode.
      // The edit itself still resolves, because the anchor it names still points at its own line.
      await writeFile(path, "a\nb\nCH\n", "utf-8");
      const before = { served: await mirror(), reported: await reported() };

      const preview = await harness.editTool.execute("e1", {
        file: "t.txt",
        dry_run: true,
        edits: [{ anchor_from: served[0]!.hash, anchor_to: served[0]!.hash, replace_with: "A" }],
      });
      expect(getText(preview), "the preview answers the diff").toContain("A");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nCH\n");
      expect(await mirror(), "the scan records no drifted row for the hypothetical result").toBe(
        before.served,
      );
      expect(
        await reported(),
        "the scan marks no episode reported for the hypothetical result",
      ).toEqual(before.reported);

      await harness.editTool.execute("e2", {
        file: "t.txt",
        edits: [{ anchor_from: served[0]!.hash, anchor_to: served[0]!.hash, replace_with: "A" }],
      });
      expect(await readFile(path, "utf-8")).toBe("A\nb\nCH\n");
      expect((await reported()).length, "the live run still reports the drift").toBeGreaterThan(
        before.reported.length,
      );
    });
  });
});

describe("edit dry_run — fail-closed parity with the live path", () => {
  /** `served` is the JSON served mirror after the run: a refusal records real rows in both modes. */
  type Outcome = { message: string; bytes: string; served: string; probe: string | null };
  type BuildArgs = { cwd: string; path: string; harness: Harness };

  /**
   * Run one scenario twice with identical setup, `dry_run: true` then `false`. Two separate temp
   * directories keep the fixtures the same, so a difference can only come from the dry-run wiring.
   * The answer is the full refusal text with the temp cwd redacted: the two runs never share a path,
   * and the inner code (`E_STALE_ANCHOR`, `E_UNKNOWN_ANCHOR`, `ENOENT`) is what must match.
   */
  async function parityRun(input: {
    name: string;
    content: string;
    build: (args: BuildArgs) => Promise<Record<string, unknown>>;
    /** A path the scenario must not create, read after each run. */
    probe?: string;
  }): Promise<{ dry: Outcome; live: Outcome }> {
    const run = async (dryRun: boolean): Promise<Outcome> => {
      let out: Outcome | undefined;
      await withTempFile(input.name, input.content, async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
        const params = await input.build({ cwd, path, harness });
        let failure: unknown;
        try {
          await harness.editTool.execute("e1", { ...params, dry_run: dryRun });
        } catch (error) {
          failure = error;
        }
        const absolutePath = await harness.io.resolve(input.name, cwd, undefined);
        out = {
          message:
            failure === undefined
              ? "success"
              : (failure instanceof Error ? failure.message : String(failure))
                  .split(cwd)
                  .join("<cwd>"),
          bytes: await readFile(path, "utf-8"),
          probe:
            input.probe === undefined
              ? null
              : await readFile(join(cwd, input.probe), "utf-8").catch(() => null),
          // The store is per-workspace, so the mirror probe runs inside the workspace context.
          served: await withWorkspace(cwd, async () =>
            JSON.stringify(await loadServed(harness.sessionKey, absolutePath)),
          ),
        };
      });
      return out!;
    };
    return { dry: await run(true), live: await run(false) };
  }

  it("a stale anchor fails with the same code and writes nothing in both modes", async () => {
    const { dry, live } = await parityRun({
      name: "t.txt",
      content: "a\nb\nc\n",
      build: async ({ harness, path }) => {
        const served = await servedRows(harness, "t.txt");
        await writeFile(path, "a\nDRIFTED\nc\n", "utf-8");
        return {
          file: "t.txt",
          edits: [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, replace_with: "BB" }],
        };
      },
    });

    expect(dry.message, "a stale anchor is refused, not previewed").toContain("[E_STALE_ANCHOR]");
    expect(dry.message, "the dry run answers the live refusal verbatim").toBe(live.message);
    expect(dry.bytes).toBe("a\nDRIFTED\nc\n");
    expect(live.bytes).toBe("a\nDRIFTED\nc\n");
    expect(dry.served, "the refusal records the same real rows in both modes").toBe(live.served);
  });

  it("a never-served anchor fails with the same code and writes nothing in both modes", async () => {
    const { dry, live } = await parityRun({
      name: "t.txt",
      content: "a\nb\nc\n",
      build: async () => ({
        file: "t.txt",
        edits: [
          {
            anchor_from: hypotheticalAnchor("b"),
            anchor_to: hypotheticalAnchor("b"),
            replace_with: "B",
          },
        ],
      }),
    });

    expect(dry.message, "a never-served anchor is refused, not previewed").toContain(
      "[E_UNKNOWN_ANCHOR]",
    );
    expect(dry.message, "the dry run answers the live refusal verbatim").toBe(live.message);
    expect(dry.bytes).toBe("a\nb\nc\n");
    expect(live.bytes).toBe("a\nb\nc\n");
    expect(dry.served, "a rowless refusal records nothing in both modes").toBe(live.served);
  });

  it("a missing file fails with the same code and creates nothing in both modes", async () => {
    const { dry, live } = await parityRun({
      name: "t.txt",
      content: "a\nb\nc\n",
      probe: "ghost.txt",
      build: async () => ({
        file: "ghost.txt",
        edits: [{ anchor_from: "aaa", anchor_to: "aaa", replace_with: "B" }],
      }),
    });

    expect(dry.message, "a missing file is refused, not created").toContain("ENOENT");
    expect(dry.message, "the dry run answers the live refusal verbatim").toBe(live.message);
    expect(dry.probe, "a dry run must not create the missing file").toBeNull();
    expect(live.probe).toBeNull();
    expect(dry.bytes).toBe("a\nb\nc\n");
    expect(live.bytes).toBe("a\nb\nc\n");
    expect(dry.served, "a missing file records no row in both modes").toBe(live.served);
  });
});

describe("edit dry_run — noop loop", () => {
  it("never advances the counter and leaves the live path usable", async () => {
    const content = "aaa\nbbb\nccc\n";
    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const tool = harness.editTool as unknown as Tool;
      const noop = {
        file: "t.txt",
        dry_run: true,
        edits: [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, replace_with: "bbb" }],
      };

      let last: Awaited<ReturnType<Tool["execute"]>> | undefined;
      for (let attempt = 0; attempt < NOOP_LOOP_THRESHOLD + 2; attempt++) {
        last = await tool.execute("e1", noop);
        expect(getText(last), `attempt ${attempt + 1} stays a noop`).toContain(
          "Classification: noop",
        );
      }

      const text = getText(last!);
      expect(text, "a dry-run noop never trips the loop guard").not.toContain("[E_NOOP_LOOP]");
      expect(text, "a dry-run noop never emits the loop warning").not.toContain("[W_NOOP]");
      expect(await readFile(path, "utf-8")).toBe(content);

      const live = await tool.execute("e2", {
        file: "t.txt",
        dry_run: false,
        edits: [{ anchor_from: served[0]!.hash, anchor_to: served[0]!.hash, replace_with: "AAA" }],
      });
      expect(getText(live)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("AAA\nbbb\nccc\n");
    });
  });
  it("leaves a live tally it neither advanced nor cleared", async () => {
    const content = "aaa\nbbb\nccc\n";
    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const tool = harness.editTool as unknown as Tool;
      const noop = {
        file: "t.txt",
        edits: [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, replace_with: "bbb" }],
      };

      // Two LIVE submissions put the tally at 2 — the [W_NOOP] tier, one short of the guard.
      const first = await tool.execute("e1", { ...noop, dry_run: false });
      expect(getText(first), "the first live noop only counts").not.toContain("[W_NOOP]");
      const second = await tool.execute("e2", { ...noop, dry_run: false });
      expect(getText(second), "the second live noop warns").toContain("[W_NOOP]");

      const dry = await tool.execute("e3", { ...noop, dry_run: true });
      const dryText = getText(dry);
      expect(dryText, "the preview still answers as a noop").toContain("Classification: noop");
      expect(dryText, "a dry-run noop never trips the loop guard").not.toContain("[E_NOOP_LOOP]");
      expect(dryText, "a dry-run noop never emits the loop warning").not.toContain("[W_NOOP]");
      expect(await readFile(path, "utf-8")).toBe(content);

      // A mixed preview reaches the applied branch, where the live path clears the tally: the dry run
      // must skip that clear too, or the loop this payload earned would silently forget it.
      const mixed = await tool.execute("e3b", {
        file: "t.txt",
        dry_run: true,
        edits: [
          { anchor_from: served[0]!.hash, anchor_to: served[0]!.hash, replace_with: "AAA" },
          { anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, replace_with: "bbb" },
        ],
      });
      expect(getText(mixed), "the mixed preview answers the applied item").toContain("AAA");
      expect(getText(mixed), "the mixed preview never trips the loop guard").not.toContain(
        "[E_NOOP_LOOP]",
      );
      expect(await readFile(path, "utf-8"), "the mixed preview writes nothing").toBe(content);

      // The tally still stands at 2, so the third LIVE submission is the one the guard refuses: a dry
      // call that cleared it would let this through, and one that advanced it would have refused the
      // preview above.
      await expect(
        tool.execute("e4", { ...noop, dry_run: false }),
        "the live tally survives the preview",
      ).rejects.toThrow(/E_NOOP_LOOP/);
    });
  });
});

describe("edit dry_run — engine and renderer seams", () => {
  it("the engine writes nothing under dryRun and stays live when the flag is omitted", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("t.txt", content, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const served = await servedRows(harness, "t.txt");
      const absolutePath = await harness.io.resolve("t.txt", cwd, undefined);
      const items: PreparedItem[] = [
        {
          index: 0,
          file: "t.txt",
          absolutePath,
          anchor_from: served[1]!.hash,
          anchor_to: served[1]!.hash,
          replace_with: "B",
        },
      ];
      const exec = makeExec(cwd, harness.sessionKey)(undefined);
      const io = localIO();
      const sandbox = makeTestSandbox();

      // The engine resolves the per-workspace store, so the caller supplies the workspace a tool sets.
      const preview = await withWorkspace(cwd, () =>
        execute({
          io,
          items,
          sessionKey: harness.sessionKey,
          exec,
          sandbox,
          sandboxPolicy: undefined,
          dryRun: true,
        }),
      );
      expect(preview, "the engine still answers with the diff").toContain("B");
      expect(await readFile(path, "utf-8"), "the engine must not write").toBe(content);

      await withWorkspace(cwd, () =>
        execute({
          io,
          items,
          sessionKey: harness.sessionKey,
          exec,
          sandbox,
          sandboxPolicy: undefined,
        }),
      );
      expect(await readFile(path, "utf-8"), "an omitted dryRun stays a live edit").toBe(
        "a\nB\nc\n",
      );
    });
  });

  it("genDiff blanks added gutters and serves nothing only when dryRun is set", () => {
    const oldContent = "a\nb\nc\n";
    const nextContent = "a\nb\nNEW\nc\n";
    const oldHashes = lineHashesPure(oldContent);
    const nextHashes = lineHashesPure(nextContent);

    const preview = genDiff(oldContent, nextContent, 1, nextHashes, oldHashes, oldHashes, true);
    expect(preview.servedRows, "a dry run serves no rendered row").toEqual([]);
    expect(preview.diff, "the added row keeps the empty gutter").toMatch(
      new RegExp(`^\\+ {${ANCHOR_LEN}}${HASH_SEP}NEW$`, "m"),
    );
    expect(preview.diff, "a context row keeps its real anchor").toMatch(
      new RegExp(`^ [A-Za-z0-9]{${ANCHOR_LEN}}${HASH_SEP}`, "m"),
    );

    const live = genDiff(oldContent, nextContent, 1, nextHashes, oldHashes, oldHashes);
    expect(live.diff, "the default keeps printing the added anchor").toMatch(
      new RegExp(`^\\+[A-Za-z0-9]{${ANCHOR_LEN}}${HASH_SEP}NEW$`, "m"),
    );
    expect(live.servedRows.length, "the default still serves its rows").toBeGreaterThan(0);
  });
});
