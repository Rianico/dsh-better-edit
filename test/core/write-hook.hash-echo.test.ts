import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {
  PostToolDecision,
  PreToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { readAndServe } from "../../src/read-and-serve.js";
import { withWorkspace } from "../../src/workspace-context.js";
import {
  findServedHashEcho,
  registerWriteHook,
  servedHashEchoDenial,
} from "../../src/write-hook.js";
import { localIO } from "../../src/fs-bridge.js";
import { withTempDir } from "../support/fixtures.js";

type PreExecuteListener = (
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
) => Promise<PreToolDecision>;

describe("write hash-echo guard", () => {
  it("allows clean content and unrelated literal hash-like text", () => {
    const served = ["Ab3", "Cd4", null];
    expect(findServedHashEcho("# Notes\nbody\n", served)).toBeUndefined();
    expect(findServedHashEcho("Zz9│literal protocol text\nbody\n", served)).toBeUndefined();
    expect(findServedHashEcho("prefix Ab3│is ordinary text\nbody\n", served)).toBeUndefined();
  });

  it("matches only the exact served anchor at the same line", () => {
    const served = ["Ab3", "Cd4"];
    expect(findServedHashEcho("Ab3│# Notes\nbody\n", served)).toEqual({
      line: 1,
      hash: "Ab3",
    });
    expect(findServedHashEcho("Cd4│wrong line\nAb3│wrong line\n", served)).toBeUndefined();
  });

  it("catches a repeated historical chain when its outer anchor is current", () => {
    expect(findServedHashEcho("Ab3│nT2│CCd│UIA│## 1. H1\n", ["Ab3"])).toEqual({
      line: 1,
      hash: "Ab3",
    });
  });

  it("rejects a copied current preview before the write body can change disk", async () => {
    await withTempDir("write-hash-echo-red-", async (cwd) => {
      const path = join(cwd, "notes.md");
      const original = "# Notes\nbody\n";
      await writeFile(path, original, "utf-8");
      const beforeBytes = await readFile(path);

      const io = localIO();
      const sessionKey = "session-a";
      const preview = await withWorkspace(cwd, () => readAndServe(io, path, cwd, { sessionKey }));
      const listeners = new Map<string, unknown>();
      const agentCtx = {
        on(event: string, listener: unknown) {
          listeners.set(event, listener);
          return () => undefined;
        },
      } as unknown as Context;
      const rootCtx = {
        logger: { warn: vi.fn() },
      } as unknown as Context;
      registerWriteHook(rootCtx, agentCtx, io);

      const listener = listeners.get("tools/pre-execute") as PreExecuteListener | undefined;
      expect(listener).toBeDefined();
      if (!listener) return;

      const next = vi.fn(async (): Promise<PreToolDecision> => ({
        kind: "allow",
      }));
      const decision = await listener(
        {
          name: "write",
          arguments: { file_path: path, content: preview.text },
          signal: new AbortController().signal,
          agent: {
            id: sessionKey,
            session: { id: sessionKey, header: { cwd } },
          },
        } as unknown as ToolExecution,
        next,
      );

      expect(decision).toMatchObject({ kind: "deny" });
      expect((decision as { reason?: string }).reason).toContain("[E_SUSPICIOUS_TEXT]");
      expect(next).not.toHaveBeenCalled();
      expect(await readFile(path)).toEqual(beforeBytes);

      const cleanNext = vi.fn(async (): Promise<PreToolDecision> => ({ kind: "allow" }));
      const cleanDecision = await listener(
        {
          name: "write",
          arguments: { file_path: path, content: "# Updated\nbody\n" },
          signal: new AbortController().signal,
          agent: {
            id: sessionKey,
            session: { id: sessionKey, header: { cwd } },
          },
        } as unknown as ToolExecution,
        cleanNext,
      );
      expect(cleanDecision).toEqual({ kind: "allow" });
      expect(cleanNext).toHaveBeenCalledOnce();
      expect(await readFile(path)).toEqual(beforeBytes);
    });
  });

  it("does not reuse served state across sessions or canonical paths", async () => {
    await withTempDir("write-hash-echo-scope-", async (cwd) => {
      const io = localIO();
      const servedPath = join(cwd, "served.md");
      const otherPath = join(cwd, "other.md");
      await writeFile(servedPath, "served line\n", "utf-8");
      await writeFile(otherPath, "other line\n", "utf-8");
      const preview = await withWorkspace(cwd, () =>
        readAndServe(io, servedPath, cwd, { sessionKey: "session-a" }),
      );

      await expect(
        withWorkspace(cwd, () =>
          servedHashEchoDenial(io, servedPath, preview.text, cwd, "session-b"),
        ),
      ).resolves.toBeUndefined();
      await expect(
        withWorkspace(cwd, () =>
          servedHashEchoDenial(io, otherPath, preview.text, cwd, "session-a"),
        ),
      ).resolves.toBeUndefined();
    });
  });
});

type PostExecuteListener = (
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  next: () => Promise<PostToolDecision>,
) => Promise<PostToolDecision>;

/** Register the hook and return its post-execute listener plus the warn sink. */
function makePostHook(io: ReturnType<typeof localIO>) {
  const listeners = new Map<string, unknown>();
  const agentCtx = {
    on(event: string, listener: unknown) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  } as unknown as Context;
  const warn = vi.fn();
  const rootCtx = { logger: { warn } } as unknown as Context;
  registerWriteHook(rootCtx, agentCtx, io);
  const post = listeners.get("tools/post-execute") as PostExecuteListener | undefined;
  if (!post) throw new Error("registerWriteHook registered no tools/post-execute listener");
  return { post, warn };
}

/** A settled successful `write` result (the host's own content). */
function writeResult(): Readonly<ToolExecutionResult> {
  return { isError: false, value: null, content: [] };
}

function makeWriteExec(cwd: string, path: string): ToolExecution {
  return {
    name: "write",
    arguments: { file_path: path, content: "alpha\nbeta\n" },
    signal: new AbortController().signal,
    agent: { id: "write-hook-session", session: { id: "write-hook-session", header: { cwd } } },
  } as unknown as ToolExecution;
}

describe("write auto-read post-execute", () => {
  it("records the observation once with the served path, execution, and signal", async () => {
    await withTempDir("write-hook-observe-", async (cwd) => {
      const path = join(cwd, "observe.txt");
      await writeFile(path, "alpha\nbeta\n", "utf-8");

      const emitObserved = vi.fn(async () => {});
      const io = { ...localIO(), emitObserved };
      const { post, warn } = makePostHook(io);
      const exec = makeWriteExec(cwd, path);

      const decision = await post(exec, writeResult(), async () => ({
        kind: "accept",
        content: [],
      }));

      expect(decision.kind).toBe("accept");
      if (decision.kind !== "accept") return;
      // The anchors above are only usable if the policy gate knows this version was seen.
      expect(emitObserved).toHaveBeenCalledOnce();
      expect(emitObserved).toHaveBeenCalledWith(await io.resolve(path, cwd), exec, exec.signal);
      expect(JSON.stringify(decision.content)).toContain("Auto-read (hashline anchors)");
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("emits for an empty file too (observation and anchor-usability are orthogonal)", async () => {
    await withTempDir("write-hook-observe-empty-", async (cwd) => {
      const path = join(cwd, "empty.txt");
      await writeFile(path, "", "utf-8");

      const emitObserved = vi.fn(async () => {});
      const io = { ...localIO(), emitObserved };
      const { post } = makePostHook(io);

      const decision = await post(makeWriteExec(cwd, path), writeResult(), async () => ({
        kind: "accept",
        content: [],
      }));

      expect(decision.kind).toBe("accept");
      expect(emitObserved).toHaveBeenCalledOnce();
    });
  });

  it("keeps the write accept decision and warns when the observation faults", async () => {
    await withTempDir("write-hook-observe-fail-", async (cwd) => {
      const path = join(cwd, "observe.txt");
      await writeFile(path, "alpha\nbeta\n", "utf-8");

      const io = {
        ...localIO(),
        emitObserved: vi.fn(async () => {
          throw Object.assign(new Error("stat exploded"), { code: "FS_NOT_FOUND" });
        }),
      };
      const { post, warn } = makePostHook(io);
      const original = {
        kind: "accept",
        content: [{ type: "text", text: "write ok" }],
      } as PostToolDecision;

      const decision = await post(makeWriteExec(cwd, path), writeResult(), async () => original);

      // Fail-open: the write result stands and the fault is only logged.
      expect(decision).toBe(original);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain("auto-read after write failed");
    });
  });
});
