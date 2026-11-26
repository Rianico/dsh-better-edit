import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, beforeAll } from "vitest";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { loadServed, recordServed, recordServedTruncated } from "../../src/session-view.js";
import { loadHashStore, upsertSnapshotFor, type InternalHashStore } from "../../src/hash-store.js";
import { sessionKeyFor, withWorkspace } from "../../src/workspace-context.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import {
  canon,
  canonDigest,
  contentChecksum,
  lineHashesPure,
} from "../../src/hashline/hash-assign.js";
import { splitLines } from "../../src/utils.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";

beforeAll(async () => {
  await initHasher();
});

async function internalStore(): Promise<InternalHashStore> {
  return (await loadHashStore()) as InternalHashStore;
}

function fullRows(hashes: string[]): { position: number; hash: string }[] {
  return hashes.map((hash, position) => ({ position, hash }));
}

describe("serve leases — read (full read through readAndServe)", () => {
  it("leases every served anchor to the read snapshot's lineage", async () => {
    await withTempFile("serve-read.txt", "one\ntwo\nthree", async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("serve-read");
      const view = await readAndServe(localIO(), "serve-read.txt", cwd, { sessionKey });
      expect(view.served).toHaveLength(3);
      const anchor = view.served[1]!.hash;
      expect(anchor).toMatch(/^[A-Za-z0-9]{3}$/);
      const store = await internalStore();
      const lease = store.leaseFor(sessionKey, path, anchor);
      expect(lease).toBeDefined();
      expect(lease?.lineId).toBe(2);
      expect(lease?.canonHash).toBe(canonDigest("two"));
      expect(lease?.lineNumber).toBe(2);
      expect(lease?.snapshotHash).toBe(snapshotHashFor("one\ntwo\nthree"));
      expect(lease?.retiredAt).toBeNull();
      const lineage = store.lineageFor(path, lease!.snapshotHash);
      expect(lineage.find((row) => row.anchor === anchor)?.lineId).toBe(lease?.lineId);
    });
  });
});

describe("serve leases — diff (edit-response result through recordServedTruncated)", () => {
  it("binds result rows to the result snapshot", async () => {
    await withTempFile("serve-diff.txt", "one\ntwo\nthree", async ({ path }) => {
      const sessionKey = sessionKeyFor("serve-diff");
      const content = "one\nTWO\nthree";
      const hashes = lineHashesPure(content);
      const store = await internalStore();
      await recordServedTruncated(
        sessionKey,
        path,
        fullRows(hashes),
        3,
        0,
        hashes.map((_, i) => canon(splitLines(content)[i]!)),
        {
          content,
          hashes,
        },
      );
      const lease = store.leaseFor(sessionKey, path, hashes[1]!);
      expect(lease).toBeDefined();
      expect(lease?.canonHash).toBe(canonDigest("TWO"));
      expect(lease?.lineNumber).toBe(2);
      expect(lease?.snapshotHash).toBe(snapshotHashFor(content));
      const lineage = store.lineageFor(path, lease!.snapshotHash);
      expect(lineage.find((row) => row.anchor === hashes[1])?.lineId).toBe(lease?.lineId);
    });
  });
});

describe("serve leases — truncated (served span only)", () => {
  it("leases served anchors; outside-span anchors have no lease", async () => {
    await withTempFile("serve-trunc.txt", "a\nb\nc\nd", async ({ path }) => {
      const sessionKey = sessionKeyFor("serve-trunc");
      const content = "a\nb\nc\nd";
      const hashes = lineHashesPure(content);
      const store = await internalStore();
      await recordServedTruncated(
        sessionKey,
        path,
        [
          { position: 0, hash: hashes[0]! },
          { position: 1, hash: hashes[1]! },
        ],
        4,
        0,
        hashes.map((_, i) => canon(splitLines(content)[i]!)),
        { content, hashes },
      );
      const served = store.leaseFor(sessionKey, path, hashes[0]!);
      expect(served).toBeDefined();
      expect(served?.lineNumber).toBe(1);
      expect(served?.snapshotHash).toBe(snapshotHashFor(content));
      expect(store.leaseFor(sessionKey, path, hashes[3]!)).toBeUndefined();
    });
  });
});

