/**
 * Regression for #51: a large file edited repeatedly between paged reads must
 * never exhaust the 3-char anchor space. Paged serves retire the anchors they
 * displace, so without incremental hazard GC + stable reuse the reserved set
 * (retired + served) grows until every allocation probes and fails.
 *
 * Scaled down from the issue repro (20k lines / 100 edits cost ~72 s): the
 * assertions are kept, the magnitudes are not.
 * @module dsh-better-edit/large-file-heavy-edits.test
 */
import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HASH_SPACE } from "../../src/hashline/hash-assign.js";
import { lineHashes } from "../../src/hashline/hash.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { loadServedStore } from "../../src/hash-store.js";
import { loadServed } from "../../src/session-view.js";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { withTempDir } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

function genLines(count: number, seed = 0): string[] {
  return Array.from({ length: count }, (_, i) => `line ${i} — content ${i % 100} seed ${seed}`);
}

describe("large-file heavy-edit integration (deadlock repro #51)", () => {
  it("paged reads plus repeated rewrites never exhaust the anchor space", async () => {
    const sessionKey = "sess-large-5k";
    const N = 2_000;
    await withTempDir("large-heavy-", async (tmpDir) => {
      const filePath = join(tmpDir, "file.txt");
      await writeFile(filePath, genLines(N, 0).join("\n"), "utf-8");
      const io = localIO();

      for (let off = 1; off <= N; off += 500) {
        const res = await readAndServe(io, filePath, tmpDir, {
          sessionKey,
          offset: off,
          limit: 500,
        });
        expect(res.served.length).toBeGreaterThan(0);
      }

      for (let edit = 0; edit < 20; edit++) {
        const offset = (edit * 97) % (N - 200);
        const curText = await readFile(filePath, "utf-8");
        const curLines = curText.split("\n");
        for (let k = 0; k < 100; k++) curLines[offset + k] = `changed ${edit}-${k} seed ${edit}`;
        await writeFile(filePath, curLines.join("\n"), "utf-8");

        const winOff = Math.max(1, offset - 100);
        const r = await readAndServe(io, filePath, tmpDir, {
          sessionKey,
          offset: winOff,
          limit: 300,
        });
        expect(r.served.length).toBeGreaterThan(0);
        const randOff = 1 + ((edit * 53) % (N - 500));
        const r2 = await readAndServe(io, filePath, tmpDir, {
          sessionKey,
          offset: randOff,
          limit: 250,
        });
        expect(r2.served.length).toBeGreaterThan(0);
      }

      const store = await loadServedStore();
      const retired = store.getRetiredEntries(sessionKey, filePath);
      const served = await loadServed(sessionKey, filePath);
      const servedCount = served.filter((h) => h !== null).length;
      const reserved = retired.length + servedCount;
      expect(reserved).toBeLessThan(HASH_SPACE);
      expect(retired.length).toBeLessThan(N * 2);
      // Deleted original: < 15_000 retired at 20_000 lines / 100 rewrites → 0.75
      // retired anchors per line. Same proportion here: 0.75 × 2_000 = 1_500.
      // Measured 0 (every paged serve is reused; nothing is displaced), so the cap
      // is a growth bound: this run serves ~13_000 lines in total (2_000 baseline
      // + 20 × 550 during the rewrites), 8.7× the cap, so per-serve retirement
      // regression fails it.
      expect(retired.length).toBeLessThan(1_500);

      for (let off = 1; off <= N; off += 500) {
        await readAndServe(io, filePath, tmpDir, { sessionKey, offset: off, limit: 500 });
      }
      const afterSweep = store.getRetiredEntries(sessionKey, filePath);
      expect(afterSweep.length).toBeLessThan(retired.length + 1);
    });
  }, 120_000);

  it("a full paged pass after repeated rewrites reuses baseline anchors and adds no retired", async () => {
    const sessionKey = "sess-large-20k";
    const N = 5_000;
    await withTempDir("large-heavy-stable-", async (tmpDir) => {
      const filePath = join(tmpDir, "file.txt");
      const initial = genLines(N, 0).join("\n");
      await writeFile(filePath, initial, "utf-8");
      const io = localIO();

      for (let off = 1; off <= N; off += 1_000) {
        await readAndServe(io, filePath, tmpDir, { sessionKey, offset: off, limit: 1_000 });
      }

      const baselineHashes = await lineHashes(initial, filePath);

      for (let edit = 0; edit < 20; edit++) {
        const offset = (edit * 199) % (N - 300);
        const curText = await readFile(filePath, "utf-8");
        const curLines = curText.split("\n");
        for (let k = 0; k < 500; k++) curLines[offset + k] = `edit${edit}_line${k}_x`;
        await writeFile(filePath, curLines.join("\n"), "utf-8");

        await expect(
          readAndServe(io, filePath, tmpDir, { sessionKey, offset: offset + 1, limit: 800 }),
        ).resolves.toBeDefined();
        const randOff = 1 + ((edit * 73) % (N - 800));
        await expect(
          readAndServe(io, filePath, tmpDir, { sessionKey, offset: randOff, limit: 700 }),
        ).resolves.toBeDefined();
      }

      const store = await loadServedStore();
      const retired = store.getRetiredEntries(sessionKey, filePath);
      const served = await loadServed(sessionKey, filePath);
      const servedCount = served.filter((h) => h !== null).length;
      expect(retired.length + servedCount).toBeLessThan(HASH_SPACE);
      // Same 0.75-retired-per-line proportion as the deleted original (15_000 at
      // 20_000 lines / 100 rewrites): 0.75 × 5_000 = 3_750. Measured 0, so the cap
      // is a growth bound: this run serves ~35_000 lines in total (5_000 baseline
      // + 20 × 1_500 during the rewrites), 9.3× the cap.
      expect(retired.length).toBeLessThan(3_750);

      const finalText = await readFile(filePath, "utf-8");
      const finalHashes = await lineHashes(finalText, filePath, {
        content: initial,
        hashes: baselineHashes,
      });
      let kept = 0;
      for (let i = 0; i < N; i++) if (finalHashes[i] === baselineHashes[i]) kept++;
      // 20 scattered 500-line rewrites cannot touch every line, so stable reuse
      // must survive for the untouched ones (S threading). The windows start at
      // edit × 199 and span 500 lines, so they cover [0, 3_781 + 500) = 4_281 of
      // the 5_000 lines and leave 719 alone — measured kept = 719, i.e. the whole
      // untouched set. Pin half of it (350 ≈ 7% of the file, a 2.05× margin): a
      // reuse regression that loses even half the stable anchors fails, while the
      // threshold stays a real fraction of the file rather than > 0.
      expect(kept).toBeGreaterThan(350);

      for (let off = 1; off <= N; off += 1_000)
        await readAndServe(io, filePath, tmpDir, { sessionKey, offset: off, limit: 1_000 });
      const after = store.getRetiredEntries(sessionKey, filePath);
      expect(after.length).toBeLessThanOrEqual(retired.length);
    });
  }, 120_000);
});
