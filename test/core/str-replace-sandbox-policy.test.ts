/**
 * Regression for the shadow `str_replace_editor` missing sandbox policy.
 *
 * The built-in `str_replace_editor` and the hashline `edit` / `undo_last_edit`
 * paths stamp `ctx.sandboxPolicy.resolve({ session })` onto every provider
 * write. The shadow did not, so a confining backend fell back to the deployment
 * default root and denied every `create` / `str_replace` / `insert` under
 * `workspace-write` — including targets inside the session workspace.
 *
 * The fake `ctx.fs` below enforces the real boundary — `writeText` refuses
 * unless the per-call policy is present and covers the target — so dropping the
 * policy again (the bug) fails these tests instead of only the real host.
 * @module dsh-better-edit/str-replace-sandbox-policy.test
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FsError } from "@deepseek-ai/dsh-fs";
import type { Context } from "@deepseek-ai/cordis";
import {
  clearAutoGuessFooter,
  clearEncodingState,
  ctxFsIO,
  localIO,
  type FileIO,
} from "../../src/fs-bridge.js";
import { FsSandboxController } from "../../src/sandbox.js";
import { buildStrReplaceEditorTool } from "../../src/tool-str-replace-editor.js";
import { makeTestSandbox } from "../support/fixtures.js";

const WS_ROOT = "/abs/ws";
const OUTSIDE = "/outside";

interface StampedPolicy {
  mode: string;
  workspaceRoot: string;
}

/** In-memory confining `ctx.fs`: BOM-stripping reads + workspace-write writes. */
function makeConfinedFs() {
  const files = new Map<string, { bytes: Buffer; version: number }>();
  const writes: Array<{ path: string; content: string; policy: StampedPolicy | undefined }> = [];
  let seq = 1;
  const keyOf = (t: unknown): string =>
    typeof t === "string"
      ? t
      : ((t as { targetKey?: string }).targetKey ??
        (t as { displayPath?: string }).displayPath ??
        "");
  const fs = {
    resolve: vi.fn(async (p: string) => ({ targetKey: String(p), displayPath: String(p) })),
    processPath: vi.fn((t: unknown) => keyOf(t)),
    readText: vi.fn(async (t: unknown) => {
      const f = files.get(keyOf(t));
      if (!f) throw Object.assign(new Error("not found"), { code: "FS_NOT_FOUND" });
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(f.bytes);
      return raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
    }),
    stat: vi.fn(async (t: unknown) => {
      const f = files.get(keyOf(t));
      if (!f) throw Object.assign(new Error("not found"), { code: "FS_NOT_FOUND" });
      return { version: `v${f.version}`, type: "file", size: f.bytes.length };
    }),
    writeText: vi.fn(
      async (
        t: unknown,
        content: string,
        _intent?: unknown,
        _signal?: unknown,
        policy?: StampedPolicy,
      ) => {
        const p = keyOf(t);
        writes.push({ path: p, content, policy });
        // A missing policy falls back to the deployment default root, whose
        // workspace-write boundary does not cover the session workspace.
        const root = policy?.mode === "danger-full-access" ? undefined : policy?.workspaceRoot;
        const contained =
          policy !== undefined &&
          (policy.mode === "danger-full-access" ||
            (root !== undefined && (p === root || p.startsWith(`${root}/`))));
        if (!contained) {
          throw new FsError(
            `cannot write "${p}": file access denied under workspace-write mode`,
            "FS_SANDBOX_DENIED" as never,
          );
        }
        const cur = files.get(p);
        const version = (cur?.version ?? 0) + 1;
        files.set(p, { bytes: Buffer.from(content, "utf-8"), version });
        return { version: `v${version}`, operation: "update", before: "", after: content };
      },
    ),
  };
  return {
    fs,
    writes,
    seed(p: string, text: string) {
      files.set(p, { bytes: Buffer.from(text, "utf-8"), version: seq++ });
    },
    readText(p: string) {
      return files.get(p)!.bytes.toString("utf-8");
    },
  };
}

/** A confining composition: `ctx.fs.sandboxMode` set + `sandboxPolicy` service. */
function makeConfinedCtx() {
  const policyResolve = vi.fn((request?: { session?: { header?: { cwd?: string } } }) => ({
    mode: "workspace-write",
    workspaceRoot: request?.session?.header?.cwd ?? WS_ROOT,
  }));
  const approvalRequest = vi.fn(async () => "allowed-once");
  const ctx = {
    fs: { sandboxMode: "workspace-write" },
    get: (service: string) =>
      service === "sandboxPolicy"
        ? { resolve: policyResolve }
        : service === "approval"
          ? { request: approvalRequest }
          : undefined,
  };
  return { ctx, policyResolve, approvalRequest };
}

/** The host-plane context `ctxFsIO` needs (`fs/write-intent` waterfall + `fs/observed`). */
function makeIoCtx() {
  return { waterfall: vi.fn(async () => undefined), emit: vi.fn(() => {}) } as unknown as Context;
}

function fakeExec(cwd: string, session = "sre-sandbox") {
  return {
    signal: new AbortController().signal,
    callId: "call-1",
    agent: { id: session, session: { id: session, header: { cwd } } },
  } as never;
}

function paramsOf(tool: unknown): Record<string, unknown> {
  const p = (tool as { parameters: unknown }).parameters as Record<string, unknown>;
  if (p && typeof p === "object" && "properties" in p)
    return p["properties"] as Record<string, unknown>;
  return p;
}

