/**
 * Regression tests for the `fs/*` event-gate contract on {@link ctxFsIO}: the
 * hashline tools must dispatch `fs/write-intent` before writing and emit
 * `fs/observed` after reads/writes, exactly like the built-in tools — a
 * hashline tool that skipped them would leave the observation policy's version
 * stale and the next built-in write on the file would fail.
 * @module dsh-better-edit/fs-bridge.policy.test
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PostToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { ctxFsIO, type FileIO, getEncodingState, clearEncodingState } from "../../src/fs-bridge.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import { registerWriteHook } from "../../src/write-hook.js";
import { setupIntegrationTest, withTempDir } from "../support/fixtures.js";

beforeEach(() => {
  clearEncodingState();
});

/** A mock `ctx.fs` recording every call and returning scripted results. */
function makeFs(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const fs = {
    resolve: vi.fn(async () => ({
      targetKey: "tk-1",
      displayPath: "/abs/file.txt",
    })),
    processPath: vi.fn(() => "/abs/file.txt"),
    readText: vi.fn(async () => "hello\n"),
    readBytes: vi.fn(async () => new Uint8Array()),
    writeText: vi.fn(async () => ({
      version: "v2",
      operation: "update",
      before: "a",
      after: "b",
    })),
    stat: vi.fn(async () => ({ version: "v1" })),
    ...overrides,
  };
  return {
    fs,
    calls,
    record(name: string) {
      calls.push(name);
    },
  };
}

/** A mock Cordis context capturing waterfall/emit dispatches. */
function makeCtx() {
  const events: Array<{
    kind: "waterfall" | "emit";
    name: string;
    args: unknown[];
  }> = [];
  const ctx = {
    waterfall: vi.fn(async (name: string, ...args: unknown[]) => {
      events.push({ kind: "waterfall", name, args });
      // The single-slot default: the listener "decides" — simulate a
      // policy returning a version-guarded write intent.
      return { kind: "replaceIfVersion", version: "v1" };
    }),
    emit: vi.fn((name: string, ...args: unknown[]) => {
      events.push({ kind: "emit", name, args });
    }),
  } as unknown as Context;
  return { ctx, events };
}

const exec = { agent: { session: { id: "sess-1" } } } as never;

