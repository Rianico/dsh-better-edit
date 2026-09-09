import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import iconv from "iconv-lite";
import { localIO, clearEncodingState, clearAutoGuessFooter } from "../src/fs-bridge.js";
import { _resetConfigCache } from "../src/store-config.js";
import { buildStrReplaceEditorTool } from "../src/tool-str-replace-editor.js";

function fakeExec(cwd: string, session = "sre-test") {
  return {
    signal: new AbortController().signal,
    agent: { id: session, session: { id: session, header: { cwd } } },
  } as never;
}

describe("str_replace_editor shadow tool (TDD red)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sre-"));
    clearEncodingState();
    clearAutoGuessFooter();
    _resetConfigCache();
    delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    clearEncodingState();
    clearAutoGuessFooter();
    delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
    _resetConfigCache();
  });

  it("BOM round-trip: view -> str_replace preserves EF BB BF", async () => {
    const p = join(dir, "bom.txt");
    await writeFile(
      p,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\nworld\n", "utf-8")]),
    );
    const io = localIO();
    const tool = buildStrReplaceEditorTool(io);
    const exec = fakeExec(dir);
    await tool.execute({ command: "view", path: p }, exec);
    const res = (await tool.execute(
      { command: "str_replace", path: p, old_str: "world", new_str: "there" },
      exec,
    )) as unknown as { text: string };
    expect(res.text).toMatch(/Replaced 1 occurrence/);
    const raw = await readFile(p);
    expect(raw[0]).toBe(0xef);
    expect(raw[1]).toBe(0xbb);
    expect(raw[2]).toBe(0xbf);
    expect(raw.toString("utf-8")).toContain("there");
  });

  it("GBK file view decodes via autoGuess", async () => {
    const p = join(dir, "gbk.txt");
    // Longer body: short GBK byte runs are valid Big5 too (detection-error
    // territory) — a paragraph lets the guesser settle on gbk.
    const body =
      "你好世界，这是一个用于编码检测的长段落。\n第二行内容也是中文。\n第三行继续添加更多中文字符以提高置信度。";
    await writeFile(p, iconv.encode(body, "gbk"));
    process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
    _resetConfigCache();
    const io = localIO();
    const tool = buildStrReplaceEditorTool(io);
    const res = (await tool.execute({ command: "view", path: p }, fakeExec(dir))) as unknown as {
      text: string;
      warning?: string;
    };
    expect(res.text).toContain("你好世界");
    // Decisive guess → no footer; mid-confidence guess → Auto-guessed footer (readAndServe parity).
    expect(res.warning === undefined || (res.warning ?? "").includes("Auto-guessed")).toBe(true);
  });

  it("ambiguous bytes surface the autoGuess footer as warning (second block)", async () => {
    const p = join(dir, "gbk-short.txt");
    await writeFile(p, iconv.encode("你好世界", "gbk"));
    process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
    _resetConfigCache();
    const tool = buildStrReplaceEditorTool(localIO());
    const res = (await tool.execute({ command: "view", path: p }, fakeExec(dir))) as unknown as {
      text: string;
      warning?: string;
    };
    // Short GBK runs are valid Big5 too — the guesser stays uncertain and must say so.
    expect(res.warning ?? "").toContain("Auto-guessed");
    const blocks = (
      tool as unknown as { output: { render(a: unknown, v: unknown): Array<{ text: string }> } }
    ).output.render({ path: p }, res);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe(res.text);
    expect(blocks[1]!.text).toBe(res.warning);
  });

  it("undecodable view fails loud with Top-3 (E_UNSUPPORTED_FILE)", async () => {
    const throwingIO = {
      ...localIO(),
      readText: async () => {
        throw new Error(
          `[MODEL] [E_UNSUPPORTED_FILE] Path is not a readable UTF-8 text file: x. Top-3 guesses: gbk("a"), big5("b"), shift_jis("c"). Try read({encoding: "<encoding>"})`,
        );
      },
    } as unknown as ReturnType<typeof localIO>;
    const tool = buildStrReplaceEditorTool(throwingIO);
    await expect(
      tool.execute({ command: "view", path: join(dir, "x.bin") }, fakeExec(dir)),
    ).rejects.toThrow(/E_UNSUPPORTED_FILE/);
  });

  it("blind str_replace without prior view -> E_BLIND_REPLACE, no disk write", async () => {
    const p = join(dir, "blind.txt");
    await writeFile(p, "alpha\nbeta\n", "utf-8");
    const io = localIO();
    const tool = buildStrReplaceEditorTool(io);
    await expect(
      tool.execute(
        { command: "str_replace", path: p, old_str: "beta", new_str: "BETA" },
        fakeExec(dir),
      ),
    ).rejects.toThrow(/E_BLIND_REPLACE/);
    expect(await readFile(p, "utf-8")).toBe("alpha\nbeta\n");
  });

  it("blind insert without prior view -> E_BLIND_REPLACE", async () => {
    const p = join(dir, "blind2.txt");
    await writeFile(p, "a\nb\n", "utf-8");
    const tool = buildStrReplaceEditorTool(localIO());
    await expect(
      tool.execute({ command: "insert", path: p, insert_line: 1, new_str: "x" }, fakeExec(dir)),
    ).rejects.toThrow(/E_BLIND_REPLACE/);
  });

  it("old_str must match exactly once", async () => {
    const p = join(dir, "dup.txt");
    await writeFile(p, "same\nsame\n", "utf-8");
    const tool = buildStrReplaceEditorTool(localIO());
    const exec = fakeExec(dir);
    await tool.execute({ command: "view", path: p }, exec);
    await expect(
      tool.execute({ command: "str_replace", path: p, old_str: "missing", new_str: "x" }, exec),
    ).rejects.toThrow(/not found/);
    await expect(
      tool.execute({ command: "str_replace", path: p, old_str: "same", new_str: "x" }, exec),
    ).rejects.toThrow(/multiple/);
  });
});
