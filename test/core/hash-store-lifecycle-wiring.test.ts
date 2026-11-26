/**
 * T2 wiring: the lifecycle registry's two hooks bound to the real per-path store map.
 *
 * These cases exercise PRODUCTION bindings — `src/hash-store.ts` calls
 * `configureStoreLifecycle` once at module load. This file therefore never calls
 * `configureStoreLifecycle` or `_resetForTests`: doing so would unbind the behaviour under test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { contentChecksum, initHasher } from "../../src/hashline/hash-assign.js";
import { loadHashStore, shutdownHashStore, type HashStore } from "../../src/hash-store.js";
import {
  _slotCountForTests,
  attachStore,
  detachAgent,
  inFlightCount,
  isDraining,
  ownerCount,
  withStoreScope,
} from "../../src/store-lifecycle-slot.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { getWritableTempRoot } from "../support/fixtures.js";

/**
 * Liveness of the connection a store actually holds. The public `HashStore` surface exposes no
 * handle (T2 adds no exports there), and a closed `node:sqlite` connection finalizes its prepared
 * statements — so a read that must otherwise succeed is the honest probe: it returns on a live
 * handle and throws `ERR_INVALID_STATE` once the handle closed.
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
 * Waits, microtask by microtask, until the load issued just before holds its scope. The scope is
 * entered synchronously once the drain gate ahead of it resolves, so no timer is needed — and none
 * is used, because a sleep would make the race this helper stages a matter of luck.
 */
async function waitForOpenScope(storePath: string): Promise<void> {
  for (let i = 0; i < 10_000; i += 1) {
    if (inFlightCount(storePath) > 0) return;
    await Promise.resolve();
  }
  throw new Error("open scope never started");
}