describe("serve leases — undo (tool-undo plumbing directly)", () => {
  it("materializes lineage through upsertSnapshotFor and leases the restored rows", async () => {
    await withTempFile("serve-undo.txt", "alpha\nbeta", async ({ path }) => {
      const sessionKey = sessionKeyFor("serve-undo");
      const undoContent = "alpha\nbeta";
      const restoredHashes = lineHashesPure(undoContent);
      const store = await internalStore();
      await upsertSnapshotFor(
        path,
        contentChecksum(undoContent),
        splitLines(undoContent).length,
        restoredHashes,
        undoContent,
      );
      const lineage = store.lineageFor(path, snapshotHashFor(undoContent));
      expect(lineage).toHaveLength(2);
      await recordServedTruncated(
        sessionKey,
        path,
        fullRows(restoredHashes),
        2,
        0,
        splitLines(undoContent).map((line) => canon(line)),
        { content: undoContent, hashes: restoredHashes },
      );
      const lease = store.leaseFor(sessionKey, path, restoredHashes[0]!);
      expect(lease).toBeDefined();
      expect(lease?.lineId).toBe(1);
      expect(lease?.lineNumber).toBe(1);
      expect(lease?.snapshotHash).toBe(snapshotHashFor(undoContent));
    });
  });
});

describe("serve leases — bind to the named snapshot, never latest", () => {
  it("rows served from v1 resolve through v1's lineage after v2 exists", async () => {
    await withTempFile("serve-bind.txt", "alpha\nbeta\ngamma", async ({ path }) => {
      const sessionKey = sessionKeyFor("serve-bind");
      const store = await internalStore();
      const v1 = "alpha\nbeta\ngamma";
      const v2 = "alpha\nBETA\ngamma";
      const v1hashes = lineHashesPure(v1);
      const v2hashes = lineHashesPure(v2);
      expect(v2hashes[1]).not.toBe(v1hashes[1]);
      await recordServed(sessionKey, path, fullRows(v1hashes), 3, {
        hashes: v1hashes,
        content: v1,
        fullRead: true,
      });
      await recordServed(sessionKey, path, fullRows(v2hashes), 3, {
        hashes: v2hashes,
        content: v2,
        fullRead: true,
      });
      expect(store.leaseFor(sessionKey, path, v1hashes[1]!)?.retiredAt).not.toBeNull();
      await recordServed(sessionKey, path, fullRows(v1hashes), 3, {
        hashes: v1hashes,
        content: v1,
        fullRead: true,
      });
      expect(store.leaseFor(sessionKey, path, v1hashes[1]!)?.retiredAt).toBeNull();
      const reSession = sessionKeyFor("serve-bind-reserve");
      await recordServed(reSession, path, fullRows(v1hashes), 3, {
        hashes: v1hashes,
        content: v1,
        fullRead: true,
      });
      const lease = store.leaseFor(reSession, path, v1hashes[1]!);
      expect(lease).toBeDefined();
      expect(lease?.snapshotHash).toBe(snapshotHashFor(v1));
      expect(lease?.snapshotHash).not.toBe(snapshotHashFor(v2));
      expect(lease?.lineId).toBe(2);
      expect(lease?.lineNumber).toBe(2);
      expect(lease?.canonHash).toBe(canonDigest("beta"));
    });
  });
});

//
//
//
//

const TWIN_FILE =
  "export function alpha() {\n" +
  "  return compute(value);\n" +
  "}\n" +
  "\n" +
  "export function beta() {\n" +
  "  return compute(value);\n" +
  "}\n";
const TWIN_LINE = "  return compute(value);";
const EXTERNAL_DELETE = TWIN_FILE.replace("  return compute(value);\n", "");

const INSERT_FILE = "alpha\nbeta\ngamma\ndelta\n";
const WINDOW_FILE = "alpha\nbeta\ngamma\ndelta\nepsilon\n";

interface Scenario {
  file: string;
  /** Windowed read before READ1 (offset, limit). */
  window?: [number, number];
  /** READ1 is a full read (false = the windowed read IS READ1). */
  fullRead: boolean;
  /** The out-of-band change written between READ1 and the edit. */
  external: string;
  /** Content of the served line whose anchor the rejected edit targets. */
  anchorLine: string;
  replacement: string;
}

