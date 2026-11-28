/**
 * Shadow `str_replace_editor` read-first and match-arity gates.
 *
 * Version semantics belong to `str-replace-version-gate.test.ts`; sandbox
 * escalation policy to `str-replace-sandbox-policy.test.ts`. This file covers
 * the remaining gates: encoding auto-guess on `view` (its warning is a second
 * rendered block), the blind gate on `insert` and `str_replace` (both reject ⇒
 * no write), BOM round-tripping through `view` → `str_replace`, and `old_str`'s
 * exactly-once rule.
 * @module dsh-better-edit/str-replace-editor.gates.test
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import iconv from "iconv-lite";
import { localIO, clearAutoGuessFooter, clearEncodingState } from "../../src/fs-bridge.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { buildStrReplaceEditorTool } from "../../src/tool-str-replace-editor.js";
import { makeExec, makeTestSandbox, withTempBytes, withTempFile } from "../support/fixtures.js";

const SESSION = "sre-gates";

/** A fake tool-run context for the gate calls (the tools never touch deferContext/concludeTurn). */
function execFor(cwd: string, params: unknown): ToolRunContext {
  return makeExec(cwd, SESSION)(params) as unknown as ToolRunContext;
}

type ViewResult = { text: string; warning?: string };

beforeEach(() => {
  clearEncodingState();
  clearAutoGuessFooter();
  _resetConfigCache();
  delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
});

afterEach(() => {
  clearEncodingState();
  clearAutoGuessFooter();
  delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
  _resetConfigCache();
});

describe("str_replace_editor — encoding auto-guess on view", () => {
  it("decodes a GBK file through autoGuess", async () => {
    const body =
      "你好世界，这是一个用于编码检测的长段落。\n第二行内容也是中文。\n第三行继续添加更多中文字符以提高置信度。";
    await withTempBytes("gbk.txt", iconv.encode(body, "gbk"), async ({ cwd, path }) => {
      process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
      _resetConfigCache();
      const tool = buildStrReplaceEditorTool(localIO(), makeTestSandbox());
      const params = { command: "view", path };
      const res = (await tool.execute(params, execFor(cwd, params))) as unknown as ViewResult;
      expect(res.text).toContain("你好世界");
      expect(res.warning === undefined || (res.warning ?? "").includes("Auto-guessed")).toBe(true);
    });
  });

  it("surfaces an uncertain short-GBK guess as a second rendered block", async () => {
    await withTempBytes("gbk-short.txt", iconv.encode("你好世界", "gbk"), async ({ cwd, path }) => {
      process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
      _resetConfigCache();
      const tool = buildStrReplaceEditorTool(localIO(), makeTestSandbox());
      const params = { command: "view", path };
      const res = (await tool.execute(params, execFor(cwd, params))) as unknown as ViewResult;
      expect(res.warning ?? "").toContain("Auto-guessed");
      const blocks = (
        tool as unknown as { output: { render(a: unknown, v: unknown): Array<{ text: string }> } }
      ).output.render({ path }, res);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]!.text).toBe(res.text);
      expect(blocks[1]!.text).toBe(res.warning);
    });
  });
});

describe("str_replace_editor — write gates", () => {
  it("rejects a blind str_replace without a prior view, leaving the file untouched", async () => {
    await withTempFile("blind.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const tool = buildStrReplaceEditorTool(localIO(), makeTestSandbox());
      const params = { command: "str_replace", path, old_str: "beta", new_str: "BETA" };
      await expect(tool.execute(params, execFor(cwd, params))).rejects.toThrow(
        /E_BLIND_REPLACE.*has not been viewed/,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("rejects a blind insert without a prior view, leaving the file untouched", async () => {
    await withTempFile("blind2.txt", "a\nb\n", async ({ cwd, path }) => {
      const tool = buildStrReplaceEditorTool(localIO(), makeTestSandbox());
      const params = { command: "insert", path, insert_line: 1, new_str: "x" };
      await expect(tool.execute(params, execFor(cwd, params))).rejects.toThrow(
        /E_BLIND_REPLACE.*has not been viewed/,
      );
      expect(await readFile(path, "utf-8")).toBe("a\nb\n");
    });
  });

  it("preserves a UTF-8 BOM across view → str_replace", async () => {
    const seeded = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("hello\nworld\n", "utf-8"),
    ]);
    await withTempBytes("bom.txt", seeded, async ({ cwd, path }) => {
      const tool = buildStrReplaceEditorTool(localIO(), makeTestSandbox());
      const viewParams = { command: "view", path };
      await tool.execute(viewParams, execFor(cwd, viewParams));
      const replaceParams = { command: "str_replace", path, old_str: "world", new_str: "there" };
      const res = (await tool.execute(replaceParams, execFor(cwd, replaceParams))) as unknown as {
        text: string;
      };
      expect(res.text).toMatch(/Replaced 1 occurrence/);
      const raw = await readFile(path);
      expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]);
      expect(raw.toString("utf-8")).toContain("there");
    });
  });

  it("requires old_str to match exactly once", async () => {
    await withTempFile("dup.txt", "same\nsame\n", async ({ cwd, path }) => {
      const tool = buildStrReplaceEditorTool(localIO(), makeTestSandbox());
      const viewParams = { command: "view", path };
      await tool.execute(viewParams, execFor(cwd, viewParams));
      const missing = { command: "str_replace", path, old_str: "missing", new_str: "x" };
      await expect(tool.execute(missing, execFor(cwd, missing))).rejects.toThrow(/not found/);
      const twice = { command: "str_replace", path, old_str: "same", new_str: "x" };
      await expect(tool.execute(twice, execFor(cwd, twice))).rejects.toThrow(/multiple/);
    });
  });
});
