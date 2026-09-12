import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localIO, clearEncodingState, clearAutoGuessFooter } from "../../src/fs-bridge.js";
import { buildStrReplaceEditorTool } from "../../src/tool-str-replace-editor.js";
import { FsSandboxController } from "../../src/sandbox.js";

/** No confining backend: no escalation fields, `resolvePolicy` → undefined. */
const noSandbox = () =>
  new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);

function fakeExec(cwd: string, session = "sre-contract") {
  return {
    signal: new AbortController().signal,
    agent: { id: session, session: { id: session, header: { cwd } } },
  } as never;
}

describe("str_replace_editor contract parity", () => {
  function paramsOf(tool: unknown): Record<string, unknown> {
    const p = (tool as { parameters: unknown }).parameters as Record<string, unknown>;
    // defineTool compiles ValueSchemaSpec into JSON Schema: {type:'object', properties:{...}}
    if (p && typeof p === "object" && "properties" in p)
      return p["properties"] as Record<string, unknown>;
    return p;
  }
  it("tool name is str_replace_editor with built-in command params and no encoding param", () => {
    const tool = buildStrReplaceEditorTool(localIO(), noSandbox()) as unknown as {
      name: string;
      parameters: Record<string, unknown>;
    };
    const params = paramsOf(tool);
    expect(tool.name).toBe("str_replace_editor");
    for (const key of [
      "command",
      "path",
      "view_range",
      "old_str",
      "new_str",
      "insert_line",
      "file_text",
    ]) {
      expect(params, `missing param ${key}`).toHaveProperty(key);
    }
    expect(params).not.toHaveProperty("encoding");
  });

  it("view_range slices 1-indexed inclusive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sre-c-"));
    try {
      clearEncodingState();
      clearAutoGuessFooter();
      const p = join(dir, "f.txt");
      await writeFile(p, "l1\nl2\nl3\nl4\n", "utf-8");
      const tool = buildStrReplaceEditorTool(localIO(), noSandbox());
      const exec = fakeExec(dir);
      const res = (await tool.execute(
        { command: "view", path: p, view_range: [2, 3] },
        exec,
      )) as unknown as { text: string };
      expect(res.text).toContain("l2");
      expect(res.text).toContain("l3");
      expect(res.text).not.toContain("l1\n");
      expect(res.text).not.toContain("l4");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("insert + create round-trip; create fails when file exists; undo_edit unsupported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sre-c2-"));
    try {
      clearEncodingState();
      clearAutoGuessFooter();
      const io = localIO();
      const tool = buildStrReplaceEditorTool(io, noSandbox());
      const exec = fakeExec(dir);
      const created = join(dir, "new.txt");
      const c = (await tool.execute(
        { command: "create", path: created, file_text: "a\nb\n" },
        exec,
      )) as unknown as { text: string };
      expect(c.text).toContain("new.txt");
      await expect(
        tool.execute({ command: "create", path: created, file_text: "x" }, exec),
      ).rejects.toThrow(/already exists/);
      await tool.execute({ command: "view", path: created }, exec);
      await tool.execute(
        { command: "insert", path: created, insert_line: 1, new_str: "top" },
        exec,
      );
      const v = (await tool.execute({ command: "view", path: created }, exec)) as unknown as {
        text: string;
      };
      expect(v.text.split("\n")[0]).toContain("top");
      await expect(tool.execute({ command: "undo_edit", path: created }, exec)).rejects.toThrow(
        /E_UNSUPPORTED/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("unknown command rejected", async () => {
    const tool = buildStrReplaceEditorTool(localIO(), noSandbox());
    await expect(
      tool.execute({ command: "delete", path: "x" }, fakeExec(tmpdir())),
    ).rejects.toThrow(/E_BAD_COMMAND|unknown command/i);
  });
});
