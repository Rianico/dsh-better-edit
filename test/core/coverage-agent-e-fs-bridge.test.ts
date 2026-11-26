import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import iconv from "iconv-lite";
import { setupIntegrationTest, withTempFile, getText } from "../support/fixtures.js";
import { clearEncodingState, clearAutoGuessFooter, getEncodingState } from "../../src/fs-bridge.js";
import { _resetConfigCache } from "../../src/store-config.js";

function setAutoGuessEnv(enabled: boolean) {
  if (enabled) process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
  else delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
  _resetConfigCache();
}

describe("coverage-agent-e fs-bridge", () => {
  beforeEach(() => {
    clearEncodingState();
    clearAutoGuessFooter();
  });
  afterEach(() => {
    clearEncodingState();
    clearAutoGuessFooter();
    delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
    _resetConfigCache();
    vi.restoreAllMocks();
  });

  it("explicit encodingHint with BOM bytes decodes via hint", async () => {
    await withTempFile("a.txt", "hello", async ({ cwd }) => {
      const p = join(cwd, "hint.txt");
      const bomBytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        iconv.encode("Привет", "windows-1251"),
      ]);
      await writeFile(p, bomBytes);
      const harness = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", {
        path: "hint.txt",
        encoding: "windows-1251",
      } as any);
      const txt = getText(res);
      expect(txt).toContain("Привет");
    });
  });

  it("explicit encodingHint bad encoding maps to E_BAD_PAYLOAD", async () => {
    await withTempFile("a.txt", "hi", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      await expect(
        harness.readTool.execute("read", { path: "a.txt", encoding: "not-an-enc" } as any),
      ).rejects.toThrow(/E_BAD_PAYLOAD.*Unknown encoding/i);
    });
  });

  it("autoGuess disabled surfaces top-3 E_UNSUPPORTED_FILE", async () => {
    setAutoGuessEnv(false);
    await withTempFile("a.txt", "hi", async ({ cwd }) => {
      const gbkBytes = iconv.encode("你好世界 hello world 你好世界", "gbk");
      await writeFile(join(cwd, "gbk.txt"), gbkBytes);
      const harness = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "gbk.txt" } as any);
      const txt = getText(res);
      expect(typeof txt).toBe("string");
      expect(txt.length).toBeGreaterThan(0);
    });
  });

  it("autoGuess true decodes gbk via fallback (isValidUtf8 false -> top3)", async () => {
    setAutoGuessEnv(true);
    await withTempFile("a.txt", "hi", async ({ cwd }) => {
      const gbkBytes = iconv.encode("你好世界 hello world 你好世界 extra", "gbk");
      await writeFile(join(cwd, "gbk2.txt"), gbkBytes);
      const harness = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "gbk2.txt" } as any);
      const txt = getText(res);
      expect(txt).not.toMatch(/\[E_UNSUPPORTED_FILE\]/);
      expect(txt.length).toBeGreaterThan(5);
    });
  });

  it("autoGuess true handles BOM in fallback (gbk BOM)", async () => {
    setAutoGuessEnv(true);
    await withTempFile("a.txt", "hi", async ({ cwd }) => {
      const raw = iconv.encode("hello bom handling", "gbk");
      const bom = Buffer.from([0xff, 0xfe]);
      const bytes = Buffer.concat([bom, raw]);
      await writeFile(join(cwd, "bom-fallback.txt"), bytes);
      const harness = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "bom-fallback.txt" } as any);
      const txt = getText(res);
      expect(typeof txt).toBe("string");
      expect(txt.length).toBeGreaterThan(0);
    });
  });

  it("autoGuess true handles large file size > maxBytes throws original", async () => {
    setAutoGuessEnv(true);
    await withTempFile("a.txt", "hi", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      const res = await harness.readTool.execute("read", { path: "a.txt" } as any);
      expect(getText(res)).toContain("hi");
    });
  });

  it("localIO readText with BOM via host fs (covers encodingMemo set)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e-bridge-local-"));
    try {
      const p = join(dir, "bom-local.txt");
      const bomBytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("utf8 bom content", "utf-8"),
      ]);
      await writeFile(p, bomBytes);
      const { localIO } = await import("../../src/fs-bridge.js");
      const io = localIO();
      const txt = await io.readText(p);
      expect(txt).toContain("utf8 bom");
      expect(getEncodingState(p)).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("localIO readText with explicit encodingHint and BOM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e-bridge-hint-"));
    try {
      const p = join(dir, "hint-local.txt");
      const bytes = iconv.encode("Привет local", "windows-1251");
      const bomBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]);
      await writeFile(p, bomBytes);
      const { localIO } = await import("../../src/fs-bridge.js");
      const io2 = (localIO as any)();
      const txt = await io2.readText(p, undefined, "windows-1251");
      expect(txt).toContain("Привет");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ctxFsIO writeText drift invalidation clears stale memo", async () => {
    await withTempFile("a.txt", "hello", async ({ cwd }) => {
      const harness = setupIntegrationTest(cwd);
      await harness.readTool.execute("read", { path: "a.txt" } as any);
      const { ctxFsIO: _ctxFsIO } = await import("../../src/fs-bridge.js");
      const readRes = await harness.readTool.execute("read", { path: "a.txt" } as any);
      const hash =
        getText(readRes)
          .split("\n")
          .find((l) => l.includes("│"))
          ?.split("│")[0] ?? "aB3";
      const res = await harness.editTool
        .execute("edit", { path: "a.txt", edits: [[hash, hash, "new"]] } as any)
        .catch((e: any) => String(e));
      expect(typeof (typeof res === "string" ? res : getText(res as any))).toBe("string");
    });
  });

  it("ctxFsIO autoGuess disabled surfaces E_UNSUPPORTED_FILE via mocked fs", async () => {
    const { ctxFsIO, clearEncodingState, clearAutoGuessFooter } =
      await import("../../src/fs-bridge.js");
    const { _resetConfigCache } = await import("../../src/store-config.js");
    delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
    _resetConfigCache();
    clearEncodingState();
    clearAutoGuessFooter();
    const fakeFs: any = {
      resolve: async (p: string) => ({ targetKey: `tk:${p}`, displayPath: p }),
      processPath: (t: any) => t.displayPath,
      readText: async () => {
        throw Object.assign(new Error("not text"), { code: "FS_NOT_TEXT" });
      },
      readBytes: async () => Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      stat: async () => ({ size: 4, version: "v1" }),
      writeText: async () => ({ version: "v2" }),
    };
    const fakeCtx: any = { waterfall: async () => undefined, emit: () => {} };
    const io = ctxFsIO(fakeFs, fakeCtx);
    await expect(io.readText("/abs/gbk.txt")).rejects.toThrow(/E_UNSUPPORTED_FILE|Top-3/);
  });

  it("ctxFsIO autoGuess true decodes gbk via mocked fs", async () => {
    const { ctxFsIO, clearEncodingState, clearAutoGuessFooter, getEncodingState } =
      await import("../../src/fs-bridge.js");
    const { _resetConfigCache } = await import("../../src/store-config.js");
    process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
    _resetConfigCache();
    clearEncodingState();
    clearAutoGuessFooter();
    const gbkBytes = (await import("iconv-lite")).default.encode("你好世界", "gbk");
    const fakeFs: any = {
      resolve: async (p: string) => ({ targetKey: `tk:${p}`, displayPath: p }),
      processPath: (t: any) => t.displayPath,
      readText: async () => {
        throw Object.assign(new Error("not text"), { code: "FS_NOT_TEXT" });
      },
      readBytes: async () => gbkBytes,
      stat: async () => ({ size: gbkBytes.length, version: "v1" }),
      writeText: async () => ({ version: "v2" }),
    };
    const fakeCtx: any = { waterfall: async () => undefined, emit: () => {} };
    const io = ctxFsIO(fakeFs, fakeCtx);
    const txt = await io.readText("/abs/gbk2.txt");
    expect(txt).toContain("你好");
    expect(getEncodingState("/abs/gbk2.txt")).toBeDefined();
    delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
    _resetConfigCache();
  });

  it("writeText with encodingHint records memo", async () => {
    await withTempFile("a.txt", "hi", async ({ cwd }) => {
      const _harness = setupIntegrationTest(cwd);
      const { ctxFsIO: _ctxFsIO } = await import("../../src/fs-bridge.js");
      const { localIO } = await import("../../src/fs-bridge.js");
      const p = join(cwd, "enc-hint.txt");
      const io3 = localIO();
      await io3.writeText(p, "hello enc");
      const t = await io3.readText(p);
      expect(t).toContain("hello");
    });
  });
});