function confinedTool() {
  const fake = makeConfinedFs();
  const composition = makeConfinedCtx();
  const io: FileIO = ctxFsIO(fake.fs as never, makeIoCtx());
  const tool = buildStrReplaceEditorTool(io, new FsSandboxController(composition.ctx as never));
  return { fake, tool, ...composition };
}

beforeEach(() => {
  clearEncodingState();
  clearAutoGuessFooter();
});

describe("shadow str_replace_editor stamps the sandbox policy", () => {
  it("view -> str_replace carries the session workspace root", async () => {
    const { fake, tool, policyResolve } = confinedTool();
    const p = `${WS_ROOT}/f.txt`;
    fake.seed(p, "alpha\r\nbravo\r\ncharlie\r\n");
    const exec = fakeExec(WS_ROOT);

    await tool.execute({ command: "view", path: p }, exec);
    const res = (await tool.execute(
      { command: "str_replace", path: p, old_str: "bravo", new_str: "BRAVO" },
      exec,
    )) as unknown as { text: string };

    expect(res.text).toMatch(/Replaced 1 occurrence/);
    expect(fake.readText(p)).toContain("BRAVO");
    expect(policyResolve).toHaveBeenCalled();
    const stamped = fake.writes[fake.writes.length - 1]!;
    expect(stamped.policy?.mode).toBe("workspace-write");
    expect(stamped.policy?.workspaceRoot).toBe(WS_ROOT);
  });

  it("insert carries the policy", async () => {
    const { fake, tool } = confinedTool();
    const p = `${WS_ROOT}/insert.txt`;
    fake.seed(p, "alpha\nbravo\n");
    const exec = fakeExec(WS_ROOT);

    await tool.execute({ command: "view", path: p }, exec);
    const res = (await tool.execute(
      { command: "insert", path: p, insert_line: 1, new_str: "top" },
      exec,
    )) as unknown as { text: string };

    expect(res.text).toMatch(/Inserted/);
    expect(fake.readText(p)).toContain("top");
    expect(fake.writes[fake.writes.length - 1]!.policy?.workspaceRoot).toBe(WS_ROOT);
  });

  it("create carries the policy", async () => {
    const { fake, tool } = confinedTool();
    const p = `${WS_ROOT}/created.txt`;
    const exec = fakeExec(WS_ROOT);

    const res = (await tool.execute(
      { command: "create", path: p, file_text: "fresh\n" },
      exec,
    )) as unknown as { text: string };

    expect(res.text).toMatch(/Created/);
    expect(fake.readText(p)).toBe("fresh\n");
    expect(fake.writes[fake.writes.length - 1]!.policy?.workspaceRoot).toBe(WS_ROOT);
  });

  it("a write outside the workspace fails with the shared sandbox marker + hint", async () => {
    const { fake, tool } = confinedTool();
    const p = `${OUTSIDE}/evil.txt`;
    fake.seed(p, "alpha\nbravo\n");
    const exec = fakeExec(WS_ROOT);

    await tool.execute({ command: "view", path: p }, exec);
    const error = (await tool
      .execute({ command: "str_replace", path: p, old_str: "bravo", new_str: "BRAVO" }, exec)
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toContain("[sandbox: file access denied under workspace-write mode]");
    expect(error.message).toContain("escalation available");
    expect(fake.readText(p)).toContain("bravo");
  });

  it("an approved one-shot escalation widens exactly this call", async () => {
    const { fake, tool, approvalRequest } = confinedTool();
    const p = `${OUTSIDE}/escalated.txt`;
    fake.seed(p, "alpha\nbravo\n");
    const exec = fakeExec(WS_ROOT);

    await tool.execute({ command: "view", path: p }, exec);
    const res = (await tool.execute(
      {
        command: "str_replace",
        path: p,
        old_str: "bravo",
        new_str: "BRAVO",
        sandbox_permissions: "danger-full-access",
        justification: "the target file lives outside the session workspace",
      },
      exec,
    )) as unknown as { text: string };

    expect(res.text).toMatch(/Replaced 1 occurrence/);
    expect(approvalRequest).toHaveBeenCalledTimes(1);
    expect(fake.writes[fake.writes.length - 1]!.policy?.mode).toBe("danger-full-access");
    expect(fake.readText(p)).toContain("BRAVO");
  });

  it("a non-widening escalation is rejected before any write", async () => {
    const { fake, tool, approvalRequest } = confinedTool();
    const p = `${WS_ROOT}/narrow.txt`;
    fake.seed(p, "alpha\nbravo\n");
    const exec = fakeExec(WS_ROOT);

    await tool.execute({ command: "view", path: p }, exec);
    const error = (await tool
      .execute(
        {
          command: "str_replace",
          path: p,
          old_str: "bravo",
          new_str: "BRAVO",
          sandbox_permissions: "workspace-write",
          justification: "same mode as the standing policy",
        },
        exec,
      )
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toMatch(/not strictly wider/);
    expect(approvalRequest).not.toHaveBeenCalled();
    expect(fake.readText(p)).toContain("bravo");
  });

  it("advertises the escalation params only under a confining composition", () => {
    const confined = paramsOf(confinedTool().tool);
    expect(confined).toHaveProperty("sandbox_permissions");
    expect(confined).toHaveProperty("justification");

    const open = paramsOf(buildStrReplaceEditorTool(localIO(), makeTestSandbox()));
    expect(open).not.toHaveProperty("sandbox_permissions");
    expect(open).not.toHaveProperty("justification");
  });
});
