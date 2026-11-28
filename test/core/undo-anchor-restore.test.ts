import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { localIO, type FileIO } from "../../src/fs-bridge.js";
import { withWorkspace } from "../../src/workspace-context.js";
import {
  extractHash,
  getText,
  setupIntegrationTest,
  withTempBytes,
  withTempFile,
} from "../support/fixtures.js";

/**
 * #111 — undo restores the pre-edit anchor strings (ADR-0017 reversal).
 *
 * `read → edit → undo` must hand back the anchors the restored lines carried before
 * the edit: the restore is byte-identical, so the assignment is the same assignment.
 * Retirement moves with the restore — revived anchors are un-retired, the superseded
 * post-edit assignment stays retired, and an anchor whose line does not come back
 * stays retired.
 */

const ANCHOR_ROW = /^\+([A-Za-z0-9]{3})│(.*)$/;

beforeAll(async () => {
  await initHasher();
});

async function internalStore(): Promise<InternalHashStore> {
  return (await loadHashStore()) as InternalHashStore;
}

/**
 * `localIO`'s decoder strips a UTF-8 BOM (`test/core/fs-bridge.encoding.test.ts`
 * pins that); the production `ctxFsIO` restores it on read. Model the production
 * bridge so the undo round-trip is measured against BOM-bearing reads.
 */
function bomBearingIO(): FileIO {
  const base = localIO();
  return {
    ...base,
    async readText(absolutePath, signal, encodingHint) {
      const text = await base.readText(absolutePath, signal, encodingHint);
      const bytes = await readFile(absolutePath);
      const startsWithBom =
        bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      return startsWithBom ? `\uFEFF${text}` : text;
    },
  };
}

function servedAnchor(text: string, line: string): string {
  const row = text.split("\n").find((entry) => entry.endsWith(`│${line}`));
  expect(row).toBeDefined();
  return extractHash(row!);
}

function addedAnchor(text: string, line: string): string {
  for (const row of text.split("\n")) {
    const match = ANCHOR_ROW.exec(row);
    if (match?.[2] === line) return match[1]!;
  }
  throw new Error(`no added diff row for ${JSON.stringify(line)}`);
}

async function leaseRetired(
  cwd: string,
  path: string,
  sessionKey: string,
  anchor: string,
): Promise<boolean | undefined> {
  return withWorkspace(cwd, async () => {
    const store = await internalStore();
    return store.leaseFor(sessionKey, path, anchor)?.retiredAt !== null;
  });
}

