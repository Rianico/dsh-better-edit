import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";
import { loadHashStore, type InternalHashStore } from "../../src/hash-store.js";

/**
 * The edit path's serve claim (T3d CP1).
 *
 * `mutation.execute()` commits the file write, then records the result rows as served. That
 * second write is deliberately outside the commit unit — a fault there must not roll the edit
 * back — but it decides whether the diff card's anchors are usable. Today the outcome is
 * discarded, so a failed serve still emits a success message whose diff hands the model
 * `+HASH│` rows that are not in the served set: the next edit built on them is rejected
 * (`E_UNSERVED_RANGE`) and only a re-read recovers.
 *
 * The contract this cell pins (downgraded, post-fix): the edit still reports success — it *did*
 * apply — but it must say the rows were NOT recorded as served and name the recovery, and it
 * must not present the diff anchors as usable. The undo path already obeys this
 * (`src/tool-undo.ts`); this is the same class of defect on the edit path.
 *
 * Faults are deterministic (`vi.spyOn` on the cached store object): no timing race, no sleep,
 * no production fault-injection flag.
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

      // ONLY the post-commit serve write faults: the file write and the undo pair already
      // committed, so the edit stands and only the advertised anchors are missing.
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
      // Measured BEFORE the follow-up attempts: the recovery edit legitimately re-serves.
      const fileAfter = await readFile(path, "utf-8");

      const endState = {
        threw: fault !== undefined,
        toolClaimedSuccess: text.includes("Successfully edited"),
        toolWarnsNotRecorded: namesPartialFailure(text),
        toolPromisesFreshAnchors: promisesFreshAnchors(text, advertised),
        advertisedAnchorsServed:
          advertised.length === 0 ? "n/a" : advertised.every((anchor) => servedAnchors.has(anchor)),
        fileAfter,
        // The follow-up the claim would have authorised, using an anchor it advertised.
        followUpEdit: "not-attempted" as string,
        // The recovery the result must name: a re-read re-serves the edited file.
        recovery: "not-attempted" as string,
      };

      if (advertised[0] !== undefined) {
        endState.followUpEdit = await editOutcome(harness, advertised[0]);
      }
      endState.recovery = await editOutcome(harness, await primeAnchor(harness, "│B"));

      expect(endState).toEqual({
        // The edit DID apply; the claim that is downgraded is the anchor claim, not the edit.
        threw: false,
        toolClaimedSuccess: true,
        // Post-fix contract: the result says so and names the recovery...
        toolWarnsNotRecorded: true,
        // ...instead of presenting the unserved diff anchors as usable.
        toolPromisesFreshAnchors: false,
        // The serve really did fail — pinned so the cell cannot pass by accident.
        advertisedAnchorsServed: false,
        // The edit is not rolled back.
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

      // No fault arm: the serve write is the only store mutation here, and it lands. The happy
      // path must stay concrete — same success claim, usable anchors, no warning.
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
