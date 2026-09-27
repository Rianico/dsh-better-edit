import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { loadHashStore, loadServedStore } from "../../src/hash-store.js";
import { withWorkspace } from "../../src/workspace-context.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

describe("retired hash anchors", () => {
  it("rejects a stale anchor instead of rebinding it to later identical text", async () => {
    const initial = "  show: true,\n  items: [],\n";

    await withTempFile("config.ts", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "config.ts" });
      const rows = getText(read).split("\n");
      const staleAnchor = extractHash(rows.find((line) => line.endsWith("│  show: true,"))!);
      const itemsAnchor = extractHash(rows.find((line) => line.endsWith("│  items: [],"))!);

      await editTool.execute("free-anchor", {
        path: "config.ts",
        anchor_from: staleAnchor,
        anchor_to: staleAnchor,
        replace_with: "  enabled: true,",
      });
      await editTool.execute("insert-identical", {
        path: "config.ts",
        anchor_from: itemsAnchor,
        anchor_to: itemsAnchor,
        replace_with: "  items: [],\n  show: true,",
      });

      const expected = "  enabled: true,\n  items: [],\n  show: true,\n";
      expect(await readFile(path, "utf-8")).toBe(expected);
      await withWorkspace(cwd, async () => {
        const store = await loadServedStore();
        expect(store.getRetiredAnchors("test-session", path)).toContain(staleAnchor);
      });

      await expect(
        editTool.execute("reuse-stale", {
          path: "config.ts",
          anchor_from: staleAnchor,
          anchor_to: staleAnchor,
          replace_with: "  show: false,",
        }),
      ).rejects.toThrow(/E_STALE_ANCHOR|E_STALE_RANGE/);
      expect(await readFile(path, "utf-8")).toBe(expected);
    });
  });

  it("keeps retired anchors through a partial read and clears them after a full read", async () => {
    const initial = "one\ntwo\nthree\nfour\n";

    await withTempFile("pages.txt", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "pages.txt" });
      const staleAnchor = extractHash(
        getText(read)
          .split("\n")
          .find((line) => line.endsWith("│one"))!,
      );

      await editTool.execute("edit", {
        path: "pages.txt",
        anchor_from: staleAnchor,
        anchor_to: staleAnchor,
        replace_with: "ONE",
      });
      await readTool.execute("partial", {
        path: "pages.txt",
        offset: 2,
        limit: 1,
      });
      await withWorkspace(cwd, async () => {
        const store = await loadServedStore();
        expect(store.getRetiredAnchors("test-session", path)).toContain(staleAnchor);
      });

      await readTool.execute("full", { path: "pages.txt" });
      await withWorkspace(cwd, async () => {
        const store = await loadServedStore();
        expect(store.getRetiredAnchors("test-session", path)).not.toContain(staleAnchor);
      });
    });
  });

  it("retires a remembered anchor displaced by a partial read", async () => {
    const initial = "show\nitems\n";

    await withTempFile("external.txt", initial, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("read", { path: "external.txt" });
      const staleAnchor = extractHash(
        getText(read)
          .split("\n")
          .find((line) => line.endsWith("│show"))!,
      );

      await writeFile(path, "enabled\nitems\n", "utf-8");
      const partial = await readTool.execute("partial", {
        path: "external.txt",
        offset: 1,
        limit: 1,
      });
      const enabledAnchor = extractHash(
        getText(partial)
          .split("\n")
          .find((line) => line.endsWith("│enabled"))!,
      );
      await withWorkspace(cwd, async () => {
        const store = await loadServedStore();
        expect(store.getRetiredAnchors("test-session", path)).toContain(staleAnchor);
      });

      await editTool.execute("insert", {
        path: "external.txt",
        anchor_from: enabledAnchor,
        anchor_to: enabledAnchor,
        replace_with: "enabled\nshow",
      });
      const expected = "enabled\nshow\nitems\n";
      expect(await readFile(path, "utf-8")).toBe(expected);
      await withWorkspace(cwd, async () => {
        const store = await loadHashStore();
        expect(store.getSnapshot(path, expected)).not.toContain(staleAnchor);
      });
      await expect(
        editTool.execute("stale-after-partial", {
          path: "external.txt",
          anchor_from: staleAnchor,
          anchor_to: staleAnchor,
          replace_with: "wrong",
        }),
      ).rejects.toThrow(/E_STALE_ANCHOR|E_STALE_RANGE/);
    });
  });

  it("undo restores removed content with a fresh anchor", async () => {
    const initial = "  show: true,\n  items: [],\n";

    await withTempFile("undo.ts", initial, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", { path: "undo.ts" });
      const staleAnchor = extractHash(
        getText(read)
          .split("\n")
          .find((line) => line.endsWith("│  show: true,"))!,
      );

      await harness.editTool.execute("edit", {
        path: "undo.ts",
        anchor_from: staleAnchor,
        anchor_to: staleAnchor,
        replace_with: "  enabled: true,",
      });
      const undo = harness.getTool("undo_last_edit") as {
        execute: (
          name: string,
          args: { path: string },
        ) => Promise<{
          content: Array<{ text?: string }>;
        }>;
      };
      const undoResult = await undo.execute("undo", { path: "undo.ts" });
      const restoredLine = getText(undoResult)
        .split("\n")
        .find((line) => line.endsWith("│  show: true,"))!;
      const restoredAnchor = restoredLine.slice(1).split("│")[0]!;

      expect(restoredAnchor).not.toBe(staleAnchor);
      expect(await readFile(path, "utf-8")).toBe(initial);
      await expect(
        harness.editTool.execute("stale-after-undo", {
          path: "undo.ts",
          anchor_from: staleAnchor,
          anchor_to: staleAnchor,
          replace_with: "  show: false,",
        }),
      ).rejects.toThrow(/E_STALE_ANCHOR|E_STALE_RANGE/);
      await harness.editTool.execute("fresh-after-undo", {
        path: "undo.ts",
        anchor_from: restoredAnchor,
        anchor_to: restoredAnchor,
        replace_with: "  show: false,",
      });
      expect(await readFile(path, "utf-8")).toBe("  show: false,\n  items: [],\n");
    });
  });

  it("undo does not move an introduced duplicate's hash onto a surviving line", async () => {
    const initial = "y\nx\n";

    await withTempFile("duplicates.txt", initial, async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", {
        path: "duplicates.txt",
      });
      const rows = getText(read).split("\n");
      const yAnchor = extractHash(rows.find((line) => line.endsWith("│y"))!);
      const survivingXAnchor = extractHash(rows.find((line) => line.endsWith("│x"))!);

      await harness.editTool.execute("duplicate", {
        path: "duplicates.txt",
        anchor_from: yAnchor,
        anchor_to: yAnchor,
        replace_with: "x",
      });

      const undo = harness.getTool("undo_last_edit") as {
        execute: (
          name: string,
          args: { path: string },
        ) => Promise<{
          content: Array<{ text?: string }>;
        }>;
      };
      const undoResult = await undo.execute("undo", {
        path: "duplicates.txt",
      });
      const undoRows = getText(undoResult).split("\n");
      const restoredYAnchor = undoRows
        .find((line) => line.startsWith("+") && line.endsWith("│y"))!
        .slice(1)
        .split("│")[0]!;
      const currentXAnchor = undoRows
        .find((line) => line.startsWith(" ") && line.endsWith("│x"))!
        .slice(1)
        .split("│")[0]!;

      expect(restoredYAnchor).not.toBe(yAnchor);
      expect(currentXAnchor).toBe(survivingXAnchor);
    });
  });

  it("undo does not recycle a hash owned only by the current file", async () => {
    const initial = "old\nsurvivor\n";
    const edited = "new30258\nsurvivor\n";

    await withTempFile("undo-collision.txt", initial, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", {
        path: "undo-collision.txt",
      });
      const oldAnchor = extractHash(
        getText(read)
          .split("\n")
          .find((line) => line.endsWith("│old"))!,
      );
      expect(oldAnchor).toBe("tYt");

      await harness.editTool.execute("collide", {
        path: "undo-collision.txt",
        anchor_from: oldAnchor,
        anchor_to: oldAnchor,
        replace_with: "new30258",
      });
      let currentOnlyAnchor = "";
      await withWorkspace(cwd, async () => {
        const hashStore = await loadHashStore();
        const currentHashes = hashStore.getSnapshot(path, edited)!;
        currentOnlyAnchor = currentHashes[0]!;
        expect(currentOnlyAnchor).toBe("quC");

        const servedStore = await loadServedStore();
        servedStore.deleteServed("test-session", path);
        servedStore.upsertRetiredAnchors("test-session", path, JSON.stringify([oldAnchor]));
      });

      const undo = harness.getTool("undo_last_edit") as {
        execute: (
          name: string,
          args: { path: string },
        ) => Promise<{
          content: Array<{ text?: string }>;
        }>;
      };
      const undoResult = await undo.execute("undo", {
        path: "undo-collision.txt",
      });
      const restoredAnchor = getText(undoResult)
        .split("\n")
        .find((line) => line.startsWith("+") && line.endsWith("│old"))!
        .slice(1)
        .split("│")[0]!;

      expect(restoredAnchor).not.toBe(oldAnchor);
      expect(restoredAnchor).not.toBe(currentOnlyAnchor);
      await withWorkspace(cwd, async () => {
        const store = await loadHashStore();
        expect(store.getSnapshot(path, initial)).not.toContain(currentOnlyAnchor);
      });
    });
  });
});
