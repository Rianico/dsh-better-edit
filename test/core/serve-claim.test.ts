import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";
import { readAndServe } from "../../src/read-and-serve.js";
import { withWorkspace } from "../../src/workspace-context.js";
import {
  EDIT_DESCRIPTION,
  EDIT_GUIDANCE,
  UNDO_GUIDANCE,
  type ToolGuidance,
} from "../../src/prompts.js";

/**
 * The edit path's serve claim (T3d CP1).
 *
 * `mutation.execute()` commits the file write, then records the result rows as served. That
 * second write is deliberately outside the commit unit — a fault there must not roll the edit
 * back — but it decides whether the diff card's anchors are usable. Today the outcome is
 * discarded, so a failed serve still emits a success message whose diff hands the model
 * `+HASH│` rows that are not in the served set: the next edit built on them is rejected
 * (`E_UNSERVED_RANGE`) and only a re-read recovers.
 */

type Harness = ReturnType<typeof setupIntegrationTest>;

/** Read once and take the anchor of the served row carrying `marker` (e.g. `"│b"`). */
async function primeAnchor(harness: Harness, marker: string): Promise<string> {
  const served = await harness.readTool.execute("read", { path: "t.txt" });
  const row = getText(served)
    .split("\n")
    .find((line) => line.includes(marker));
  if (row === undefined) throw new Error(`read did not serve a row containing ${marker}`);
  const hash = row.split("│")[0];
  if (hash === undefined) throw new Error("served row carried no anchor");
  return hash;
}

/**
 * The anchors the tool advertised for follow-up edits: its diff card's `+` rows (`genDiff`
 * marks removed rows `-` and context rows ` `). These are the anchors the model is told to
 * copy for the next edit.
 */
function addedAnchorsFromToolOutput(text: string): string[] {
  const anchors: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\+\s*(?:\d+\s+)?([A-Za-z0-9]{3})│/.exec(line);
    if (match?.[1] !== undefined) anchors.push(match[1]);
  }
  return anchors;
}

/**
 * The partial-failure notice: the result names the cause (the rows were NOT recorded as served)
 * AND the recovery (re-read). Both halves are required — the same measured shape the undo cell
 * pins in test/core/undo-atomicity.test.ts.
 */
function namesPartialFailure(text: string): boolean {
  return /NOT recorded as served/.test(text) && /[Rr]e-read/.test(text);
}
/**
 * The anchor claim as the model receives it: the diff card hands out `+HASH│` rows and the result
 * carries no partial-failure notice. The rows alone ARE the promise — the guidance tells the model
 * to copy `HASH` from the diff for the next edit, and the edit RESULT has no promise sentence to
 * remove, so the observable delta is the notice's presence.
 */
function promisesFreshAnchors(text: string, advertised: string[]): boolean {
  return advertised.length > 0 && !namesPartialFailure(text);
}

/** Did an edit with this anchor apply, or was it refused by the tool's error surface? */
async function editOutcome(harness: Harness, anchor: string): Promise<"applied" | "rejected"> {
  try {
    const result = await harness.editTool.execute("edit", {
      path: "t.txt",
      edits: [[anchor, anchor, "Q"]],
    });
    return /\[E_[A-Z_]+\]/.test(getText(result)) ? "rejected" : "applied";
  } catch {
    return "rejected";
  }
}

