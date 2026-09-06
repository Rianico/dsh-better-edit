import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { initHasher, HASH_SPACE } from "../src/hashline/hash-assign.js";
import { shutdownHashStore, loadServedStore } from "../src/hash-store.js";
import * as SessionView from "../src/session-view.js";
import { vi } from "vitest";

async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

function genLines(count: number, seed = 0): string[] {
  return Array.from({ length: count }, (_, i) => `line ${i} — content ${i % 100} seed ${seed}`);
}

describe("51 large-file heavy-edit integration (deadlock repro #51)", () => {
  let tmpHome: string;
  beforeAll(async () => {
    await initHasher();
    tmpHome = await mkdtemp(join(await getWritableTempRoot(), "testhome-51-large-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
  });
  afterAll(async () => {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("scaled-down repro: 5k lines, 50 batch edits with only partial reads never exhausts", async () => {
    const sessionKey = "sess-large-5k";
    const N = 5_000;
    const tmpDir = await mkdtemp(join(await getWritableTempRoot(), "large-5k-"));
    const filePath = join(tmpDir, "file.txt");
    const initial = genLines(N, 0).join("\n");
    await writeFile(filePath, initial, "utf-8");

    const { readAndServe } = await import("../src/read-and-serve.js");
    const { localIO } = await import("../src/fs-bridge.js");
    const io = localIO();

    for (let off = 1; off <= N; off += 1000) {
      const res = await readAndServe(io, filePath, tmpDir, { sessionKey, offset: off, limit: 1000 });
      expect(res.served.length).toBeGreaterThan(0);
    }

    for (let edit = 0; edit < 50; edit++) {
      const offset = (edit * 97) % (N - 500);
      const curText = await (await import("node:fs/promises")).readFile(filePath, "utf-8");
      const curLines = curText.split("\n");
      for (let k = 0; k < 200; k++) curLines[offset + k] = `changed ${edit}-${k} seed ${edit}`;
      await writeFile(filePath, curLines.join("\n"), "utf-8");

      const winOff = Math.max(1, offset - 200);
      const r = await readAndServe(io, filePath, tmpDir, { sessionKey, offset: winOff, limit: 600 });
      expect(r.served.length).toBeGreaterThan(0);
      const randOff = 1 + ((edit * 53) % (N - 1000));
      const r2 = await readAndServe(io, filePath, tmpDir, { sessionKey, offset: randOff, limit: 500 });
      expect(r2.served.length).toBeGreaterThan(0);
    }

    const store = await loadServedStore();
    const retired = store.getRetiredEntries(sessionKey, filePath);
    const served = await SessionView.loadServed(sessionKey, filePath);
    const servedCount = served.filter((h) => h !== null).length;
    const reserved = retired.length + servedCount;
    expect(reserved).toBeLessThan(HASH_SPACE);
    expect(retired.length).toBeLessThan(N * 2);
    expect(retired.length).toBeLessThan(15_000);

    for (let off = 1; off <= N; off += 1000) {
      await readAndServe(io, filePath, tmpDir, { sessionKey, offset: off, limit: 1000 });
    }
    const afterSweep = store.getRetiredEntries(sessionKey, filePath);
    expect(afterSweep.length).toBeLessThan(retired.length + 1);

    await rm(tmpDir, { recursive: true, force: true });
  }, 120_000);

  it("20k lines, 100 batch edits + paged partial reads: no E_ANCHOR_SPACE_EXHAUSTED, stable reuse", async () => {
    const sessionKey = "sess-large-20k";
    const N = 20_000;
    const tmpDir = await mkdtemp(join(await getWritableTempRoot(), "large-20k-"));
    const filePath = join(tmpDir, "file.txt");
    const initial = genLines(N, 0).join("\n");
    await writeFile(filePath, initial, "utf-8");

    const { readAndServe } = await import("../src/read-and-serve.js");
    const { localIO } = await import("../src/fs-bridge.js");
    const io = localIO();

    for (let off = 1; off <= N; off += 2000) {
      await readAndServe(io, filePath, tmpDir, { sessionKey, offset: off, limit: 2000 });
    }

    const { lineHashes } = await import("../src/hashline/hash.js");
    const baselineHashes = await lineHashes(initial, filePath);

    for (let edit = 0; edit < 100; edit++) {
      const offset = (edit * 199) % (N - 800);
      const curText = await (await import("node:fs/promises")).readFile(filePath, "utf-8");
      const curLines = curText.split("\n");
      for (let k = 0; k < 500; k++) curLines[offset + k] = `edit${edit}_line${k}_x`;
      await writeFile(filePath, curLines.join("\n"), "utf-8");

      await expect(readAndServe(io, filePath, tmpDir, { sessionKey, offset: offset + 1, limit: 800 })).resolves.toBeDefined();
      const randOff = 1 + ((edit * 73) % (N - 800));
      await expect(readAndServe(io, filePath, tmpDir, { sessionKey, offset: randOff, limit: 700 })).resolves.toBeDefined();
    }

    const store = await loadServedStore();
    const retired = store.getRetiredEntries(sessionKey, filePath);
    const served = await SessionView.loadServed(sessionKey, filePath);
    const servedCount = served.filter((h) => h !== null).length;
    expect(retired.length + servedCount).toBeLessThan(HASH_SPACE);
    expect(retired.length).toBeLessThan(80_000);

    const finalText = await (await import("node:fs/promises")).readFile(filePath, "utf-8");
    const finalHashes = await lineHashes(finalText, filePath, { content: initial, hashes: baselineHashes });
    let kept = 0;
    for (let i = 0; i < N; i++) if (finalHashes[i] === baselineHashes[i]) kept++;
    // After 100 scattered 500-line edits ~50k replacements on 20k file, many lines overwritten; just verify some stable reuse survived (S threading keeps untouched far lines)
    expect(kept).toBeGreaterThan(100);

    for (let off = 1; off <= N; off += 2000) await readAndServe(io, filePath, tmpDir, { sessionKey, offset: off, limit: 2000 });
    const after = store.getRetiredEntries(sessionKey, filePath);
    expect(after.length).toBeLessThanOrEqual(retired.length);

    await rm(tmpDir, { recursive: true, force: true });
  }, 120_000);
});
