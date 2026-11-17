import { describe, expect, it, beforeAll } from "vitest";
import { writeFile } from "node:fs/promises";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { loadServed, markDriftReported, driftReported } from "../../src/session-view.js";
import { sessionKeyFor } from "../../src/workspace-context.js";
import { withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hash-assign.js";

beforeAll(async () => {
  await initHasher();
});

describe("readAndServe", () => {
  it("renders hashline rows, records them as served, and clears drift marks", async () => {
    await withTempFile("a.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("session-1");
      await markDriftReported(sessionKey, path, ["abc", "def"]);

      const { text, absolutePath, hadUtf8DecodeErrors, served } = await readAndServe(
        localIO(),
        "a.txt",
        cwd,
        { sessionKey },
      );

      expect(hadUtf8DecodeErrors).toBe(false);
      expect(absolutePath).toBe(path);
      expect(served).toHaveLength(3);

      const lines = text.split("\n");
      expect(lines[0]).toMatch(/^[A-Za-z0-9]{3}│one$/);
      expect(lines[1]).toMatch(/^[A-Za-z0-9]{3}│two$/);
      expect(lines[2]).toMatch(/^[A-Za-z0-9]{3}│three$/);

      const stored = await loadServed(sessionKey, path);
      expect(stored).toHaveLength(3);
      expect(stored.every((hash) => hash !== null)).toBe(true);
      expect(await driftReported(sessionKey, path)).toEqual(new Set());
    });
  });

  it("respects offset and limit when serving rows", async () => {
    await withTempFile("b.txt", "one\ntwo\nthree\nfour\n", async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("session-2");

      const { text } = await readAndServe(localIO(), "b.txt", cwd, {
        sessionKey,
        offset: 2,
        limit: 2,
      });

      const lines = text.split("\n");
      expect(lines[0]).toMatch(/^[A-Za-z0-9]{3}│two$/);
      expect(lines[1]).toMatch(/^[A-Za-z0-9]{3}│three$/);
      expect(text).toContain("[Showing lines 2-3 of 4");

      const stored = await loadServed(sessionKey, path);
      expect(stored.filter((hash) => hash !== null)).toHaveLength(2);
    });
  });

  it("keeps unchanged lines' anchors when an external rewrite permutes two of them", async () => {
    const N = 10;
    const content = Array.from({ length: N }, (_, i) => `line ${i}`).join("\n");
    await withTempFile("stable.txt", content, async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("session-3");
      const io = localIO();
      const first = await readAndServe(io, path, cwd, { sessionKey });
      const firstHashes = first.served.map((r) => r.hash);
      const lines = content.split("\n");
      const tmp = lines[2]!;
      lines[2] = lines[7]!;
      lines[7] = tmp;
      const permuted = lines.join("\n");
      await writeFile(path, permuted, "utf-8");
      const second = await readAndServe(io, path, cwd, { sessionKey });
      const secondHashes = second.served.map((r) => r.hash);
      for (let i = 0; i < N; i++) {
        if (i !== 2 && i !== 7) {
          const origLine = `line ${i}`;
          const origIdx = content.split("\n").indexOf(origLine);
          const newIdx = permuted.split("\n").indexOf(origLine);
          if (origIdx !== -1 && newIdx !== -1) {
            expect(secondHashes[newIdx]).toBe(firstHashes[origIdx]);
          }
        }
      }
    });
  });
});