describe("ctxFsIO readText", () => {
  it("restores a UTF-8 BOM stripped by the backend decoder", async () => {
    const text = "hello\r\n";
    const bytes = Buffer.from(`\uFEFF${text}`, "utf-8");
    const { fs } = makeFs({
      readText: vi.fn(async () => text),
      stat: vi.fn(async () => ({
        version: "v1",
        type: "file",
        size: bytes.length,
      })),
      readBytes: vi.fn(async () => bytes),
    });
    const { ctx } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await expect(io.readText("/abs/file.txt")).resolves.toBe(`\uFEFF${text}`);
    expect(fs.readBytes).toHaveBeenCalledWith(
      expect.objectContaining({ targetKey: "tk-1" }),
      undefined,
      bytes.length,
    );
  });

  it("does not read raw bytes when stat size matches the decoded UTF-8 text", async () => {
    const text = "hello\r\n";
    const { fs } = makeFs({
      readText: vi.fn(async () => text),
      stat: vi.fn(async () => ({
        version: "v1",
        type: "file",
        size: Buffer.byteLength(text, "utf-8"),
      })),
    });
    const { ctx } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await expect(io.readText("/abs/file.txt")).resolves.toBe(text);
    expect(fs.readBytes).not.toHaveBeenCalled();
  });

  it("does not invent a BOM when the three-byte size gap is not a BOM", async () => {
    const text = "hello\n";
    const bytes = Buffer.from(`xyz${text}`, "utf-8");
    const { fs } = makeFs({
      readText: vi.fn(async () => text),
      stat: vi.fn(async () => ({
        version: "v1",
        type: "file",
        size: bytes.length,
      })),
      readBytes: vi.fn(async () => bytes),
    });
    const { ctx } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await expect(io.readText("/abs/file.txt")).resolves.toBe(text);
    expect(fs.readBytes).toHaveBeenCalledOnce();
  });

  it("does not restore a BOM when the file changes between decoded and raw reads", async () => {
    const text = "hello\n";
    const changedBytes = Buffer.from("\uFEFFjello\n", "utf-8");
    const { fs } = makeFs({
      readText: vi.fn(async () => text),
      stat: vi.fn(async () => ({
        version: "v1",
        type: "file",
        size: changedBytes.length,
      })),
      readBytes: vi.fn(async () => changedBytes),
    });
    const { ctx } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await expect(io.readText("/abs/file.txt")).resolves.toBe(text);
    expect(fs.readBytes).toHaveBeenCalledOnce();
  });

  it("propagates stat failures from the integrity probe", async () => {
    const error = new Error("stat failed");
    const { fs } = makeFs({ stat: vi.fn(async () => Promise.reject(error)) });
    const { ctx } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await expect(io.readText("/abs/file.txt")).rejects.toBe(error);
  });

  it("propagates raw-read failures for BOM candidates", async () => {
    const text = "hello\n";
    const error = new Error("raw read failed");
    const { fs } = makeFs({
      readText: vi.fn(async () => text),
      stat: vi.fn(async () => ({
        version: "v1",
        type: "file",
        size: Buffer.byteLength(text, "utf-8") + 3,
      })),
      readBytes: vi.fn(async () => Promise.reject(error)),
    });
    const { ctx } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await expect(io.readText("/abs/file.txt")).rejects.toBe(error);
  });

  it("keeps a BOM already preserved by the backend without probing bytes (version stat allowed)", async () => {
    const text = "\uFEFFhello\n";
    const { fs } = makeFs({ readText: vi.fn(async () => text) });
    const { ctx } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await expect(io.readText("/abs/file.txt")).resolves.toBe(text);
    // No byte probe: BOM restoration must not read raw bytes when already preserved.
    expect(fs.readBytes).not.toHaveBeenCalled();
    // A version-only stat is required so the read-first gate records the real
    // version instead of undefined (issue #69 fix 2) — drift stays detectable.
    expect(getEncodingState("/abs/file.txt")?.version).toBe("v1");
  });
});

