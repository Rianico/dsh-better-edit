import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getWritableTempRoot } from "../support/fixtures.js";
import { localIO } from "../../src/fs-bridge.js";
import { initHasher } from "../../src/hashline/index.js";

describe("mutation coverage agent-a", () => {
  beforeEach(async () => {
    await initHasher();
  });

  it("resolveDisplayPath delegates to toCwd", async () => {
    const { resolveDisplayPath } = await import("../../src/mutation.js");
    expect(resolveDisplayPath("a/b.txt", "/cwd")).toBe(resolve("/cwd", "a/b.txt"));
    expect(resolveDisplayPath("/abs/path.txt", "/cwd")).toBe("/abs/path.txt");
  });

  it("snapshotIdFor falls back to fileSnap then undefined", async () => {
    const { snapshotIdFor } = await import("../../src/mutation.js");
    const dir = await mkdtemp(join(await getWritableTempRoot(), "mut-snap-"));
    const fp = join(dir, "file.txt");
    await writeFile(fp, "hello\n", "utf-8");
    const io = localIO();
    // statVersion succeeds -> returns version
    const id1 = await snapshotIdFor(io, fp);
    expect(typeof id1).toBe("string");
    // force io.statVersion to throw -> falls back to fileSnap
    const badIO: any = {
      statVersion: async () => {
        throw new Error("fail");
      },
    };
    const id2 = await snapshotIdFor(badIO, fp);
    expect(typeof id2).toBe("string");
    // both fail -> undefined
    const badIO2: any = {
      statVersion: async () => {
        throw new Error("fail");
      },
    };
    // mock fileSnap to throw by giving non-existent file
    const id3 = await snapshotIdFor(badIO2, join(dir, "nonexistent-" + Math.random()));
    expect(id3).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("re-exports are accessible", async () => {
    const mod = await import("../../src/mutation.js");
    expect(typeof mod.noopPayloadKey).toBe("function");
    expect(typeof mod.trackNoopPayload).toBe("function");
    expect(typeof mod.clearNoopLoop).toBe("function");
    expect(typeof mod.buildMetrics).toBe("function");
    expect(typeof mod.genDiff).toBe("function");
    expect(typeof mod.computeDrift).toBe("function");
    expect(typeof mod.runFileEdits).toBe("function");
    expect(typeof mod.execute).toBe("function");
    expect(typeof mod.applySequence).toBe("function");
    expect(typeof mod.commit).toBe("function");
  });
});
