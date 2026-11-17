/**
 * Shadow `str_replace_editor` read-first and match-arity gates.
 *
 * Version semantics belong to `str-replace-version-gate.test.ts`; sandbox
 * escalation policy to `str-replace-sandbox-policy.test.ts`. This file covers
 * the remaining gates: encoding auto-guess on `view` (its warning is a second
 * rendered block), the blind gate on `insert`, and `old_str`'s exactly-once
 * rule.
 * @module dsh-better-edit/str-replace-editor.gates.test
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    // Longer body: short GBK byte runs are valid Big5 too (detection-error
    // territory) — a paragraph lets the guesser settle on gbk.
    const body =
      "你好世界，这是一个用于编码检测的长段落。\n第二行内容也是中文。\n第三行继续添加更多中文字符以提高置信度。";
    await withTempBytes("gbk.txt", iconv.encode(body, "gbk"), async ({ cwd, path }) => {
      process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
      _resetConfigCache();
      const tool = buildStrReplaceEditorTool(localIO(), makeTestSandbox());
      const params = { command: "view", path };
      const res = (await tool.execute(params, execFor(cwd, params))) as unknown as ViewResult;
      expect(res.text).toContain("你好世界");
      // Decisive guess → no footer; mid-confidence guess → Auto-guessed footer (readAndServe parity).
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
      // Short GBK runs are valid Big5 too — the guesser stays uncertain and must say so.
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
  it("rejects a blind insert without a prior view", async () => {
    await withTempFile("blind2.txt", "a\nb\n", async ({ cwd, path }) => {
      const tool = buildStrReplaceEditorTool(localIO(), makeTestSandbox());
      const params = { command: "insert", path, insert_line: 1, new_str: "x" };
      await expect(tool.execute(params, execFor(cwd, params))).rejects.toThrow(
        /E_BLIND_REPLACE.*has not been viewed/,
      );
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