describe("edit serve claim — the anchors the result advertises", () => {
  it("downgrades the anchor claim when the post-commit serve write fails", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const hash = await primeAnchor(harness, "│b");
      const abs = await harness.io.resolve("t.txt", cwd, new AbortController().signal);
      const store = (await loadHashStore(cwd)) as InternalHashStore;

      const upsert = vi.spyOn(store, "upsertServed").mockImplementation(() => {
        throw new Error("injected: post-commit serve fault");
      });
      let returned: string | undefined;
      let fault: unknown;
      try {
        returned = getText(
          await harness.editTool.execute("edit", { path: "t.txt", edits: [[hash, hash, "B"]] }),
        );
      } catch (error) {
        fault = error;
      }
      upsert.mockRestore();

      const text = returned ?? "";
      const advertised = addedAnchorsFromToolOutput(text);
      const servedAnchors = store.getAnchorReservations(harness.sessionKey, abs).reservedHashes;
      const fileAfter = await readFile(path, "utf-8");

      const endState = {
        threw: fault !== undefined,
        toolClaimedSuccess: text.includes("Successfully edited"),
        toolWarnsNotRecorded: namesPartialFailure(text),
        noticeNamesNotUsable: /NOT usable anchors/.test(text),
        toolPromisesFreshAnchors: promisesFreshAnchors(text, advertised),
        advertisedAnchorsServed:
          advertised.length === 0 ? "n/a" : advertised.every((anchor) => servedAnchors.has(anchor)),
        fileAfter,
        followUpEdit: "not-attempted" as string,
        recovery: "not-attempted" as string,
      };

      if (advertised[0] !== undefined) {
        endState.followUpEdit = await editOutcome(harness, advertised[0]);
      }
      endState.recovery = await editOutcome(harness, await primeAnchor(harness, "│B"));

      expect(endState).toEqual({
        threw: false,
        toolClaimedSuccess: true,
        toolWarnsNotRecorded: true,
        noticeNamesNotUsable: true,
        toolPromisesFreshAnchors: false,
        advertisedAnchorsServed: false,
        fileAfter: "a\nB\nc\n",
        followUpEdit: "rejected",
        recovery: "applied",
      });
    });
  });

  it("keeps the anchor claim intact when the serve write lands", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const hash = await primeAnchor(harness, "│b");
      const abs = await harness.io.resolve("t.txt", cwd, new AbortController().signal);
      const store = (await loadHashStore(cwd)) as InternalHashStore;

      const text = getText(
        await harness.editTool.execute("edit", { path: "t.txt", edits: [[hash, hash, "B"]] }),
      );
      const advertised = addedAnchorsFromToolOutput(text);
      const servedAnchors = store.getAnchorReservations(harness.sessionKey, abs).reservedHashes;

      expect({
        head: text.split("\n")[0],
        hasDiffCard: text.includes("--- t.txt ---"),
        advertisedRows: advertised.length,
        advertisedAnchorsServed:
          advertised.length > 0 && advertised.every((anchor) => servedAnchors.has(anchor)),
        toolWarnsNotRecorded: namesPartialFailure(text),
        toolPromisesFreshAnchors: promisesFreshAnchors(text, advertised),
        fileAfter: await readFile(path, "utf-8"),
      }).toEqual({
        head: "Successfully edited 1 file(s) — 1 of 1 edit(s) applied. Added 1 line(s), removed 1 line(s).",
        hasDiffCard: true,
        advertisedRows: 1,
        advertisedAnchorsServed: true,
        toolWarnsNotRecorded: false,
        toolPromisesFreshAnchors: true,
        fileAfter: "a\nB\nc\n",
      });
    });
  });
});

/** The one guidance bullet that carries `needle`, or a loud failure when it moved. */
function guidanceLine(guidance: ToolGuidance, needle: string): string {
  const line = guidance.lines.find((candidate) => candidate.includes(needle));
  if (line === undefined) throw new Error(`no guidance line containing ${needle}`);
  return line;
}

/** The anchors a read served: its `HASH│content` rows. */
function shownAnchorsFromReadText(text: string): string[] {
  const anchors: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z0-9]{3})│/.exec(line);
    if (match?.[1] !== undefined) anchors.push(match[1]);
  }
  return anchors;
}

describe("guidance — the anchor claim is conditional on the serve", () => {
  it("makes the edit guidance and description conditional", () => {
    const line = guidanceLine(EDIT_GUIDANCE, "fresh anchors");
    expect({
      namesNotRecorded: /NOT recorded as served/.test(line),
      namesReread: /[Rr]e-read/.test(line),
      promisesNoReread: /no need to re-read/.test(line),
      conditionalMarker: /unless|if the result/.test(line),
      descriptionWithinBound: EDIT_DESCRIPTION.length < 800,
      descriptionNamesNotRecorded: /NOT recorded as served/.test(EDIT_DESCRIPTION),
      descriptionNamesReread: /[Rr]e-read/.test(EDIT_DESCRIPTION),
    }).toEqual({
      namesNotRecorded: true,
      namesReread: true,
      promisesNoReread: false,
      conditionalMarker: true,
      descriptionWithinBound: true,
      descriptionNamesNotRecorded: true,
      descriptionNamesReread: true,
    });
  });

  it("makes the undo guidance conditional", () => {
    const line = guidanceLine(UNDO_GUIDANCE, "original pre-edit anchors for follow-up edits");
    expect({
      namesNotRecorded: /NOT recorded as served/.test(line),
      namesReread: /[Rr]e-read/.test(line),
      conditionalMarker: /unless/.test(line),
    }).toEqual({ namesNotRecorded: true, namesReread: true, conditionalMarker: true });
  });
});

