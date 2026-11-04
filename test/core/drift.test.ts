import { describe, expect, it } from "vitest";
import {
  computeDrift,
  driftEpisodeKey,
  driftReported,
  markDriftReported,
} from "../../src/session-view.js";
import { loadServedStore, withStore } from "../../src/hash-store.js";
import { setupTestHome } from "../support/fixtures.js";

describe("computeDrift", () => {
  it("returns undefined when nothing drifted outside the range", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02"],
      resultHashes: ["h00", "h01", "h02"],
      resultLines: ["a", "b", "c"],
      range: {
        startLine: 2,
        endLine: 2,
        startHash: "h01",
        endHash: "h01",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeUndefined();
  });

  it("reports an in-place drift below the range with its post-edit content", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["h00", "h01", "h02", "X03"],
      resultLines: ["a", "b", "c", "changed"],
      range: {
        startLine: 2,
        endLine: 2,
        startHash: "h01",
        endHash: "h01",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.allAlreadyReported).toBe(false);
    expect(result!.rows).toEqual([
      { position: 2, hash: "h02", content: "c", drifted: false },
      { position: 3, hash: "X03", content: "changed", drifted: true },
    ]);
    expect(result!.text).toContain("drift:");
    expect(result!.text).toContain("X03│changed");
  });

  it("excludes the resolved range even when a boundary line was deleted", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03", "h04"],
      resultHashes: ["h00", "h01", "X03", "h04"],
      resultLines: ["a", "b", "x", "d"],
      range: {
        startLine: 3,
        endLine: 4,
        startHash: "h02",
        endHash: "h03",
        delta: -1,
      },
      reported: new Set(),
    });
    expect(result).toBeUndefined();
  });

  it("applies the edit's positional shift to served entries below the range", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03", "h04"],
      resultHashes: ["h00", "h01", "h03", "X04"],
      resultLines: ["a", "b", "d", "shifted"],
      range: {
        startLine: 3,
        endLine: 3,
        startHash: "h02",
        endHash: "h02",
        delta: -1,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.rows).toEqual([
      { position: 2, hash: "h03", content: "d", drifted: false },
      { position: 3, hash: "X04", content: "shifted", drifted: true },
    ]);
  });

  it("keeps positions of served entries above the range regardless of delta", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02"],
      resultHashes: ["h00", "X01", "h02"],
      resultLines: ["a", "changed", "c"],
      range: {
        startLine: 3,
        endLine: 3,
        startHash: "h02",
        endHash: "h02",
        delta: -5,
      },
      reported: new Set(),
    });
    expect(result!.rows).toEqual([
      { position: 0, hash: "h00", content: "a", drifted: false },
      { position: 1, hash: "X01", content: "changed", drifted: true },
      { position: 2, hash: "h02", content: "c", drifted: false },
    ]);
  });

  it("counts served entries shifted out of the file as drifted without rows", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02"],
      resultHashes: ["X02"],
      resultLines: ["c"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: -2,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(2);
    expect(result!.rows).toEqual([{ position: 0, hash: "X02", content: "c", drifted: true }]);
  });

  it("emits a one-line pointer when every drifted line is already reported", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["h00", "h01", "h02", "X03"],
      resultLines: ["a", "b", "c", "changed"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set([driftEpisodeKey(3)]),
    });
    expect(result).toBeDefined();
    expect(result!.allAlreadyReported).toBe(true);
    expect(result!.rows).toEqual([]);
    expect(result!.text).toContain("already reported");
    expect(result!.text).not.toContain("│");
  });

  it("shows a full notice with rows for all drifted lines when any is not yet reported", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["X00", "h01", "h02", "X03"],
      resultLines: ["changedA", "b", "c", "changedD"],
      range: {
        startLine: 2,
        endLine: 2,
        startHash: "h01",
        endHash: "h01",
        delta: 0,
      },
      reported: new Set([driftEpisodeKey(3)]),
    });
    expect(result).toBeDefined();
    expect(result!.allAlreadyReported).toBe(false);
    expect(result!.rows).toEqual([
      { position: 0, hash: "X00", content: "changedA", drifted: true },
      { position: 1, hash: "h01", content: "b", drifted: false },
      { position: 2, hash: "h02", content: "c", drifted: false },
      { position: 3, hash: "X03", content: "changedD", drifted: true },
    ]);
  });

  it("caps the total shown rows (drifted + context) and appends a hint for the remainder", () => {
    const served: (string | null)[] = [];
    const resultHashes: string[] = [];
    const resultLines: string[] = [];
    for (let i = 0; i < 200; i++) {
      served.push(`h${i}`);
      resultHashes.push(i % 2 === 0 ? `h${i}` : `R${i}`);
      resultLines.push(`line ${i}`);
    }
    const result = computeDrift({
      served,
      resultHashes,
      resultLines,
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h0",
        endHash: "h0",
        delta: 0,
      },
      reported: new Set(),
      cap: 150,
    });
    expect(result).toBeDefined();
    expect(result!.rows).toHaveLength(150);
    expect(result!.total).toBe(100);
    expect(result!.text).toContain("[... 50 more");
  });

  it("ignores never-served markers", () => {
    const result = computeDrift({
      served: ["h00", null, "h02"],
      resultHashes: ["h00", "X01", "h02"],
      resultLines: ["a", "changed", "c"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeUndefined();
  });

  it("tolerates an external positional shift above the range — only genuinely removed lines drift", () => {
    const served = ["h00", "h01", "h02", "h03", "h04", "h05", "h06", "h07", "h08", "h09"];
    const resultHashes = ["h00", "h01", "X04", "h05", "h06", "h07", "h08", "h09"];
    const resultLines = ["a", "b", "R", "e", "f", "g", "h", "i"];
    const result = computeDrift({
      served,
      resultHashes,
      resultLines,
      range: {
        startLine: 3,
        endLine: 3,
        startHash: "h04",
        endHash: "h04",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(2);
    expect(result!.rows).toEqual([
      { position: 1, hash: "h01", content: "b", drifted: false },
      { position: 2, hash: "X04", content: "R", drifted: true },
      { position: 3, hash: "h05", content: "e", drifted: false },
    ]);
  });

  it("shows a before/drift/after window for a single drifted line", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["h00", "h01", "X02", "h03"],
      resultLines: ["a", "b", "changed", "d"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(1);
    expect(result!.rows).toEqual([
      { position: 1, hash: "h01", content: "b", drifted: false },
      { position: 2, hash: "X02", content: "changed", drifted: true },
      { position: 3, hash: "h03", content: "d", drifted: false },
    ]);
  });

  it("merges adjacent drifted lines into a single window with shared context boundaries", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["X00", "X01", "X02", "X03"],
      resultLines: ["a", "b", "C", "D"],
      range: {
        startLine: 1,
        endLine: 2,
        startHash: "h00",
        endHash: "h01",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(2);
    expect(result!.rows).toEqual([
      { position: 1, hash: "X01", content: "b", drifted: false },
      { position: 2, hash: "X02", content: "C", drifted: true },
      { position: 3, hash: "X03", content: "D", drifted: true },
    ]);
  });

  it("bounds the window at the file start — only in-bounds context rows, no fabricated before-row", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02"],
      resultHashes: ["X00", "h01", "h02"],
      resultLines: ["changed", "b", "c"],
      range: {
        startLine: 3,
        endLine: 3,
        startHash: "h02",
        endHash: "h02",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(1);
    expect(result!.rows).toEqual([
      { position: 0, hash: "X00", content: "changed", drifted: true },
      { position: 1, hash: "h01", content: "b", drifted: false },
    ]);
  });

  it("bounds the window at the file end — only in-bounds context rows, no fabricated after-row", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["h00", "h01", "h02", "X03"],
      resultLines: ["a", "b", "c", "changed"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(1);
    expect(result!.rows).toEqual([
      { position: 2, hash: "h02", content: "c", drifted: false },
      { position: 3, hash: "X03", content: "changed", drifted: true },
    ]);
  });
});

describe("computeDrift rotated survivors (#68 canon deficit)", () => {
  const range121 = {
    startLine: 1,
    endLine: 1,
    startHash: "h00",
    endHash: "h00",
    delta: 0,
  };

  it("reports hash rotation as drift without servedCanons (legacy)", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["n00", "n01", "h02", "h03"],
      resultLines: ["dup", "dup", "dup", "unique"],
      range: range121,
      reported: new Set(),
    });
    expect(result).toBeDefined();
    // h00 is inside the edited range (skipped); only h01 counts.
    expect(result!.total).toBe(1);
  });

  it("stays silent when rotated duplicates survive under fresh hashes", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      servedCanons: ["dup", "dup", "dup", "unique"],
      resultHashes: ["n00", "n01", "h02", "h03"],
      resultLines: ["dup", "dup", "dup", "unique"],
      range: range121,
      reported: new Set(),
    });
    expect(result).toBeUndefined();
  });

  it("reports true canon deficit when a duplicate is really gone", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      servedCanons: ["dup", "dup", "dup", "unique"],
      resultHashes: ["h00", "h02", "h03"],
      resultLines: ["dup", "dup", "unique"],
      range: range121,
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(1);
  });

  it("stays silent on whitespace-only reformat with rotated hash", () => {
    const result = computeDrift({
      served: ["h00", "h01"],
      servedCanons: ["code", "tail"],
      resultHashes: ["n00", "h01"],
      resultLines: ["  code  ", "tail"],
      range: range121,
      reported: new Set(),
    });
    expect(result).toBeUndefined();
  });

  it("still reports content loss outside the range with canons present", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02"],
      servedCanons: ["a", "b", "c"],
      resultHashes: ["h00", "X"],
      resultLines: ["a", "x"],
      range: range121,
      reported: new Set(),
    });
    expect(result).toBeDefined();
    // h00 is inside the edited range (skipped); h01+h02 truly lost.
    expect(result!.total).toBe(2);
  });
});

