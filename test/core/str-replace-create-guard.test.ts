/**
 * Issue #134: `str_replace_editor` `create` promised "fails if it exists" but
 * only pre-`stat`ed, then wrote unconditionally — so a competitor's file
 * created inside the stat→write window was clobbered. The promise now holds at
 * both write seams: the dsh backend hands the provider
 * `{ kind: "createIfAbsent" }` — whatever the `fs/write-intent` waterfall
 * resolves, that demand is the floor — and maps its
 * `FS_NOT_OBSERVED` rejection to `E_FILE_EXISTS`, the local backend opens the
 * target with `O_EXCL`. Every case here asserts the competitor wins, never
 * last-writer-wins; the last case is the control proving the guard did not
 * leak onto the `edit`-family commands.
 * @module dsh-better-edit/str-replace-create-guard.test
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import { withTempDir } from "../support/fixtures.js";

/** No confining backend: no escalation fields, `resolvePolicy` → undefined. */
const noSandbox = () =>
  new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);

function fakeExec(cwd: string, session = "sre-create-guard") {
  return {
    signal: new AbortController().signal,
    agent: { id: session, session: { id: session, header: { cwd } } },
  } as never;
}

const COMPETITOR = "competitor\n";

/** Resolve a call's rejection once, so one execution can be asserted twice. */
async function rejectionOf(
  run: () => Promise<unknown>,
): Promise<Error & { readonly code?: string }> {
  const settled = await run().then(
    () => undefined,
    (error: unknown) => error as Error & { readonly code?: string },
  );
  if (settled === undefined) throw new Error("expected a rejection, but the call succeeded");
  return settled;
}

/**
 * An in-memory `ctx.fs` double implementing the documented provider contract.
 * Its first `stat` of an absent target observes `undefined` — then a competitor
 * appears in the stat→write window — and its `writeText` honours
 * `createIfAbsent` the way the host documents it: an existing target is
 * refused with `FS_NOT_OBSERVED`.
 */
function makeRacingProvider() {
  const files = new Map<string, { text: string; version: number }>();
  const intents: Array<{ kind?: string } | undefined> = [];
  let seq = 1;
  let raced = false;
  const describe = (key: string) => {
    const file = files.get(key)!;
    return { version: `v${file.version}`, type: "file" as const, size: file.text.length };
  };
  const fs = {
    resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
    processPath: (target: { targetKey: string }) => target.targetKey,
    stat: async (target: { targetKey: string }) => {
      const key = target.targetKey;
      const observed = files.get(key);
      if (observed === undefined && !raced) {
        raced = true;
        files.set(key, { text: COMPETITOR, version: seq++ });
      }
      return observed === undefined ? undefined : describe(key);
    },
    readText: async (target: { targetKey: string }) => {
      const file = files.get(target.targetKey);
      if (file === undefined) throw Object.assign(new Error("not found"), { code: "FS_NOT_FOUND" });
      return file.text;
    },
    writeText: async (
      target: { targetKey: string },
      content: string,
      intent?: { kind?: string },
    ) => {
      intents.push(intent);
      const key = target.targetKey;
      if (intent?.kind === "createIfAbsent" && files.has(key)) {
        throw Object.assign(new Error(`cannot create ${key}: target already exists`), {
          code: "FS_NOT_OBSERVED",
        });
      }
      files.set(key, { text: content, version: seq++ });
      return { operation: "create", version: `v${seq - 1}`, before: null, after: content };
    },
  };
  return {
    fs,
    intents,
    text: (key: string) => files.get(key)?.text,
    raced: () => raced,
  };
}

/**
 * The host-plane context `ctxFsIO` needs (`fs/write-intent` waterfall + `fs/observed`).
 * With no argument the stub calls `next()`, the bridge's own fallback. An argument
 * (including an explicit `undefined`) makes it resolve that value instead, standing
 * in for a listener that answers the waterfall.
 */
function makeIoCtx(...resolvedIntent: [unknown?]) {
  const waterfall = async (
    _event: string,
    _target: unknown,
    _actor: unknown,
    next: () => unknown,
  ) => (resolvedIntent.length === 0 ? next() : resolvedIntent[0]);
  return { waterfall, emit: () => {} } as unknown as Context;
}

beforeEach(() => {
  clearEncodingState();
  clearAutoGuessFooter();
});

