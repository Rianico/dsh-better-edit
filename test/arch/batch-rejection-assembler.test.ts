import { readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain-errors.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { lineHashesPure } from "../../src/hashline/index.js";
import { throwBatchRejection } from "../../src/mutation/batch-rejection.js";
import { loadServed } from "../../src/session-view.js";
import { sessionKeyFor, withWorkspace } from "../../src/workspace-context.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

/**
 * Batch-rejection assembler ratchet (#215, spec #214): build-then-record-then-throw runs in
 * exactly one place (the seam), the verdict literal is produced in exactly one place (the
 * registry formatter), and every seam call carries a recorder. Detection is literal: the
 * scanner sees whole-line tokens and symbol names, not a verdict assembled by concatenation.
 */
function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

function hitsOf(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of tsFiles("src")) {
    for (const [index, line] of readFileSync(file, "utf-8").split("\n").entries()) {
      if (pattern.test(line)) hits.push(`${file}:${index + 1}`);
    }
  }
  return hits;
}

function fileOf(hit: string): string {
  return hit.replace(/:\d+$/, "");
}

function callEnd(source: string, openParen: number): number {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced parens");
}

function enclosingFunction(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const matches = [...before.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  const last = matches[matches.length - 1];
  if (last?.[1] === undefined) throw new Error("no enclosing function");
  return last[1];
}

function seamCalls(): { file: string; fn: string; hasRecord: boolean }[] {
  const calls: { file: string; fn: string; hasRecord: boolean }[] = [];
  for (const file of tsFiles("src")) {
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(/throwBatchRejection\(/g)) {
      const offset = match.index ?? 0;
      if (/function\s*$/.test(source.slice(0, offset))) continue;
      const body = source.slice(offset, callEnd(source, offset + "throwBatchRejection".length));
      calls.push({
        file,
        fn: enclosingFunction(source, offset),
        hasRecord: /\brecord\s*:/.test(body),
      });
    }
  }
  return calls;
}

const SEAM = "src/mutation/batch-rejection.ts";

describe("batch rejection assembler (#215)", () => {
  it("defines the assembler exactly once, in the mutation seam", () => {
    expect(hitsOf(/^(?:export )?async function throwBatchRejection\(/).map(fileOf)).toEqual([SEAM]);
  });

  it("builds the Batch rejected: verdict in exactly one place in src/", () => {
    expect(hitsOf(/Batch rejected:/).map(fileOf)).toEqual(["src/domain-errors.ts"]);
  });

  it("constructs the E_BATCH_ABORT envelope only inside the seam", () => {
    const files = [...new Set(hitsOf(/new DomainError\("E_BATCH_ABORT"/).map(fileOf))];
    expect(files).toEqual([SEAM]);
  });

  it("records rejection rows at exactly one call site, inside the seam", () => {
    expect(hitsOf(/await recordRejectionRows\(/).map(fileOf)).toEqual([SEAM]);
  });

  it("keeps the deleted predecessors deleted", () => {
    expect(hitsOf(/\b(?:collectAbortPart|buildBatchAbort|AbortPart)\b/)).toEqual([]);
  });

  it("pins the seam-call set: four engine sites, every one with a recorder", () => {
    expect(seamCalls().map((call) => `${call.file}#${call.fn}`)).toEqual([
      "src/mutation/engine.ts#runFileEdits",
      "src/mutation/engine.ts#runFileEdits",
      "src/mutation/engine.ts#runFileEdits",
      "src/mutation/engine.ts#runFileEdits",
    ]);
    expect(seamCalls().filter((call) => !call.hasRecord)).toEqual([]);
  });

  it("throws TypeError, never a silent skip, when rows arrive with no recorder", async () => {
    const error = new DomainError("E_STALE_RANGE", {
      headline: "line 2 drifted",
      servedRows: [{ position: 1, hash: "abcd" }],
      servedBlock: "abcd│beta",
      cause: "served-range staleness",
    });
    await expect(
      throwBatchRejection({ failures: [{ index: 0, error }], total: 2, path: "s.txt" }),
    ).rejects.toThrow(TypeError);
    await expect(
      throwBatchRejection({ failures: [{ index: 0, error }], total: 2, path: "s.txt" }),
    ).rejects.toThrow(/must record them/);
  });

  it("renders the verdict for a rowless batch and throws the bare error at arity one", async () => {
    const rowless = (): DomainError =>
      new DomainError("E_MALFORMED_ANCHOR", { rawAnchor: "ZZ", reason: "bad" });
    await expect(
      throwBatchRejection({ failures: [{ index: 0, error: rowless() }], total: 2, path: "s.txt" }),
    ).rejects.toThrow(
      "[TO MODEL] [E_BATCH_ABORT] Batch rejected: 1 of 2 edits failed; nothing was written.",
    );
    const bare = rowless();
    await expect(
      throwBatchRejection({ failures: [{ index: 0, error: bare }], total: 1, path: "s.txt" }),
    ).rejects.toBe(bare);
  });
});

describe("recorder seam", () => {
  beforeAll(async () => {
    await initHasher();
  });

  it("records once per row-carrying failure and the ledger shows both windows", async () => {
    await withTempFile(
      "seam-ledger.txt",
      "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n",
      async ({ cwd, path }) => {
        const harness = setupIntegrationTest(cwd);
        const fullKey = sessionKeyFor(harness.sessionKey);
        const read = getText(await harness.readTool.execute("read", { path: "seam-ledger.txt" }));
        const anchors = read
          .split("\n")
          .filter((line) => line.includes("│"))
          .map((line) => line.split("│")[0]!);
        expect(anchors).toHaveLength(6);

        // One external write changes an interior line of each span. Both items then reject in the
        // pre-pass with a row-carrying `E_STALE_RANGE` evaluated against the committed snapshot, so
        // no buffer shift applies and each echoes its own current region (positions 0-2 and 3-5).
        const disk = "alpha\nBETA\ngamma\ndelta\nEPSILON\nzeta\n";
        await writeFile(path, disk, "utf-8");

        let message = "";
        try {
          await harness.editTool.execute("seam-ledger", {
            file: "seam-ledger.txt",
            edits: [
              { anchor_from: anchors[0]!, anchor_to: anchors[2]!, replace_with: "X" },
              { anchor_from: anchors[3]!, anchor_to: anchors[5]!, replace_with: "Y" },
            ],
          });
          expect.unreachable();
        } catch (error) {
          message = String((error as Error).message);
        }

        expect(message).toMatch(/Batch rejected: 2 of 2 edits failed; nothing was written\./);
        expect(message).toContain("- edits[0] (seam-ledger.txt) [E_STALE_RANGE]:");
        expect(message).toContain("- edits[1] (seam-ledger.txt) [E_STALE_RANGE]:");

        // The recorder ran once per failure: both windows are now the current file's rows.
        const current = lineHashesPure(disk.trimEnd());
        const mirror = await withWorkspace(cwd, () => loadServed(fullKey, path));
        expect(mirror.slice(0, 3)).toEqual(current.slice(0, 3));
        expect(mirror.slice(3, 6)).toEqual(current.slice(3, 6));
        expect(await readFile(path, "utf-8")).toBe(disk);
      },
    );
  });
});
