import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { lineHashesPure } from "../../src/hashline/hash-assign.js";
import { createLineageStore, type LineageStore } from "../../src/snapshot-store/lineage-store.js";

const RUN_FOUR = ["head", "  }", "  }", "  }", "  }", "tail"];
const RUN_TWO = ["head", "  }", "  }", "tail"];

function open(): { db: DatabaseSync; store: LineageStore } {
  const db = new DatabaseSync(":memory:");
  return { db, store: createLineageStore(db) };
}

function commit(store: LineageStore, path: string, lines: string[]): void {
  const content = lines.join("\n");
  store.commitSnapshot({ path, content, hashes: lineHashesPure(content) });
}

describe("line_id inheritance shares the pairing owner", () => {
  it("carries a homogeneous shrink's surviving ids by ordinal", () => {
    const { store } = open();
    commit(store, "/shrink.ts", RUN_FOUR);
    const prior = store.latestLineageFor("/shrink.ts")!;

    commit(store, "/shrink.ts", RUN_TWO);
    const after = store.latestLineageFor("/shrink.ts")!;

    expect(after.map((row) => row.lineId)).toEqual([
      prior[0]!.lineId,
      prior[1]!.lineId,
      prior[2]!.lineId,
      prior[5]!.lineId,
    ]);
  });

  it("carries a homogeneous growth's prior ids and mints the tail", () => {
    const { store } = open();
    commit(store, "/grow.ts", RUN_TWO);
    const prior = store.latestLineageFor("/grow.ts")!;

    commit(store, "/grow.ts", RUN_FOUR);
    const after = store.latestLineageFor("/grow.ts")!;

    expect(after.map((row) => row.lineId)).toEqual([
      prior[0]!.lineId,
      prior[1]!.lineId,
      prior[2]!.lineId,
      expect.any(Number),
      expect.any(Number),
      prior[3]!.lineId,
    ]);
    const minted = [after[3]!.lineId, after[4]!.lineId];
    expect(minted).not.toContain(prior[0]!.lineId);
    expect(minted).not.toContain(prior[1]!.lineId);
    expect(minted).not.toContain(prior[2]!.lineId);
    expect(minted).not.toContain(prior[3]!.lineId);
  });

  it("resolves a surviving ordinal anchor in memory before any commit", () => {
    const { store } = open();
    commit(store, "/resolve.ts", RUN_FOUR);
    const prior = store.latestLineageFor("/resolve.ts")!;

    const positions = store.positionsByIdentity("/resolve.ts", RUN_TWO.join("\n"));

    expect(positions.get(prior[2]!.lineId)).toBe(3);
    expect(positions.has(prior[3]!.lineId)).toBe(false);
    expect(positions.has(prior[4]!.lineId)).toBe(false);
    expect(positions.get(prior[5]!.lineId)).toBe(4);
  });

  it("fails closed when the prior rows carry no raw digest", () => {
    const { db, store } = open();
    commit(store, "/legacy.ts", RUN_FOUR);
    const prior = store.latestLineageFor("/legacy.ts")!;
    db.exec("UPDATE line_lineage SET raw_hash = NULL");

    commit(store, "/legacy.ts", RUN_TWO);
    const after = store.latestLineageFor("/legacy.ts")!;

    // No raw evidence, no ordinal carry: the run takes fresh ids.
    expect(after[1]!.lineId).not.toBe(prior[1]!.lineId);
    expect(after[2]!.lineId).not.toBe(prior[2]!.lineId);
    expect(after[0]!.lineId).toBe(prior[0]!.lineId);
    expect(after[3]!.lineId).toBe(prior[5]!.lineId);
  });
});
