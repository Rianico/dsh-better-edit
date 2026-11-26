/**
 * Store lifecycle end-to-end: the undo history survives the handle that wrote it.
 *
 * The interesting claim is not that sqlite persists (it does), but that it persists across the ONE
 * thing the lifecycle wiring can destroy: the 1 → 0 detach closes the connection and drops the
 * cached entry, so the next session's `read` re-opens the file on a cold handle. If the undo row
 * lived in memory anywhere between the edit and the revert, this case would come back empty.
 *
 * Production bindings only: `src/hash-store.ts` binds the lifecycle hooks once at module load, so
 * this file never calls `configureStoreLifecycle` or `_resetForTests` — doing so would unbind the
 * behaviour under test. The tools are the REAL definitions the install wraps, driven over a real
 * temp workspace and a real sqlite file; nothing here stubs the store.
 *
 * The ATTACH TOKEN and the SESSION KEY are built independently here (`makeExec` sets both to the
 * same string): a resume-shaped continuation is the same session under a new agent id, and only
 * that shape separates "the token's teardown closed the store" from "the session's data is gone".
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { wrapToolWithAgentStore } from "../../src/agent-store.js";
import { loadHashStore, shutdownHashStore, type HashStore } from "../../src/hash-store.js";
import { detachAgent, ownerCount } from "../../src/store-lifecycle-slot.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { localIO } from "../../src/fs-bridge.js";
import { buildReadTool } from "../../src/tool-read.js";
import { buildEditTool } from "../../src/tool-edit.js";
import { buildUndoTool } from "../../src/tool-undo.js";
import { getWritableTempRoot, makeTestSandbox } from "../support/fixtures.js";

const BEFORE = "alpha\nbeta\ngamma\n";
const AFTER = "alpha\nBETA\ngamma\n";

/**
 * Liveness of the connection a store actually holds. The public `HashStore` surface exposes no
 * handle, and a closed `node:sqlite` connection finalizes its prepared statements — so a read that
 * must otherwise succeed is the honest probe: it returns on a live handle and throws
 * `ERR_INVALID_STATE` once the handle closed.
 */
function handleIsOpen(store: HashStore): boolean {
  try {
    store.getSnapshot("/__liveness-probe__.ts", "probe\n");
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_INVALID_STATE") return false;
    throw error;
  }
}

/**
 * One execution context with the two identities the seam keeps apart: `agent.id` is the ATTACH
 * TOKEN (what the install's teardown detaches) and `agent.session.id` is the SESSION KEY (what
 * served/retired rows and leases are keyed by). `makeExec` binds both to one string, which cannot
 * express a resume; this builder keeps them independent on purpose.
 */
function execFor(token: string, sessionKey: string, cwd: string, args: unknown): ToolExecution {
  return {
    signal: new AbortController().signal,
    agent: { id: token, session: { id: sessionKey, header: { cwd } } },
    arguments: args,
  } as unknown as ToolExecution;
}

/** The `HASH│content` rows of a read result, header lines excluded. */
function servedRows(result: unknown): Array<{ hash: string; content: string }> {
  const rows: Array<{ hash: string; content: string }> = [];
  for (const line of (result as { text: string }).text.split("\n")) {
    const separator = line.indexOf("│");
    if (separator === -1) continue;
    rows.push({ hash: line.slice(0, separator), content: line.slice(separator + 1) });
  }
  return rows;
}

describe("store lifecycle — reopen-undo across a closed handle", () => {
  let home: string;
  let workspace: string;
  let filePath: string;

  beforeAll(async () => {
    await initHasher();
  });

  beforeEach(async () => {
    home = await mkdtemp(join(await getWritableTempRoot(), "dsh-store-e2e-"));
    workspace = join(home, "workspace");
    await mkdir(workspace, { recursive: true });
    filePath = join(workspace, "resume.txt");
    await writeFile(filePath, BEFORE, "utf-8");
    vi.stubEnv("HOME", home);
    vi.stubEnv("DSH_HOME", join(home, ".dsh"));
    vi.stubEnv("XDG_CONFIG_HOME", "");
  });

  afterEach(async () => {
    // Owners first: a detach is what drives the close, so it must run before the close-all.
    await detachAgent("agent-1");
    await detachAgent("agent-2");
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it("reverts the edit from a fresh handle in the next session", async () => {
    const io = localIO();
    const sandbox = makeTestSandbox();
    const read = wrapToolWithAgentStore(buildReadTool(io));
    const edit = wrapToolWithAgentStore(buildEditTool(io, sandbox));
    const undo = wrapToolWithAgentStore(buildUndoTool(io, sandbox));
    const storePath = hashStorePath(workspace);

    // ---- first agent: read, then edit one line -------------------------------
    const firstRead = await read.execute(
      { path: "resume.txt" },
      execFor("agent-1", "session-1", workspace, { path: "resume.txt" }) as ToolRunContext,
    );
    const betaRow = servedRows(firstRead).find((row) => row.content === "beta");
    expect(betaRow).toBeDefined();

    await edit.execute(
      { file: "resume.txt", edits: [[betaRow!.hash, betaRow!.hash, "BETA"]] },
      execFor("agent-1", "session-1", workspace, {
        file: "resume.txt",
        edits: [[betaRow!.hash, betaRow!.hash, "BETA"]],
      }) as ToolRunContext,
    );
    expect(await readFile(filePath, "utf-8")).toBe(AFTER);
    expect(ownerCount(storePath)).toBe(1);

    // ---- the teardown: the handle the edit used goes away ---------------------
    const store = await loadHashStore(workspace);
    expect(handleIsOpen(store)).toBe(true);
    const detached = detachAgent("agent-1");
    // 1 → 0 closes synchronously inside the detach, so the writer's handle is dead before the
    // second agent ever reads. Anything the revert needs must therefore be on disk.
    expect(handleIsOpen(store)).toBe(false);
    await detached;
    expect(ownerCount(storePath)).toBe(0);

    // ---- second agent, same session key: resume ------------------------------
    const secondRead = await read.execute(
      { path: "resume.txt" },
      execFor("agent-2", "session-1", workspace, { path: "resume.txt" }) as ToolRunContext,
    );
    // The read re-opened the store: a dead cached entry would have served nothing here.
    expect(ownerCount(storePath)).toBe(1);
    const resumed = await loadHashStore(workspace);
    expect(resumed).not.toBe(store);
    expect(handleIsOpen(resumed)).toBe(true);
    expect(servedRows(secondRead).map((row) => row.content)).toEqual(["alpha", "BETA", "gamma"]);

    const undone = (await undo.execute(
      { path: "resume.txt" },
      execFor("agent-2", "session-1", workspace, { path: "resume.txt" }) as ToolRunContext,
    )) as string;
    expect(undone).not.toContain("No undo history");
    // Byte-identical, not line-equal: an undo that re-spelled the terminator would pass a
    // line-array comparison and still corrupt a CRLF file.
    expect(await readFile(filePath, "utf-8")).toBe(BEFORE);
  });
});