describe("undo restores the pre-edit anchors", () => {
  it("the issue repro: aaa/bbb/ccc → edit line 2 → undo hands back the original anchor", async () => {
    const original = "aaa\nbbb\nccc\n";

    await withTempFile("undo-repro.txt", original, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", { path: "undo-repro.txt" });
      const bbbAnchor = servedAnchor(getText(read), "bbb");

      await harness.editTool.execute("edit", {
        path: "undo-repro.txt",
        anchor_from: bbbAnchor,
        anchor_to: bbbAnchor,
        replace_with: "BBB",
      });

      const undone = await harness.undoTool.execute("undo", { path: "undo-repro.txt" });
      const undoneText = getText(undone);
      const restoredRow = undoneText
        .split("\n")
        .map((row) => ANCHOR_ROW.exec(row))
        .find((match) => match?.[2] === "bbb");

      expect(restoredRow?.[1]).toBe(bbbAnchor);
      expect(undoneText).toContain("original anchors");
      expect(await readFile(path, "utf8")).toBe(original);

      const reread = await harness.readTool.execute("read", { path: "undo-repro.txt" });
      expect(servedAnchor(getText(reread), "bbb")).toBe(bbbAnchor);
    });
  });

  it("restores bytes exactly — BOM and CRLF included", async () => {
    const originalBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("aaa\r\nbbb\r\nccc\r\n", "utf8"),
    ]);

    await withTempBytes("undo-bytes.txt", originalBytes, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd, bomBearingIO());
      const read = await harness.readTool.execute("read", { path: "undo-bytes.txt" });
      const bbbAnchor = servedAnchor(getText(read), "bbb");

      await harness.editTool.execute("edit", {
        path: "undo-bytes.txt",
        anchor_from: bbbAnchor,
        anchor_to: bbbAnchor,
        replace_with: "BBB",
      });
      const undo = await harness.undoTool.execute("undo", { path: "undo-bytes.txt" });

      expect(getText(undo)).toContain(`+${bbbAnchor}│bbb`);
      expect((await readFile(path)).equals(originalBytes)).toBe(true);
    });
  });

  it("revives restored assignments and keeps the edit's added line retired", async () => {
    const original = "alpha\nbeta\n";

    await withTempFile("undo-added.txt", original, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const abs = await harness.io.resolve("undo-added.txt", cwd, new AbortController().signal);
      const read = await harness.readTool.execute("read", { path: "undo-added.txt" });
      const readText = getText(read);
      const alphaAnchor = servedAnchor(readText, "alpha");
      const betaAnchor = servedAnchor(readText, "beta");

      const edited = await harness.editTool.execute("edit", {
        path: "undo-added.txt",
        anchor_from: betaAnchor,
        anchor_to: betaAnchor,
        replace_with: "beta\nextra",
      });
      const extraAnchor = addedAnchor(getText(edited), "extra");
      expect(extraAnchor).not.toBe(betaAnchor);
      expect(await leaseRetired(cwd, abs, harness.sessionKey, extraAnchor)).toBe(false);

      await harness.undoTool.execute("undo", { path: "undo-added.txt" });
      expect(await readFile(path, "utf8")).toBe(original);

      await withWorkspace(cwd, async () => {
        const store = await internalStore();
        const retired = store.getRetiredAnchors(harness.sessionKey, abs);
        expect(retired.has(betaAnchor)).toBe(false);
        expect(retired.has(alphaAnchor)).toBe(false);
        expect(store.leaseFor(harness.sessionKey, abs, betaAnchor)?.retiredAt).toBeNull();
        expect(retired.has(extraAnchor)).toBe(true);
        expect(store.leaseFor(harness.sessionKey, abs, extraAnchor)?.retiredAt).not.toBeNull();
        expect(store.getSnapshot(abs, original)).toEqual([alphaAnchor, betaAnchor]);
      });
    });
  });

  it("a stale post-edit handle is rejected; the restored handle chains without a re-read", async () => {
    const original = "aaa\nbbb\nccc\n";

    await withTempFile("undo-chain.txt", original, async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const read = await harness.readTool.execute("read", { path: "undo-chain.txt" });
      const bbbAnchor = servedAnchor(getText(read), "bbb");

      const edited = await harness.editTool.execute("edit", {
        path: "undo-chain.txt",
        anchor_from: bbbAnchor,
        anchor_to: bbbAnchor,
        replace_with: "BBB",
      });
      const supersededAnchor = addedAnchor(getText(edited), "BBB");
      expect(supersededAnchor).not.toBe(bbbAnchor);

      const undone = await harness.undoTool.execute("undo", { path: "undo-chain.txt" });
      const restoredRowText = getText(undone)
        .split("\n")
        .find((row) => ANCHOR_ROW.exec(row)?.[2] === "bbb");
      if (restoredRowText === undefined) throw new Error("undo diff omitted the restored line");
      const restoredAnchor = ANCHOR_ROW.exec(restoredRowText)?.[1];
      if (restoredAnchor === undefined) throw new Error("undo diff row carried no anchor");
      expect(restoredAnchor).toBe(bbbAnchor);

      await expect(
        harness.editTool.execute("stale", {
          path: "undo-chain.txt",
          anchor_from: supersededAnchor,
          anchor_to: supersededAnchor,
          replace_with: "nope",
        }),
      ).rejects.toThrow(/E_STALE_ANCHOR/);

      await harness.editTool.execute("chained", {
        path: "undo-chain.txt",
        anchor_from: restoredAnchor,
        anchor_to: restoredAnchor,
        replace_with: "beta",
      });
      expect(await readFile(path, "utf8")).toBe("aaa\nbeta\nccc\n");
    });
  });
});