describe("ctxFsIO writeText", () => {
  it("dispatches fs/write-intent with (target, exec, default) and passes the returned intent to writeText", async () => {
    const { fs } = makeFs();
    const { ctx, events } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await io.writeText("/abs/file.txt", "content", undefined, exec);

    const waterfall = events.find((e) => e.kind === "waterfall" && e.name === "fs/write-intent");
    expect(waterfall).toBeTruthy();
    const [target, actor, fallback] = waterfall!.args as [unknown, unknown, unknown];
    expect(target).toMatchObject({ targetKey: "tk-1" });
    expect(actor).toBe(exec);
    expect(typeof fallback).toBe("function");

    expect(fs.writeText).toHaveBeenCalledWith(
      expect.objectContaining({ targetKey: "tk-1" }),
      "content",
      { kind: "replaceIfVersion", version: "v1" },
      undefined,
      undefined,
    );
  });

  it("emits fs/observed present with the outcome version after a successful write", async () => {
    const { fs } = makeFs();
    const { ctx, events } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await io.writeText("/abs/file.txt", "content", undefined, exec);

    const observed = events.find((e) => e.kind === "emit" && e.name === "fs/observed");
    expect(observed).toBeTruthy();
    const [target, observation, actor] = observed!.args as [unknown, unknown, unknown];
    expect(target).toMatchObject({ targetKey: "tk-1" });
    expect(observation).toEqual({ kind: "present", version: "v2" });
    expect(actor).toBe(exec);
  });

  it("uses the bare default (unconditional write) when no policy listener produces an intent", async () => {
    const { fs } = makeFs();
    const { ctx } = makeCtx();
    (ctx.waterfall as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await io.writeText("/abs/file.txt", "content");

    expect(fs.writeText).toHaveBeenCalledWith(
      expect.objectContaining({ targetKey: "tk-1" }),
      "content",
      undefined,
      undefined,
      undefined,
    );
  });

  it("maps FS_STALE_VERSION onto the hashline E_STALE_RANGE vocabulary", async () => {
    const stale = Object.assign(new Error("stale"), {
      code: "FS_STALE_VERSION",
    });
    const { fs } = makeFs({
      writeText: vi.fn(async () => {
        throw stale;
      }),
    });
    const { ctx } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await expect(io.writeText("/abs/file.txt", "x")).rejects.toThrow("[E_STALE_RANGE]");
  });
});

describe("ctxFsIO emitObserved", () => {
  it("stats the target and emits fs/observed present at the current version", async () => {
    const { fs } = makeFs();
    const { ctx, events } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await io.emitObserved("/abs/file.txt", exec);

    expect(fs.stat).toHaveBeenCalledWith(expect.objectContaining({ targetKey: "tk-1" }), undefined);
    const observed = events.find((e) => e.kind === "emit" && e.name === "fs/observed");
    expect(observed).toBeTruthy();
    expect(observed!.args[0]).toMatchObject({ targetKey: "tk-1" });
    expect(observed!.args[1]).toEqual({ kind: "present", version: "v1" });
    expect(observed!.args[2]).toBe(exec);
  });

  it("never throws when the target is gone (a failed observation must not fail the read)", async () => {
    const missing = Object.assign(new Error("gone"), { code: "FS_NOT_FOUND" });
    const { fs } = makeFs({
      stat: vi.fn(async () => {
        throw missing;
      }),
    });
    const { ctx } = makeCtx();
    const io: FileIO = ctxFsIO(fs as never, ctx);

    await expect(io.emitObserved("/abs/gone.txt", exec)).resolves.toBeUndefined();
  });
});

/**
 * A `ctx.fs` over the real filesystem that versions every path but records no
 * observation of its own — the host-write shape of the field failure (#109).
 * `hostWrite` models the built-in `write`: bytes land, nothing is emitted.
 */
function makeDiskFs() {
  const versions = new Map<string, string>();
  let counter = 0;
  const nextVersion = () => {
    counter += 1;
    return `v${counter}`;
  };
  const fs = {
    resolve: vi.fn(async (path: string) => ({
      targetKey: resolve(path),
      displayPath: resolve(path),
    })),
    processPath: (target: { targetKey: string }) => target.targetKey,
    readText: vi.fn(async (target: { targetKey: string }) => readFile(target.targetKey, "utf-8")),
    readBytes: vi.fn(
      async (target: { targetKey: string }) => new Uint8Array(await readFile(target.targetKey)),
    ),
    stat: vi.fn(async (target: { targetKey: string }) => {
      const info = await stat(target.targetKey);
      return { version: versions.get(target.targetKey) ?? "v0", type: "file", size: info.size };
    }),
    writeText: vi.fn(
      async (
        target: { targetKey: string },
        content: string,
        intent?: { kind: string; version?: string },
      ) => {
        const current = versions.get(target.targetKey) ?? "v0";
        // The backend answers a create on an existing file exactly like dsh-fs.
        if (intent?.kind === "createIfAbsent" && versions.has(target.targetKey)) {
          throw Object.assign(new Error("file exists but was never observed"), {
            code: "FS_NOT_OBSERVED",
          });
        }
        if (intent?.kind === "replaceIfVersion" && intent.version !== current) {
          throw Object.assign(new Error(`stale: intent ${intent.version} current ${current}`), {
            code: "FS_STALE_VERSION",
          });
        }
        const version = nextVersion();
        await writeFile(target.targetKey, content, "utf-8");
        versions.set(target.targetKey, version);
        return { version, operation: "update", before: "", after: "" };
      },
    ),
  };
  return {
    fs,
    /** The host `write` outcome: bytes land, no `fs/observed` is recorded. */
    async hostWrite(path: string, content: string) {
      await writeFile(path, content, "utf-8");
      versions.set(resolve(path), nextVersion());
    },
  };
}

/**
 * The `fs` observation policy simulator: a session-scoped observed-version map,
 * a `fs/write-intent` that guards replaces at the observed version, and
 * `fs/observed` recording. This is the gate the field failure died in.
 */
function makeObservationPolicy() {
  const observed = new Map<string, string>();
  const warnings: string[] = [];
  const keyOf = (target: { targetKey: string }, exec: unknown) =>
    `${(exec as { agent?: { session?: { id?: string } } })?.agent?.session?.id ?? "no-session"}:${target.targetKey}`;
  const ctx = {
    waterfall: vi.fn(async (name: string, target: never, exec: never, fallback: () => unknown) => {
      if (name !== "fs/write-intent") return fallback();
      const seen = observed.get(keyOf(target, exec));
      // Never observed: the policy admits a create only, which fails on an existing file.
      return seen === undefined
        ? { kind: "createIfAbsent" }
        : { kind: "replaceIfVersion", version: seen };
    }),
    emit: vi.fn((name: string, target: never, observation: never, exec: never) => {
      const present = observation as { kind?: string; version?: unknown };
      if (name === "fs/observed" && present?.kind === "present") {
        observed.set(keyOf(target, exec), String(present.version));
      }
    }),
    logger: { warn: (message: string) => warnings.push(message) },
  };
  return { ctx: ctx as unknown as Context, observed, warnings };
}

describe("post-write auto-read records the fs observation (#109)", () => {
  beforeAll(async () => {
    await initHasher();
  });

  it("lets a plugin edit use an auto-read anchor with no re-read", async () => {
    await withTempDir("fs-policy-auto-read-", async (cwd) => {
      const path = join(cwd, "notes.txt");
      await writeFile(path, "alpha\nbeta\n", "utf-8");

      const disk = makeDiskFs();
      const policy = makeObservationPolicy();
      const io = ctxFsIO(disk.fs as never, policy.ctx);
      // setupIntegrationTest drives the plugin `edit` tool under this session key.
      const sessionKey = "test-session";

      // The host `write` lands the new bytes and records no observation (the premise).
      await disk.hostWrite(path, "alpha\nbeta\ngamma\n");

      const listeners = new Map<string, unknown>();
      registerWriteHook(
        policy.ctx,
        {
          on(event: string, listener: unknown) {
            listeners.set(event, listener);
            return () => listeners.delete(event);
          },
        } as unknown as Context,
        io,
      );
      const post = listeners.get("tools/post-execute") as (
        exec: ToolExecution,
        result: { isError: boolean; content: unknown[] },
        next: () => Promise<PostToolDecision>,
      ) => Promise<PostToolDecision>;

      const exec = {
        name: "write",
        arguments: { file_path: path },
        signal: new AbortController().signal,
        agent: { id: sessionKey, session: { id: sessionKey, header: { cwd } } },
      } as unknown as ToolExecution;

      const decision = await post(exec, { isError: false, content: [] }, async () => ({
        kind: "accept",
        content: [],
      }));
      expect(decision.kind).toBe("accept");
      if (decision.kind !== "accept") return;
      const autoRead = (decision.content ?? [])
        .map((block) => (block as { text?: string }).text ?? "")
        .join("\n");
      const anchor = /^([A-Za-z0-9]{3})│/m.exec(autoRead)?.[1];
      expect(anchor).toBeTruthy();

      // The reporter's shape: no re-read, so only the auto-read rows may carry the anchor.
      const { editTool } = setupIntegrationTest(cwd, io);
      await editTool.execute("call-1", { file: path, edits: [[anchor, anchor, "ALPHA"]] });
      await expect(readFile(path, "utf-8")).resolves.toBe("ALPHA\nbeta\ngamma\n");
      expect(policy.warnings).toEqual([]);
    });
  });
});
