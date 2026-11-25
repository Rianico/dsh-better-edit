import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { shutdownHashStore } from "../../src/hash-store.js";
import { canonDigest, HASH_RE, lineHashesAligned } from "../../src/hashline/hash-assign.js";
import { alignToLatestLineage, lineHashes } from "../../src/hashline/hash.js";
import { normFromText } from "../../src/file-view.js";
import type { LineageRow } from "../../src/snapshot-store/lineage-store.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

function pathFor(name: string): string {
  return join(dirname(home.testPath), name);
}

function sqlitePath(): string {
  return join(dirname(home.testPath), ".dsh", "plugins", "dsh-better-edit", "hash-store.sqlite");
}

function lineageRows(anchors: string[], lines: string[]): LineageRow[] {
  return lines.map((line, index) => ({
    lineNumber: index + 1,
    lineId: index + 1,
    canonHash: canonDigest(line),
    anchor: anchors[index]!,
  }));
}

describe("lineHashesAligned — allocation around carried anchors", () => {
  it("serves carried anchors verbatim and allocates every other line", () => {
    const hashes = lineHashesAligned("a\nb\nc\n", new Map([[2, "BBB"]]));

    expect(hashes).toHaveLength(3);
    expect(hashes[1]).toBe("BBB");
    expect(new Set(hashes).size).toBe(3);
    for (const hash of hashes) expect(HASH_RE.test(hash)).toBe(true);
  });

  it("keeps fresh allocation off blocked and carried anchors", () => {
    const hashes = lineHashesAligned("a\nb\nc\n", new Map([[1, "AAA"]]), new Set(["BBB"]));

    expect(hashes[0]).toBe("AAA");
    expect(hashes).not.toContain("BBB");
    expect(new Set(hashes).size).toBe(3);
  });
});

/** The read path's opt-in: align a checksum miss against the latest committed lineage. */
const ALIGN: { enabled: boolean } = { enabled: true };

describe("alignToLatestLineage — pairing against prior rows", () => {
  it("keeps a surviving twin's anchor and retires the deleted twin", () => {
    const latest = lineageRows(["AAA", "BBB", "CCC", "DDD", "EEE"], ["x", "a", "y", "a", "z"]);

    const aligned = alignToLatestLineage("x\ny\na\nz\n", latest);

    expect(aligned.hashes).toEqual(["AAA", "CCC", "DDD", "EEE"]);
    expect([...aligned.retired]).toEqual(["BBB"]);
  });

  it("blocks a retired twin's canonical anchor from fresh allocation", () => {
    // a a a b -> a a b: every `a` retired, and every `a` anchor is a twin canon, so no fresh line
    // may reclaim one of them.
    const latest = lineageRows(["AAA", "BBB", "CCC", "DDD"], ["a", "a", "a", "b"]);

    const aligned = alignToLatestLineage("a\na\nb\n", latest);

    expect(aligned.hashes[2]).toBe("DDD");
    expect(aligned.hashes).not.toContain("AAA");
    expect(aligned.hashes).not.toContain("BBB");
    expect(aligned.hashes).not.toContain("CCC");
    expect([...aligned.retired].sort()).toEqual(["AAA", "BBB", "CCC"]);
  });
});