describe("drift-notice episode identity (#98, upstream CAND-9)", () => {
  // The reported set must key on the drifted line's rebased position, not its anchor STRING:
  // an anchor is a spelling, not an identity. A reported entry for one line may not silence
  // a distinct line that happens to share the anchor.
  it("does not collapse distinct duplicate-hash drifted lines into one reported episode", () => {
    // Two distinct served positions share the anchor "dup" (ambiguous hash). Both lines
    // drifted to different content. `reported` holds one entry for the shared anchor: under
    // the string key BOTH lines are "already reported" and their current content is never
    // shown. Under the position key a raw anchor string reports nothing.
    const result = computeDrift({
      served: ["h00", "dup", "dup", "h03"],
      resultHashes: ["h00", "P01", "P02", "h03"],
      resultLines: ["a", "first-new", "second-new", "d"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(["dup"]),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(2);
    expect(result!.allAlreadyReported).toBe(false);
    // Two duplicate lines share one position key: a single marker reports the shared episode,
    // and the fixed behavior is that the episode is NOT collapsed to a bare pointer.
    expect(result!.rows.filter((r) => r.drifted).map((r) => r.hash)).toEqual(["P01"]);
    expect(result!.rows.map((r) => r.hash)).toContain("P02");
  });

  it("re-notices nothing when each drifted line's own episode key is reported", () => {
    const first = computeDrift({
      served: ["h00", "o01", "h02", "h03"],
      resultHashes: ["h00", "n01", "h02", "h03"],
      resultLines: ["a", "new-one", "c", "d"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(first).toBeDefined();
    const drifted = first!.rows.filter((r) => r.drifted);
    expect(drifted).toHaveLength(1);
    // The episode advances exactly as scanDrift does: mark what the notice showed.
    const reported = new Set(drifted.map((r) => driftEpisodeKey(r.position)));
    // Lease rotation renames the re-served mirror anchor "n01" -> "r01" without a fresh read,
    // and the line's content changes again. Under the string key the marked "n01" no longer
    // matches the mirror's rotated "r01" and the line spuriously re-notices; the position key
    // is rotation-stable.
    const second = computeDrift({
      served: ["h00", "r01", "h02", "h03"],
      resultHashes: ["h00", "x02", "h02", "h03"],
      resultLines: ["a", "rotated-new", "c", "d"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported,
    });
    expect(second).toBeDefined();
    expect(second!.allAlreadyReported).toBe(true);
  });

  it("keeps the episode key injective over reachable positions", () => {
    expect(driftEpisodeKey(0)).toBe("#AAA");
    expect(driftEpisodeKey(1)).toBe("#AAB");
    expect(driftEpisodeKey(-1)).toBe("");
    expect(driftEpisodeKey(1.5)).toBe("");
  });

  it("round-trips a legacy bare-hash entry through the store without suppressing or faking an episode", async () => {
    const { cleanup } = await setupTestHome();
    try {
      const sessionKey = "sessionA";
      const path = "/drift.ts";
      // A stale pre-upgrade reported entry is a bare anchor string. "AAA" is exactly what the
      // pre-namespace position key for position 0 encoded to, so under the old key it silenced the
      // episode below. Seed it raw so the reader — not the writer — owns the round-trip.
      const store = await loadServedStore();
      withStore(() => store.upsertServedReported(sessionKey, path, JSON.stringify(["AAA"])));

      // The legacy entry survives verbatim: the reader neither drops it nor rewrites it into the
      // namespaced "#AAA", which would leak through as a false report for position 0.
      const reported = await driftReported(sessionKey, path);
      expect(reported).toEqual(new Set(["AAA"]));

      const input = {
        served: ["h00", "h01", "h02"],
        resultHashes: ["X00", "h01", "h02"],
        resultLines: ["changed", "b", "c"],
        range: {
          startLine: 3,
          endLine: 3,
          startHash: "h02",
          endHash: "h02",
          delta: 0,
        },
      };
      const result = computeDrift({ ...input, reported });
      expect(result).toBeDefined();
      expect(result!.total).toBe(1);
      expect(result!.allAlreadyReported).toBe(false);
      expect(result!.text).toContain("drift:");

      // Marking the episode writes a namespaced key; a fresh read must now suppress it. Before the
      // reader accepted namespaced keys this round-trip lost "#AAA" and re-noticed forever.
      await markDriftReported(
        sessionKey,
        path,
        result!.rows.filter((row) => row.drifted).map((row) => driftEpisodeKey(row.position)),
      );
      const reportedAfter = await driftReported(sessionKey, path);
      expect(reportedAfter).toEqual(new Set(["AAA", "#AAA"]));
      const second = computeDrift({ ...input, reported: reportedAfter });
      expect(second!.allAlreadyReported).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