const TWIN_SCENARIO: Scenario = {
  file: TWIN_FILE,
  fullRead: true,
  external: EXTERNAL_DELETE,
  anchorLine: TWIN_LINE,
  replacement: "  return changed;",
};
const INSERT_SCENARIO: Scenario = {
  file: INSERT_FILE,
  window: [1, 3],
  fullRead: true,
  external: "alpha\nbetA\ngamma\ndelta\n",
  anchorLine: "beta",
  replacement: "BETA",
};
const WINDOW_SCENARIO: Scenario = {
  file: WINDOW_FILE,
  window: [1, 2],
  fullRead: false,
  external: `beta\n${WINDOW_FILE}`,
  anchorLine: "beta",
  replacement: "BETA",
};

type LeaseRow = {
  snapshotHash: string;
  lineId: number;
  lineNumber: number;
  canonHash: string;
  retiredAt: number | null;
};
type LeaseDump = Record<string, LeaseRow | null>;

interface ScenarioRun {
  read1Anchors: string[];
  /** The served anchor the attempt targets. */
  targetAnchor: string;
  read2Anchors: string[];
  servedBefore: (string | null)[];
  servedAfterReject: (string | null)[];
  leasesBefore: LeaseDump;
  leasesAfterReject: LeaseDump;
  rejected: boolean;
  message: string;
  /** One entry per attempted rejection: true = it rejected. */
  rejections: boolean[];
  /** The file as it stands after the attempt(s) and the fresh read. */
  fileAfter: string;
}

/** Parse the `HASH│content` read rows into the served anchor list. */
function rowAnchors(readText: string): string[] {
  const anchors: string[] = [];
  for (const line of readText.split("\n")) {
    const match = /^([A-Za-z0-9]{3})│/.exec(line);
    if (match) anchors.push(match[1]!);
  }
  return anchors;
}

function duplicateAnchors(anchors: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const anchor of anchors) {
    if (seen.has(anchor)) dupes.add(anchor);
    else seen.add(anchor);
  }
  return [...dupes];
}

function grantOf(row: LeaseRow): Omit<LeaseRow, "retiredAt"> {
  return {
    snapshotHash: row.snapshotHash,
    lineId: row.lineId,
    lineNumber: row.lineNumber,
    canonHash: row.canonHash,
  };
}

/**
 * The rejection granted nothing. With the exterior-rewrite geometry the served line's own
 * bytes changed, so the pipeline's normalization retires THAT lease — the one attributable
 * delta (the same attribution the twin cell spells out). Every other served anchor's row,
 * `retiredAt` included, stays byte-identical, and the target's grant fields do not move.
 */
function expectGrantsUnchangedExceptRetirement(
  before: LeaseDump,
  after: LeaseDump,
  anchors: string[],
  targetAnchor: string,
): void {
  for (const anchor of anchors) {
    const was = before[anchor] ?? null;
    const now = after[anchor] ?? null;
    if (anchor !== targetAnchor) {
      expect(now).toEqual(was);
      continue;
    }
    expect(was).not.toBeNull();
    expect(now).not.toBeNull();
    expect(grantOf(now!)).toEqual(grantOf(was!));
    expect(was!.retiredAt).toBeNull();
    expect(now!.retiredAt).not.toBeNull();
  }
}

async function servedAt(
  cwd: string,
  sessionKey: string,
  absolutePath: string,
): Promise<(string | null)[]> {
  return withWorkspace(cwd, () => loadServed(sessionKey, absolutePath));
}

async function leasesAt(
  cwd: string,
  sessionKey: string,
  absolutePath: string,
  anchors: string[],
): Promise<LeaseDump> {
  return withWorkspace(cwd, async () => {
    const store = (await loadHashStore()) as InternalHashStore;
    const dump: LeaseDump = {};
    for (const anchor of [...new Set(anchors)].sort()) {
      const lease = store.leaseFor(sessionKey, absolutePath, anchor);
      dump[anchor] = lease
        ? {
            snapshotHash: lease.snapshotHash,
            lineId: lease.lineId,
            lineNumber: lease.lineNumber,
            canonHash: lease.canonHash,
            retiredAt: lease.retiredAt,
          }
        : null;
    }
    return dump;
  });
}