describe("checksum miss aligns against the latest committed lineage", () => {
  it("keeps the surviving twin's anchor and drops the deleted twin's", async () => {
    const path = pathFor("twin-delete.txt");
    const prior = await lineHashes("x\na\ny\na\nz\n", path);

    const drifted = await lineHashes(
      "x\ny\na\nz\n",
      path,
      undefined,
      undefined,
      true,
      new Set(),
      new Set(),
      ALIGN,
    );

    expect(drifted).toHaveLength(4);
    expect(drifted[0]).toBe(prior[0]);
    expect(drifted[1]).toBe(prior[2]);
    expect(drifted[2]).toBe(prior[3]);
    expect(drifted[3]).toBe(prior[4]);
    expect(drifted).not.toContain(prior[1]);
  });

  it("carries anchors across a pure reorder — the pairing, not the position, decides", async () => {
    const path = pathFor("reorder.txt");
    const prior = await lineHashes("a\nb\nc\n", path);

    const reordered = await lineHashes(
      "b\na\nc\n",
      path,
      undefined,
      undefined,
      true,
      new Set(),
      new Set(),
      ALIGN,
    );

    expect(reordered).toEqual([prior[1], prior[0], prior[2]]);
  });

  it("reports the retired twin through the alignment sink", async () => {
    const path = pathFor("twin-retired-sink.txt");
    const prior = await lineHashes("x\na\ny\na\nz\n", path);
    const retired = new Set<string>();

    const drifted = await lineHashes(
      "x\ny\na\nz\n",
      path,
      undefined,
      undefined,
      true,
      new Set(),
      new Set(),
      { enabled: true, retired },
    );

    expect(retired.has(prior[1]!)).toBe(true);
    expect(retired.has(prior[3]!)).toBe(false);
    expect(drifted).not.toContain(prior[1]);
  });

  it("retires an ambiguous homogeneous shrink fail-closed — ordinal carry is T2", async () => {
    const path = pathFor("homogeneous-shrink.txt");
    const prior = await lineHashes("a\na\na\nb\n", path);
    const retired = new Set<string>();

    const drifted = await lineHashes(
      "a\na\nb\n",
      path,
      undefined,
      undefined,
      true,
      new Set(),
      new Set(),
      { enabled: true, retired },
    );

    expect(drifted[2]).toBe(prior[3]);
    expect(retired).toEqual(new Set([prior[0], prior[1], prior[2]]));
    expect(drifted).not.toContain(prior[0]);
    expect(new Set(drifted).size).toBe(3);
  });

  it("returns the stored anchors unchanged on a checksum hit", async () => {
    const path = pathFor("checksum-hit.txt");
    const first = await lineHashes("alpha\nbeta\n", path);

    const second = await lineHashes("alpha\nbeta\n", path);

    expect(second).toEqual(first);
  });

  it("falls back to fresh allocation when the path has no prior lineage", async () => {
    const path = pathFor("no-prior.txt");

    const hashes = await lineHashes("hello\nworld\n", path);

    expect(hashes).toHaveLength(2);
    for (const hash of hashes) expect(HASH_RE.test(hash)).toBe(true);
  });

  it("falls back to fresh allocation when the prior lineage is corrupt", async () => {
    const path = pathFor("corrupt-lineage.txt");
    await lineHashes("a\nb\nc\n", path);
    shutdownHashStore();
    const db = new DatabaseSync(sqlitePath(), { defensive: false } as any);
    db.prepare(
      "UPDATE line_lineage SET anchor = ? WHERE snapshot_id = " +
        "(SELECT MAX(snapshot_id) FROM file_snapshots WHERE path = ?)",
    ).run("zz", path);
    db.close();

    const control = await lineHashes("a\nb\nd\n", pathFor("corrupt-lineage-control.txt"));
    const corrupted = await lineHashes(
      "a\nb\nd\n",
      path,
      undefined,
      undefined,
      true,
      new Set(),
      new Set(),
      ALIGN,
    );

    expect(corrupted).toEqual(control);
    for (const hash of corrupted) expect(HASH_RE.test(hash)).toBe(true);
  });

  it("aligns through normFromText — the read path's checksum-miss call site", async () => {
    const path = pathFor("norm-from-text.txt");
    const prior = await normFromText({
      absolutePath: path,
      rawText: "x\na\ny\na\nz\n",
      displayPath: "norm-from-text.txt",
      alignOnMiss: true,
    });

    const drifted = await normFromText({
      absolutePath: path,
      rawText: "x\ny\na\nz\n",
      displayPath: "norm-from-text.txt",
      alignOnMiss: true,
    });

    expect(drifted.fileHashes[0]).toBe(prior.fileHashes[0]);
    expect(drifted.fileHashes[2]).toBe(prior.fileHashes[3]);
    expect(drifted.fileHashes).not.toContain(prior.fileHashes[1]);
  });
});