describe("hash-store — lifecycle slot wiring", () => {
  let home: string;
  let workspace: string;
  const attached: string[] = [];

  beforeAll(async () => {
    await initHasher();
  });

  beforeEach(async () => {
    home = await mkdtemp(join(await getWritableTempRoot(), "dsh-lifecycle-wiring-"));
    workspace = join(home, "workspace");
    await mkdir(workspace, { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("DSH_HOME", join(home, ".dsh"));
    vi.stubEnv("XDG_CONFIG_HOME", "");
  });

  afterEach(async () => {
    // Owners first: a detach is what drives the close, so it must run before the close-all.
    for (const token of attached.splice(0)) await detachAgent(token);
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  function attach(storePath: string, token: string): void {
    attachStore(storePath, token);
    attached.push(token);
  }

  it("1 → 0 idle detach closes the handle synchronously", async () => {
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);
    attach(storePath, "agent-1");

    const detached = detachAgent("agent-1");
    // The close already ran inside the detach call: no await has happened yet.
    expect(handleIsOpen(store)).toBe(false);

    await detached;

    const reopened = await loadHashStore(workspace);
    // The map entry was removed after the close, so this is a fresh open, not the stale cache.
    expect(reopened).not.toBe(store);
    expect(handleIsOpen(reopened)).toBe(true);
  });

  it("two owners: first detach keeps the handle open, last closes", async () => {
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);
    attach(storePath, "agent-1");
    attach(storePath, "agent-2");
    expect(ownerCount(storePath)).toBe(2);

    await detachAgent("agent-1");
    expect(ownerCount(storePath)).toBe(1);
    expect(isDraining(storePath)).toBe(false);
    expect(handleIsOpen(store)).toBe(true);

    const detached = detachAgent("agent-2");
    // Before its promise settles: the last owner's drain closed the handle synchronously.
    expect(handleIsOpen(store)).toBe(false);

    await detached;
    expect(handleIsOpen(store)).toBe(false);
  });

  it("an in-flight scope defers the close to scope end", async () => {
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scoped = withStoreScope(storePath, () => gate);
    expect(inFlightCount(storePath)).toBe(1);

    attach(storePath, "agent-1");
    const detached = detachAgent("agent-1");

    // The drain is pending, so the handle must still be live.
    expect(isDraining(storePath)).toBe(true);
    expect(handleIsOpen(store)).toBe(true);

    release();
    await scoped;
    await detached;

    expect(isDraining(storePath)).toBe(false);
    expect(handleIsOpen(store)).toBe(false);
  });

  it("a bare/unowned caller stays warm", async () => {
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);

    // The cache the probe below reads is the one every later load reads.
    expect(await loadHashStore(workspace)).toBe(store);

    await detachAgent("ghost");

    expect(handleIsOpen(store)).toBe(true);
    expect(ownerCount(storePath)).toBe(0);
    expect(isDraining(storePath)).toBe(false);
  });

  it("reopen after close preserves persisted rows", async () => {
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);
    store.upsertSnapshot("/persisted.ts", contentChecksum("alpha\n"), 1, ["AAA"], "alpha\n");
    expect(store.getSnapshot("/persisted.ts", "alpha\n")).toEqual(["AAA"]);

    attach(storePath, "agent-1");
    const detached = detachAgent("agent-1");
    expect(handleIsOpen(store)).toBe(false);
    await detached;

    const reopened = await loadHashStore(workspace);
    expect(reopened).not.toBe(store);
    expect(handleIsOpen(reopened)).toBe(true);
    expect(reopened.getSnapshot("/persisted.ts", "alpha\n")).toEqual(["AAA"]);
  });

  it("a failed open leaves the slot consistent", async () => {
    const storePath = hashStorePath(workspace);
    // Path resolution only needs the store DIRECTORY plus its `.wsPath` sidecar, so let it succeed
    // and block the database file itself: `DatabaseSync` cannot open a directory. That keeps the
    // failure inside `openStore` — inside the open's scope — which is what this case must observe.
    await mkdir(storePath, { recursive: true });
    expect(() => hashStorePath(workspace)).not.toThrow();

    // The rejection must be the db open's own: `node:sqlite` reports a directory hold as SQLITE_CANTOPEN
    // ("unable to open database file"), which `isCorruptionError` does not match, so it rethrows instead
    // of quarantining. A path-resolution failure would surface as EEXIST instead.
    await expect(loadHashStore(workspace)).rejects.toThrow(
      /unable to open|not a database|SQLITE|database/i,
    );

    // The failed open's own scope pruned its slot: nothing owned, nothing draining, nothing left.
    expect(_slotCountForTests()).toBe(0);
    expect(ownerCount(storePath)).toBe(0);
    expect(isDraining(storePath)).toBe(false);

    await rm(storePath, { recursive: true, force: true });

    // With the blocker gone the same path opens again; the failure left no poisoned state behind.
    const store = await loadHashStore(workspace);
    expect(handleIsOpen(store)).toBe(true);
  });

  it("reopens after a drain that closes the handle the open just published", async () => {
    const storePath = hashStorePath(workspace);
    const pending = loadHashStore(workspace);
    // The open's scope is held across real fs I/O, which is what lets the drain below land first.
    await waitForOpenScope(storePath);

    attach(storePath, "agent-1");
    // The drain waits for that scope, then closes the handle as the scope ends. `reopenIfDrained`
    // must notice and open again, or this promise would resolve onto a finalized handle.
    const detached = detachAgent("agent-1");
    const store = await pending;
    await detached;

    expect(handleIsOpen(store)).toBe(true);
    expect(ownerCount(storePath)).toBe(0);
  });

  it("a prune owns a barrier, so a detach defers its close", async () => {
    const store = await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);

    const prune = store.pruneMissing();
    // `withStoreScope` increments before its first await, so this read is synchronous and exact:
    // without the prune's own scope the body's fs I/O would leave the counter at zero here.
    expect(inFlightCount(storePath)).toBe(1);

    attach(storePath, "agent-1");
    const detached = detachAgent("agent-1");

    // The drain is pending on the prune's scope, so the handle must still be live.
    expect(isDraining(storePath)).toBe(true);
    expect(handleIsOpen(store)).toBe(true);

    await prune;
    await detached;

    expect(handleIsOpen(store)).toBe(false);
  });
});