describe("str_replace_editor create is create-or-fail", () => {
  it("refuses an existing target over the local backend without touching its bytes", async () => {
    await withTempDir("sre-create-existing-", async (dir) => {
      const path = join(dir, "kept.txt");
      await writeFile(path, COMPETITOR, "utf-8");
      const tool = buildStrReplaceEditorTool(localIO(), noSandbox());

      const error = await rejectionOf(() =>
        tool.execute({ command: "create", path, file_text: "mine\n" }, fakeExec(dir)),
      );

      expect(error.message).toMatch(/E_FILE_EXISTS/);
      expect(error).toMatchObject({ code: "E_FILE_EXISTS" });
      expect(await readFile(path, "utf-8")).toBe(COMPETITOR);
    });
  });

  it("creates an absent target as UTF-8 without BOM and records its version", async () => {
    await withTempDir("sre-create-absent-", async (dir) => {
      const path = join(dir, "fresh.txt");
      const io = localIO();
      const tool = buildStrReplaceEditorTool(io, noSandbox());

      const result = (await tool.execute(
        { command: "create", path, file_text: "fresh line\n" },
        fakeExec(dir),
      )) as unknown as { text: string };

      expect(result.text).toMatch(/Created/);
      const bytes = await readFile(path);
      expect([...bytes]).toEqual([...Buffer.from("fresh line\n", "utf-8")]);
      expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
      expect(typeof (await io.statVersion(path))).toBe("string");
    });
  });

  it("refuses a competitor created inside the local stat→write window", async () => {
    await withTempDir("sre-create-race-", async (dir) => {
      const path = join(dir, "raced.txt");
      const base = localIO();
      let interleaved = false;
      // The competitor lands after the tool's own presence check saw it absent:
      // exactly the window the pre-`stat` used to leave open.
      const raceIO: FileIO = {
        ...base,
        async statVersion(absolutePath, signal) {
          const version = await base.statVersion(absolutePath, signal);
          if (version === undefined && !interleaved) {
            interleaved = true;
            await writeFile(absolutePath, COMPETITOR, "utf-8");
          }
          return version;
        },
      };
      const tool = buildStrReplaceEditorTool(raceIO, noSandbox());

      const error = await rejectionOf(() =>
        tool.execute({ command: "create", path, file_text: "mine\n" }, fakeExec(dir)),
      );

      expect(interleaved).toBe(true);
      expect(error.message).toMatch(/E_FILE_EXISTS/);
      expect(error).toMatchObject({ code: "E_FILE_EXISTS" });
      expect(await readFile(path, "utf-8")).toBe(COMPETITOR);
    });
  });

  it("refuses a competitor created inside the provider stat→write window", async () => {
    await withTempDir("sre-create-provider-race-", async (dir) => {
      const path = join(dir, "provider-raced.txt");
      const provider = makeRacingProvider();
      const io: FileIO = ctxFsIO(provider.fs as never, makeIoCtx());
      const tool = buildStrReplaceEditorTool(io, noSandbox());

      const error = await rejectionOf(() =>
        tool.execute({ command: "create", path, file_text: "mine\n" }, fakeExec(dir)),
      );

      expect(provider.raced()).toBe(true);
      expect(error.message).toMatch(/E_FILE_EXISTS/);
      expect(error).toMatchObject({ code: "E_FILE_EXISTS" });
      expect(provider.text(path)).toBe(COMPETITOR);
      // The demand reaches the provider: never an unconditional (undefined) write.
      expect(provider.intents).toEqual([{ kind: "createIfAbsent" }]);
    });
  });

  it("floor: a waterfall resolving undefined still delivers the create intent", async () => {
    await withTempDir("sre-create-floor-undefined-", async (dir) => {
      const path = join(dir, "floor-undefined.txt");
      const provider = makeRacingProvider();
      const io: FileIO = ctxFsIO(provider.fs as never, makeIoCtx(undefined));
      const tool = buildStrReplaceEditorTool(io, noSandbox());

      const error = await rejectionOf(() =>
        tool.execute({ command: "create", path, file_text: "mine\n" }, fakeExec(dir)),
      );

      expect(error).toMatchObject({ code: "E_FILE_EXISTS" });
      expect(provider.text(path)).toBe(COMPETITOR);
      expect(provider.intents).toEqual([{ kind: "createIfAbsent" }]);
    });
  });

  it("floor: a conflicting waterfall kind cannot downgrade the create intent", async () => {
    await withTempDir("sre-create-floor-conflict-", async (dir) => {
      const path = join(dir, "floor-conflict.txt");
      const provider = makeRacingProvider();
      const io: FileIO = ctxFsIO(
        provider.fs as never,
        makeIoCtx({ kind: "replaceIfVersion", version: "whatever" }),
      );
      const tool = buildStrReplaceEditorTool(io, noSandbox());

      const error = await rejectionOf(() =>
        tool.execute({ command: "create", path, file_text: "mine\n" }, fakeExec(dir)),
      );

      expect(error).toMatchObject({ code: "E_FILE_EXISTS" });
      expect(provider.text(path)).toBe(COMPETITOR);
      expect(provider.intents).toEqual([{ kind: "createIfAbsent" }]);
    });
  });

  it("control: str_replace still overwrites an existing file without a create guard", async () => {
    await withTempDir("sre-create-control-", async (dir) => {
      const path = join(dir, "edited.txt");
      await writeFile(path, "alpha\nbravo\n", "utf-8");
      const tool = buildStrReplaceEditorTool(localIO(), noSandbox());
      const exec = fakeExec(dir);

      await tool.execute({ command: "view", path }, exec);
      const result = (await tool.execute(
        { command: "str_replace", path, old_str: "bravo", new_str: "BRAVO" },
        exec,
      )) as unknown as { text: string };

      expect(result.text).toMatch(/Replaced 1 occurrence/);
      expect(await readFile(path, "utf-8")).toBe("alpha\nBRAVO\n");
    });
  });
});
