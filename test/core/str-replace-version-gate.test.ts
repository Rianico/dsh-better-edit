/**
 * Regression for #69: shadow `str_replace_editor` read-first gate vs
 * `version: undefined` encoding state.
 *
 * Uses a fake `ctx.fs` with production `ctxFsIO` version semantics
 * (dsh-fs-local strips BOM via TextDecoder, versions are non-empty strings):
 * `view`/`read` must authorize `str_replace`/`insert`, while an external
 * change must still fail loud with E_BLIND_REPLACE.
 * @module dsh-better-edit/str-replace-version-gate.test
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { ctxFsIO, type FileIO } from "../../src/fs-bridge.js";
import { clearEncodingState, clearAutoGuessFooter } from "../../src/fs-bridge.js";
import { buildStrReplaceEditorTool } from "../../src/tool-str-replace-editor.js";

function fakeExec(cwd: string, session = "sre-vgate") {
  return {
    signal: new AbortController().signal,
    agent: { id: session, session: { id: session, header: { cwd } } },
  } as never;
}

/** In-memory fake ctx.fs mimicking dsh-fs-local: BOM-stripping readText + versioned stat. */
function makeProdFs() {
  const files = new Map<string, { bytes: Buffer; version: number }>();
  let seq = 1;
  const pathOf = (t: unknown) =>
    typeof t === "string" ? t : ((t as { displayPath?: string }).displayPath ?? "/abs/file.txt");
  const fs = {
    resolve: vi.fn(async (p: string) => ({
      targetKey: `/abs/${String(p).split("/").pop()}`,
      displayPath: p,
    })),
    processPath: vi.fn((t: unknown) => pathOf(t)),
    readText: vi.fn(async (t: unknown) => {
      const p = pathOf(t);
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("not found"), { code: "FS_NOT_FOUND" });
      // dsh-fs-local decodes with TextDecoder utf-8 fatal, ignoreBOM:false -> swallows EF BB BF
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(f.bytes);
      return raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
    }),
    readBytes: vi.fn(async (t: unknown, _s?: unknown, n?: number) => {
      const p = pathOf(t);
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("not found"), { code: "FS_NOT_FOUND" });
      return new Uint8Array(f.bytes.subarray(0, n ?? f.bytes.length));
    }),
    stat: vi.fn(async (t: unknown) => {
      const p = pathOf(t);
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("not found"), { code: "FS_NOT_FOUND" });
      return { version: `v${f.version}`, type: "file", size: f.bytes.length };
    }),
    writeText: vi.fn(async (t: unknown, content: string) => {
      const p = pathOf(t);
      const cur = files.get(p);
      const version = (cur?.version ?? 0) + 1;
      files.set(p, { bytes: Buffer.from(content, "utf-8"), version });
      return { version: `v${version}`, operation: "update", before: "", after: content };
    }),
  };
  return {
    fs,
    seed(p: string, bytes: Buffer) {
      files.set(p, { bytes, version: seq++ });
    },
    externalWrite(p: string, bytes: Buffer) {
      const cur = files.get(p);
      files.set(p, { bytes, version: (cur?.version ?? 0) + 100 });
    },
    readRaw(p: string) {
      return files.get(p)!.bytes;
    },
  };
}

function makeCtx() {
  const ctx = {
    waterfall: vi.fn(async () => undefined),
    emit: vi.fn(() => {}),
  } as unknown as Context;
  return ctx;
}

beforeEach(() => {
  clearEncodingState();
  clearAutoGuessFooter();
});

describe("issue #69: ctxFsIO version semantics authorize shadow writes", () => {
  it("view -> str_replace succeeds on BOM-stripped production path, preserving BOM+CRLF", async () => {
    const fake = makeProdFs();
    const p = "/abs/bom.txt";
    fake.seed(
      p,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("alpha\r\nbravo\r\ncharlie\r\n", "utf-8"),
      ]),
    );
    const io: FileIO = ctxFsIO(fake.fs as never, makeCtx());
    const tool = buildStrReplaceEditorTool(io);
    const exec = fakeExec("/abs");
    await tool.execute({ command: "view", path: p }, exec);
    const res = (await tool.execute(
      { command: "str_replace", path: p, old_str: "bravo", new_str: "bravo-edited" },
      exec,
    )) as unknown as { text: string };
    expect(res.text).toMatch(/Replaced 1 occurrence/);
    const raw = fake.readRaw(p);
    expect(raw[0]).toBe(0xef);
    expect(raw[1]).toBe(0xbb);
    expect(raw[2]).toBe(0xbf);
    expect(raw.toString("utf-8")).toContain("bravo-edited");
    expect(raw.toString("utf-8")).toContain("\r\n");
  });

  it("view -> insert succeeds on no-BOM production path", async () => {
    const fake = makeProdFs();
    const p = "/abs/nobom.txt";
    fake.seed(p, Buffer.from("alpha\r\nbravo\r\ncharlie\r\n", "utf-8"));
    const io: FileIO = ctxFsIO(fake.fs as never, makeCtx());
    const tool = buildStrReplaceEditorTool(io);
    const exec = fakeExec("/abs");
    await tool.execute({ command: "view", path: p }, exec);
    const res = (await tool.execute(
      { command: "insert", path: p, insert_line: 2, new_str: "inserted" },
      exec,
    )) as unknown as { text: string };
    expect(res.text).toMatch(/Inserted/);
    expect(fake.readRaw(p).toString("utf-8")).toContain("inserted");
  });

  it("hashline read (io.readText) -> str_replace works", async () => {
    const fake = makeProdFs();
    const p = "/abs/hash.txt";
    fake.seed(p, Buffer.from("alpha\r\nbravo\r\ncharlie\r\n", "utf-8"));
    const io: FileIO = ctxFsIO(fake.fs as never, makeCtx());
    const tool = buildStrReplaceEditorTool(io);
    const exec = fakeExec("/abs");
    // hashline read observation path: same io.readText seam the read tool uses
    await io.readText(p);
    const res = (await tool.execute(
      { command: "str_replace", path: p, old_str: "bravo", new_str: "BRAVO" },
      exec,
    )) as unknown as { text: string };
    expect(res.text).toMatch(/Replaced 1 occurrence/);
  });

  it("external change after view still fails loud with E_BLIND_REPLACE", async () => {
    const fake = makeProdFs();
    const p = "/abs/drift.txt";
    fake.seed(p, Buffer.from("alpha\r\nbravo\r\ncharlie\r\n", "utf-8"));
    const io: FileIO = ctxFsIO(fake.fs as never, makeCtx());
    const tool = buildStrReplaceEditorTool(io);
    const exec = fakeExec("/abs");
    await tool.execute({ command: "view", path: p }, exec);
    fake.externalWrite(p, Buffer.from("alpha\r\nCHANGED\r\ncharlie\r\n", "utf-8"));
    await expect(
      tool.execute({ command: "str_replace", path: p, old_str: "alpha", new_str: "ALPHA" }, exec),
    ).rejects.toThrow(/E_BLIND_REPLACE/);
  });
});