/** One scenario run through the tool path. `withRejectedEdit` = TREATMENT. */
async function runScenario(
  scenario: Scenario,
  withRejectedEdit: boolean,
  /** Extra anchors to probe in the pre-READ2 lease dump (learned from a prior run). */
  leaseProbeAnchors: string[] = [],
  /** How many identical rejections to attempt (0 = control, default 1 for a treatment). */
  rejectionCount?: number,
): Promise<ScenarioRun> {
  let run: ScenarioRun | undefined;
  await withTempFile("scenario.txt", scenario.file, async ({ cwd, path }) => {
    const { readTool, editTool, sessionKey } = setupIntegrationTest(cwd);
    const fullKey = sessionKeyFor(sessionKey);

    if (scenario.window) {
      await readTool.execute("windowed", {
        path: "scenario.txt",
        offset: scenario.window[0],
        limit: scenario.window[1],
      });
    }
    const read1 = getText(
      await readTool.execute(
        "read",
        scenario.fullRead
          ? { path: "scenario.txt" }
          : { path: "scenario.txt", offset: scenario.window![0], limit: scenario.window![1] },
      ),
    );
    const read1Anchors = rowAnchors(read1);
    const anchorRow = read1.split("\n").find((line) => line.endsWith(`│${scenario.anchorLine}`));
    if (anchorRow === undefined) {
      throw new Error(`scenario: no served row for ${JSON.stringify(scenario.anchorLine)}`);
    }
    const anchor = extractHash(anchorRow);
    const servedBefore = await servedAt(cwd, fullKey, path);
    const leasesBefore = await leasesAt(cwd, fullKey, path, [
      ...read1Anchors,
      ...leaseProbeAnchors,
    ]);

    await writeFile(path, scenario.external, "utf-8");

    const attempts = rejectionCount ?? (withRejectedEdit ? 1 : 0);
    const rejections: boolean[] = [];
    const messages: string[] = [];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await editTool.execute(`reject-scenario-${attempt}`, {
          path: "scenario.txt",
          anchor_from: anchor,
          anchor_to: anchor,
          replace_with: scenario.replacement,
        });
        rejections.push(false);
        messages.push("");
      } catch (error) {
        rejections.push(true);
        messages.push(String((error as Error).message));
      }
    }
    const rejected = rejections.includes(true);
    const message = messages.find((text) => text !== "") ?? "";
    const servedAfterReject = await servedAt(cwd, fullKey, path);
    const leasesAfterReject = await leasesAt(cwd, fullKey, path, [
      ...read1Anchors,
      ...leaseProbeAnchors,
    ]);
    const read2Anchors = rowAnchors(
      getText(await readTool.execute("read", { path: "scenario.txt" })),
    );
    run = {
      read1Anchors,
      targetAnchor: anchor,
      read2Anchors,
      servedBefore,
      servedAfterReject,
      leasesBefore,
      leasesAfterReject,
      rejected,
      message,
      rejections,
      fileAfter: await readFile(path, "utf-8"),
    };
  });
  if (run === undefined) throw new Error("scenario did not run");
  return run;
}

const NOOP_LOOP_FILE = "one\ntwo\n";
const NOOP_LOOP_EXTERNAL = "one\ntwo\nthree\n";

interface NoopLoopRun {
  read1Anchors: string[];
  read2Anchors: string[];
  /** The payload anchor the guard refused (the echoed row's anchor). */
  anchor: string;
  servedBefore: (string | null)[];
  servedAfterReject: (string | null)[];
  leasesBefore: LeaseDump;
  leasesAfterReject: LeaseDump;
  rejected: boolean;
  message: string;
  fileAfter: string;
}

/**
 * Two applied no-op submissions, an out-of-band insert below the payload's range,
 * then the submission that trips `E_NOOP_LOOP`. `withThirdSubmission` false is the
 * control (same external change, no rejection).
 *
 * `leaseProbeAnchors` widens the pre-READ2 lease dump; the payload's own range is
 * already covered by `read1Anchors`, so this only matters for proving that no
 * *other* anchor gained a lease.
 */