describe("read serve claim — the anchors the result shows", () => {
  it("downgrades the anchor claim when the serve write fails", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const harness = setupIntegrationTest(cwd);
      const abs = await harness.io.resolve("t.txt", cwd, new AbortController().signal);
      const store = (await loadHashStore(cwd)) as InternalHashStore;

      const upsert = vi.spyOn(store, "upsertServed").mockImplementation(() => {
        throw new Error("injected: read serve fault");
      });
      let text: string;
      try {
        text = getText(await harness.readTool.execute("read", { path: "t.txt" }));
      } finally {
        upsert.mockRestore();
      }

      const shown = shownAnchorsFromReadText(text);
      const servedAnchors = store.getAnchorReservations(harness.sessionKey, abs).reservedHashes;
      const endState = {
        shownRows: shown.length,
        shownAnchorsServed:
          shown.length === 0 ? "n/a" : shown.every((anchor) => servedAnchors.has(anchor)),
        warnsNotRecorded: namesPartialFailure(text),
        noticeNamesNotUsable: /NOT usable for editing/.test(text),
        fileAfter: await readFile(path, "utf-8"),
        followUpEdit: "not-attempted" as string,
      };
      if (shown[0] !== undefined) endState.followUpEdit = await editOutcome(harness, shown[0]);

      expect(endState).toEqual({
        shownRows: 3,
        shownAnchorsServed: false,
        warnsNotRecorded: true,
        noticeNamesNotUsable: true,
        fileAfter: "a\nb\nc\n",
        followUpEdit: "rejected",
      });
    });
  });

  it("keeps the anchor claim intact when the serve write lands", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const abs = await harness.io.resolve("t.txt", cwd, new AbortController().signal);
      const store = (await loadHashStore(cwd)) as InternalHashStore;
      const text = getText(await harness.readTool.execute("read", { path: "t.txt" }));
      const shown = shownAnchorsFromReadText(text);
      const servedAnchors = store.getAnchorReservations(harness.sessionKey, abs).reservedHashes;

      expect({
        shownRows: shown.length,
        shownAnchorsServed: shown.length > 0 && shown.every((anchor) => servedAnchors.has(anchor)),
        warnsNotRecorded: namesPartialFailure(text),
      }).toEqual({ shownRows: 3, shownAnchorsServed: true, warnsNotRecorded: false });
    });
  });
});

describe("readAndServe boundary — the notice must reach the text channel", () => {
  it("puts the notice in the returned text when the serve write fails", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const store = (await loadHashStore(cwd)) as InternalHashStore;
      const upsert = vi.spyOn(store, "upsertServed").mockImplementation(() => {
        throw new Error("injected: read serve fault");
      });
      let result: Awaited<ReturnType<typeof readAndServe>>;
      try {
        result = await withWorkspace(cwd, () =>
          readAndServe(harness.io, "t.txt", cwd, { sessionKey: harness.sessionKey }),
        );
      } finally {
        upsert.mockRestore();
      }

      expect({
        textNamesNotRecorded: /NOT recorded as served/.test(result.text),
        textNamesReread: /[Rr]e-read/.test(result.text),
        shownRows: shownAnchorsFromReadText(result.text).length,
      }).toEqual({ textNamesNotRecorded: true, textNamesReread: true, shownRows: 3 });
    });
  });

  it("keeps the returned text clean when the serve write lands", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const result = await withWorkspace(cwd, () =>
        readAndServe(harness.io, "t.txt", cwd, { sessionKey: harness.sessionKey }),
      );

      expect({
        textNamesNotRecorded: /NOT recorded as served/.test(result.text),
        textNamesReread: /[Rr]e-read/.test(result.text),
        shownRows: shownAnchorsFromReadText(result.text).length,
      }).toEqual({ textNamesNotRecorded: false, textNamesReread: false, shownRows: 3 });
    });
  });
});
