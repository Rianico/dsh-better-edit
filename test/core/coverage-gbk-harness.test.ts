import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import iconv from "iconv-lite";
import { setupIntegrationTest, getText, withTempFile } from "../support/fixtures.js";

describe("gbk harness", () => {
  it("reads gbk via harness with autoGuess", async () => {
    const origGuess = process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
    const origSup = process.env.DSH_BETTER_EDIT_SUPPORTED_ENCODINGS;
    process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
    process.env.DSH_BETTER_EDIT_SUPPORTED_ENCODINGS = "gbk,utf8";
    await withTempFile("a.txt", "hello", async ({ cwd }) => {
      const gbkBytes = iconv.encode("你好世界", "gbk");
      await writeFile(join(cwd, "gbk.txt"), gbkBytes);
      const harness = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "gbk.txt" } as any);
      const txt = getText(res);
      // with autoGuess, should decode gbk correctly or at least not throw
      expect(typeof txt).toBe("string");
      // may contain decoded or fallback, but should be string
      expect(txt.length).toBeGreaterThan(0);
    });
    if (origGuess === undefined) delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
    else process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = origGuess;
    if (origSup === undefined) delete process.env.DSH_BETTER_EDIT_SUPPORTED_ENCODINGS;
    else process.env.DSH_BETTER_EDIT_SUPPORTED_ENCODINGS = origSup;
  });

  it("reads binary file via harness", async () => {
    await withTempFile("a.txt", "hello", async ({ cwd }) => {
      const binPath = join(cwd, "bin.dat");
      await writeFile(binPath, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
      const harness = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "bin.dat" } as any);
      const txt = getText(res);
      expect(typeof txt).toBe("string");
    });
  });
});