async function runNoopLoop(
  withThirdSubmission: boolean,
  leaseProbeAnchors: string[] = [],
): Promise<NoopLoopRun> {
  let run: NoopLoopRun | undefined;
  await withTempFile("noop-loop.txt", NOOP_LOOP_FILE, async ({ cwd, path }) => {
    const { readTool, editTool, sessionKey } = setupIntegrationTest(cwd);
    const fullKey = sessionKeyFor(sessionKey);
    const read1Text = getText(await readTool.execute("read", { path: "noop-loop.txt" }));
    const read1Anchors = rowAnchors(read1Text);
    const anchorRow = read1Text.split("\n").find((line) => line.endsWith("│one"));
    if (anchorRow === undefined) throw new Error("noop-loop: no served row for `one`");
    const anchor = extractHash(anchorRow);
    const noop = {
      path: "noop-loop.txt",
      anchor_from: anchor,
      anchor_to: anchor,
      replace_with: "one",
    };

    await editTool.execute("noop-1", noop);
    const second = getText(await editTool.execute("noop-2", noop));
    expect(second).toMatch(/\[MODEL\] \[W_NOOP\]/);

    await writeFile(path, NOOP_LOOP_EXTERNAL, "utf-8");

    const servedBefore = await servedAt(cwd, fullKey, path);
    const leasesBefore = await leasesAt(cwd, fullKey, path, [
      ...read1Anchors,
      ...leaseProbeAnchors,
    ]);

    let rejected = false;
    let message = "";
    if (withThirdSubmission) {
      try {
        await editTool.execute("noop-3", noop);
      } catch (error) {
        rejected = true;
        message = String((error as Error).message);
      }
    }
    const servedAfterReject = await servedAt(cwd, fullKey, path);
    const leasesAfterReject = await leasesAt(cwd, fullKey, path, [
      ...read1Anchors,
      ...leaseProbeAnchors,
    ]);
    const read2Anchors = rowAnchors(
      getText(await readTool.execute("read", { path: "noop-loop.txt" })),
    );
    run = {
      read1Anchors,
      read2Anchors,
      anchor,
      servedBefore,
      servedAfterReject,
      leasesBefore,
      leasesAfterReject,
      rejected,
      message,
      fileAfter: await readFile(path, "utf-8"),
    };
  });
  if (run === undefined) throw new Error("noop-loop scenario did not run");
  return run;
}

const BATCH_FILE = "alpha\nbeta\ngamma\ndelta\n";
const BATCH_EXTERNAL = "alpha\nbetA\ngamma\ndelta\n";

interface BatchAbortRun {
  read2Anchors: string[];
  /** Every anchor the first read served. */
  read1Anchors: string[];
  /** The served anchor item 0 targets. */
  targetAnchor: string;
  servedBefore: (string | null)[];
  servedAfterAbort: (string | null)[];
  leasesBefore: LeaseDump;
  leasesAfterAbort: LeaseDump;
  aborted: boolean;
  message: string;
}

/**
 * Two-item batch through `batch_edit`: item 0 (stale `beta`) aborts, item 1
 * (`gamma`) resolves. `withBatch` false is the control (same external change, no
 * batch call). Drives `collectFailure`/`throwBatchRejection` in `runFileEdits`.
 */
async function runBatchAbort(withBatch: boolean): Promise<BatchAbortRun> {
  let run: BatchAbortRun | undefined;
  await withTempFile("batch.txt", BATCH_FILE, async ({ cwd, path }) => {
    const { readTool, getTool, sessionKey } = setupIntegrationTest(cwd);
    const fullKey = sessionKeyFor(sessionKey);
    const read1Text = getText(await readTool.execute("read", { path: "batch.txt" }));
    const read1Anchors = rowAnchors(read1Text);
    const anchorOf = (needle: string): string => {
      const row = read1Text.split("\n").find((line) => line.endsWith(`│${needle}`));
      if (row === undefined) throw new Error(`batch: no served row for ${needle}`);
      return extractHash(row);
    };
    const beta = anchorOf("beta");
    const gamma = anchorOf("gamma");

    await writeFile(path, BATCH_EXTERNAL, "utf-8");

    const servedBefore = await servedAt(cwd, fullKey, path);
    const leasesBefore = await leasesAt(cwd, fullKey, path, read1Anchors);

    let aborted = false;
    let message = "";
    if (withBatch) {
      const batch = getTool("batch_edit") as {
        execute: (callId: string, params: unknown) => Promise<unknown>;
      };
      try {
        await batch.execute("batch-abort", {
          edits: [
            { path: "batch.txt", anchor_from: beta, anchor_to: beta, replace_with: "BETA" },
            { path: "batch.txt", anchor_from: gamma, anchor_to: gamma, replace_with: "GAMMA" },
          ],
        });
      } catch (error) {
        aborted = true;
        message = String((error as Error).message);
      }
    }
    const servedAfterAbort = await servedAt(cwd, fullKey, path);
    const leasesAfterAbort = await leasesAt(cwd, fullKey, path, read1Anchors);
    const read2Anchors = rowAnchors(getText(await readTool.execute("read", { path: "batch.txt" })));
    run = {
      targetAnchor: beta,
      read2Anchors,
      servedBefore,
      servedAfterAbort,
      leasesBefore,
      leasesAfterAbort,
      aborted,
      read1Anchors,
      message,
    };
  });
  if (run === undefined) throw new Error("batch-abort scenario did not run");
  return run;
}

describe("serve leases — a rejected edit is a no-op for the next read", () => {
  it("twin rejection records nothing — served rows byte-identical before/after", async () => {
    const run = await runScenario(TWIN_SCENARIO, true);
    expect(run.rejected).toBe(true);
    expect(run.message).toMatch(/E_STALE_ANCHOR/);
    expect(run.servedAfterReject).toEqual(run.servedBefore);
  });

  it("twin rejection grants nothing — no grant field changes, no new lease appears", async () => {
    const probe = await runScenario(TWIN_SCENARIO, true);
    const run = await runScenario(TWIN_SCENARIO, true, probe.read2Anchors);
    expect(run.read2Anchors).toEqual(probe.read2Anchors);
    expect(run.rejected).toBe(true);
    expect(Object.keys(run.leasesBefore).length).toBeGreaterThan(0);
    for (const anchor of run.read1Anchors) {
      const before = run.leasesBefore[anchor] ?? null;
      const after = run.leasesAfterReject[anchor] ?? null;
      if (before === null) {
        expect(after).toBeNull();
        continue;
      }
      expect(after).not.toBeNull();
      expect(grantOf(after!)).toEqual(grantOf(before));
    }
    for (const anchor of run.read2Anchors) {
      if (run.read1Anchors.includes(anchor)) continue;
      expect(run.leasesAfterReject[anchor] ?? null).toBeNull();
    }
  });

  it("twin rejection → fresh read ≡ control (0 duplicates, no shifted labels)", async () => {
    const control = await runScenario(TWIN_SCENARIO, false);
    const treatment = await runScenario(TWIN_SCENARIO, true);
    expect(treatment.rejected).toBe(true);
    expect(duplicateAnchors(control.read2Anchors)).toEqual([]);
    expect(duplicateAnchors(treatment.read2Anchors)).toEqual([]);
    expect(treatment.read2Anchors).toEqual(control.read2Anchors);
  });

  it("non-twin exterior rewrite of the served line → rejection → fresh read ≡ control", async () => {
    const control = await runScenario(INSERT_SCENARIO, false);
    const treatment = await runScenario(INSERT_SCENARIO, true);
    expect(treatment.rejected).toBe(true);
    expect(duplicateAnchors(control.read2Anchors)).toEqual([]);
    expect(duplicateAnchors(treatment.read2Anchors)).toEqual([]);
    expect(treatment.read2Anchors).toEqual(control.read2Anchors);
    expectGrantsUnchangedExceptRetirement(
      treatment.leasesBefore,
      treatment.leasesAfterReject,
      treatment.read1Anchors,
      treatment.targetAnchor,
    );
  });

  it("non-twin windowed read + insert above the served span → applies on the served anchor (T3)", async () => {
    const treatment = await runScenario(WINDOW_SCENARIO, true);
    expect(treatment.rejected).toBe(false);
    expect(duplicateAnchors(treatment.read2Anchors)).toEqual([]);
    expect(treatment.fileAfter).toBe("beta\nalpha\nBETA\ngamma\ndelta\nepsilon\n");
  });

  it("noop-loop rejection re-serves the echoed row against the current snapshot, next read ≡ control", async () => {
    const control = await runNoopLoop(false);
    const treatment = await runNoopLoop(true, control.read2Anchors);
    expect(treatment.rejected).toBe(true);
    expect(treatment.message).toMatch(/E_NOOP_LOOP/);
    expect(treatment.message).toMatch(/^\[TO MODEL\] \[E_NOOP_LOOP\] identical edit/m);
    expect(treatment.message).not.toContain("- edits[");
    expect(treatment.fileAfter).toBe(NOOP_LOOP_EXTERNAL);
    expect(treatment.read2Anchors).toEqual(control.read2Anchors);
    expect(treatment.servedAfterReject).toEqual(treatment.servedBefore);
    const echoed = treatment.leasesAfterReject[treatment.anchor];
    expect(echoed?.snapshotHash).toBe(snapshotHashFor(NOOP_LOOP_EXTERNAL));
    expect(echoed?.retiredAt).toBeNull();
    const others = (dump: LeaseDump): LeaseDump =>
      Object.fromEntries(Object.entries(dump).filter(([key]) => key !== treatment.anchor));
    expect(others(treatment.leasesAfterReject)).toEqual(others(treatment.leasesBefore));
    expect(duplicateAnchors(control.read2Anchors)).toEqual([]);
    expect(duplicateAnchors(treatment.read2Anchors)).toEqual([]);
  });
  it("consecutive rejections compose — an exterior rewrite rejected twice leaves served rows and grants byte-identical", async () => {
    const control = await runScenario(INSERT_SCENARIO, false);
    const treatment = await runScenario(INSERT_SCENARIO, true, control.read2Anchors, 2);
    expect(treatment.rejections).toEqual([true, true]);
    expect(treatment.read2Anchors).toEqual(control.read2Anchors);
    expect(treatment.servedAfterReject).toEqual(treatment.servedBefore);
    expectGrantsUnchangedExceptRetirement(
      treatment.leasesBefore,
      treatment.leasesAfterReject,
      treatment.read1Anchors,
      treatment.targetAnchor,
    );
    expect(duplicateAnchors(treatment.read2Anchors)).toEqual([]);
  });

  it("batch abort (one part rejecting) records nothing — served rows and grants byte-identical", async () => {
    const control = await runBatchAbort(false);
    const treatment = await runBatchAbort(true);
    expect(treatment.aborted).toBe(true);
    expect(treatment.message).toMatch(/E_BATCH_ABORT/);
    expect(treatment.read2Anchors).toEqual(control.read2Anchors);
    expect(treatment.servedAfterAbort).toEqual(treatment.servedBefore);
    expectGrantsUnchangedExceptRetirement(
      treatment.leasesBefore,
      treatment.leasesAfterAbort,
      treatment.read1Anchors,
      treatment.targetAnchor,
    );
    expect(duplicateAnchors(treatment.read2Anchors)).toEqual([]);
  });

  it("malformed anchor on an existing file rejects E_MALFORMED_ANCHOR and writes nothing", async () => {
    await withTempFile("malformed.txt", TWIN_FILE, async ({ cwd, path }) => {
      const { sessionKey, readTool, editTool } = setupIntegrationTest(cwd);
      await readTool.execute("read", { path: "malformed.txt" });
      const servedBefore = await servedAt(cwd, sessionKey, path);

      let error: unknown;
      try {
        await editTool.execute("malformed", {
          path: "malformed.txt",
          edits: [["@@@", "@@@", "changed"]],
        });
      } catch (e) {
        error = e;
      }

      expect(String((error as Error).message)).toMatch(/E_MALFORMED_ANCHOR/);
      expect(await servedAt(cwd, sessionKey, path)).toEqual(servedBefore);
      expect(await readFile(path, "utf-8")).toBe(TWIN_FILE);
    });
  });
});
