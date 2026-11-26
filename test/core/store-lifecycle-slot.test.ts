import { beforeEach, describe, expect, it } from "vitest";

import {
  agentPathCount,
  _resetForTests,
  _slotCountForTests,
  attachStore,
  awaitDrainingClose,
  configureStoreLifecycle,
  detachAgent,
  inFlightCount,
  isDraining,
  ownerCount,
  releaseStore,
  withStoreScope,
} from "../../src/store-lifecycle-slot.js";

const A = "/tmp/store-a/hash-store.sqlite";
const B = "/tmp/store-b/hash-store.sqlite";
const C = "/tmp/store-c/hash-store.sqlite";

/** A promise a test resolves by hand, so a scope can be held open across an assertion. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** One macrotask, so a pending promise proves itself still pending. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("store-lifecycle-slot", () => {
  const open = new Set<string>();
  const closes: string[] = [];

  beforeEach(() => {
    _resetForTests();
    open.clear();
    closes.length = 0;
    configureStoreLifecycle({
      close: (storePath) => {
        open.delete(storePath);
        closes.push(storePath);
      },
      isOpen: (storePath) => open.has(storePath),
    });
    open.add(A);
    open.add(B);
  });

  it("attach is idempotent: a repeated token counts once and one detach closes", async () => {
    attachStore(A, "agent-1");
    attachStore(A, "agent-1");

    expect(ownerCount(A)).toBe(1);

    await detachAgent("agent-1");

    expect(ownerCount(A)).toBe(0);
    expect(closes).toEqual([A]);
  });

  it("detach of an unknown token is a no-op", async () => {
    await detachAgent("ghost");

    attachStore(A, "agent-1");
    await detachAgent("other");

    expect(ownerCount(A)).toBe(1);
    expect(closes).toEqual([]);
  });

  it("an unknown-token detach does not disturb a pending drain", async () => {
    const gate = deferred();
    const scoped = withStoreScope(A, async () => {
      await gate.promise;
    });
    attachStore(A, "owner");
    const drained = detachAgent("owner");

    expect(isDraining(A)).toBe(true);
    expect(ownerCount(A)).toBe(0);

    // No reverse-index entry, so the registry returns early: nothing starts and nothing finishes.
    await detachAgent("ghost");

    expect(isDraining(A)).toBe(true);
    expect(closes).toEqual([]);
    expect(ownerCount(A)).toBe(0);

    gate.resolve();
    await scoped;
    await drained;

    expect(closes).toEqual([A]);
    expect(_slotCountForTests()).toBe(0);
  });

  it("the 1 → 0 close runs synchronously inside detachAgent, before its promise settles", async () => {
    attachStore(A, "agent-1");

    const done = detachAgent("agent-1");

    // No await on `done` yet: the close already happened, inside the call.
    expect(closes).toEqual([A]);
    await done;
    expect(closes).toEqual([A]);
  });

  it("two owners: the first detach keeps the handle open, the second closes it", async () => {
    attachStore(A, "agent-1");
    attachStore(A, "agent-2");

    await detachAgent("agent-1");

    expect(ownerCount(A)).toBe(1);
    expect(closes).toEqual([]);

    await detachAgent("agent-2");

    expect(ownerCount(A)).toBe(0);
    expect(closes).toEqual([A]);
  });

  it("a 0 → 1 re-attach cancels a non-forced pending drain", async () => {
    const gate = deferred();
    const scoped = withStoreScope(A, async () => {
      await gate.promise;
    });
    attachStore(A, "agent-1");
    const drained = detachAgent("agent-1");
    expect(isDraining(A)).toBe(true);
    expect(closes).toEqual([]);

    // The re-attach cancels the pending drain, so the scope's end closes nothing.
    attachStore(A, "agent-2");
    await drained;

    gate.resolve();
    await scoped;

    expect(closes).toEqual([]);
    expect(isDraining(A)).toBe(false);
    expect(ownerCount(A)).toBe(1);
  });

  it("a forced drain survives a re-attach and still closes exactly once", async () => {
    const gate = deferred();
    const scoped = withStoreScope(A, async () => {
      await gate.promise;
    });

    // The release is awaited from outside the scope, as the calling rule requires.
    attachStore(A, "agent-1");
    const released = releaseStore(A, { force: true });
    expect(ownerCount(A)).toBe(0);

    attachStore(A, "agent-2");
    expect(ownerCount(A)).toBe(1);
    expect(isDraining(A)).toBe(true);
    expect(closes).toEqual([]);

    gate.resolve();
    await scoped;

    expect(await released).toBe(true);
    expect(closes).toEqual([A]);
  });

  it("withStoreScope defers the close until the scope settles", async () => {
    const gate = deferred();
    const scoped = withStoreScope(A, async () => {
      await gate.promise;
    });
    attachStore(A, "agent-1");

    const drained = detachAgent("agent-1");

    expect(isDraining(A)).toBe(true);
    expect(closes).toEqual([]);

    gate.resolve();
    await scoped;
    await drained;

    expect(closes).toEqual([A]);
  });

  it("a scope with no owners never closes anything", async () => {
    await withStoreScope(A, async () => {
      expect(inFlightCount(A)).toBe(1);
      expect(ownerCount(A)).toBe(0);
    });

    expect(closes).toEqual([]);
    expect(inFlightCount(A)).toBe(0);
    expect(isDraining(A)).toBe(false);
  });

  it("releaseStore without force reports false while an owner remains and closes nothing", async () => {
    attachStore(A, "agent-1");

    expect(await releaseStore(A)).toBe(false);

    expect(closes).toEqual([]);
    expect(ownerCount(A)).toBe(1);
  });

  it("releaseStore joins a pending drain and reports its closed result", async () => {
    const gate = deferred();
    const scoped = withStoreScope(A, async () => {
      await gate.promise;
    });
    attachStore(A, "agent-1");
    const drained = detachAgent("agent-1");

    const released = releaseStore(A);
    gate.resolve();
    await scoped;

    expect(await released).toBe(true);
    await drained;
    expect(closes).toEqual([A]);
  });

  it("a forced release clears owners, closes once, and leaves the stale token harmless", async () => {
    attachStore(A, "agent-1");
    attachStore(A, "agent-2");

    expect(await releaseStore(A, { force: true })).toBe(true);

    expect(ownerCount(A)).toBe(0);
    expect(closes).toEqual([A]);

    await detachAgent("agent-1");
    await detachAgent("agent-2");

    expect(closes).toEqual([A]);
  });

  it("awaitDrainingClose inside the slot's own scope neither hangs nor closes", async () => {
    const gate = deferred();
    const inScope = withStoreScope(A, async () => {
      await gate.promise;
      // A silent no-op: it must neither wait on the drain nor close anything.
      await awaitDrainingClose(A);
      expect(closes).toEqual([]);
    });
    attachStore(A, "agent-1");
    const drained = detachAgent("agent-1");

    expect(isDraining(A)).toBe(true);
    expect(closes).toEqual([]);

    gate.resolve();
    await inScope;

    await drained;
    expect(closes).toEqual([A]);
  });

  it("awaitDrainingClose outside a scope waits for the pending close", async () => {
    const gate = deferred();
    const scoped = withStoreScope(A, async () => {
      await gate.promise;
    });
    attachStore(A, "agent-1");
    const drained = detachAgent("agent-1");

    let settled = false;
    const waiting = awaitDrainingClose(A).then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    gate.resolve();
    await scoped;
    await waiting;
    await drained;

    expect(settled).toBe(true);
    expect(closes).toEqual([A]);
  });

  it("two store paths are independent, and a token attached to both closes both", async () => {
    attachStore(A, "a1");
    attachStore(B, "b1");
    const gate = deferred();
    const scopedA = withStoreScope(A, async () => {
      await gate.promise;
    });

    const drainedA = detachAgent("a1");

    expect(inFlightCount(A)).toBe(1);
    expect(inFlightCount(B)).toBe(0);
    expect(ownerCount(B)).toBe(1);
    expect(closes).toEqual([]);

    gate.resolve();
    await scopedA;
    await drainedA;

    expect(closes).toEqual([A]);
    expect(ownerCount(A)).toBe(0);
    expect(ownerCount(B)).toBe(1);
    expect(inFlightCount(B)).toBe(0);

    // A close on A never touches B's owner.
    await detachAgent("a1");
    expect(closes).toEqual([A]);

    // A fresh handle for A, then one token owning both paths.
    open.add(A);
    attachStore(A, "shared");
    attachStore(B, "shared");
    await detachAgent("b1");
    expect(closes).toEqual([A]);

    await detachAgent("shared");
    expect(closes).toEqual([A, A, B]);
  });

  it("the reverse index detaches a token from every path once, and a repeat is a no-op", async () => {
    attachStore(A, "shared");
    attachStore(B, "shared");

    await detachAgent("shared");

    expect(closes).toEqual([A, B]);
    expect(ownerCount(A)).toBe(0);
    expect(ownerCount(B)).toBe(0);

    await detachAgent("shared");

    expect(closes).toEqual([A, B]);
  });

  it("a drain over a closed handle reports closed = false and never double-closes", async () => {
    open.delete(A);

    // Unowned and already closed: the drain runs, closes nothing, reports false.
    expect(await releaseStore(A)).toBe(false);
    expect(closes).toEqual([]);

    // An owner refuses the non-forced release before any drain starts.
    attachStore(A, "agent-1");
    expect(await releaseStore(A)).toBe(false);
    await detachAgent("agent-1");
    expect(closes).toEqual([]);

    // Forced reports true although no close could run.
    expect(await releaseStore(A, { force: true })).toBe(true);
    expect(closes).toEqual([]);
  });

  it("_resetForTests clears owners, drains and hooks, so a hooks-less call fails loud", async () => {
    attachStore(A, "agent-1");
    expect(ownerCount(A)).toBe(1);

    _resetForTests();

    expect(ownerCount(A)).toBe(0);
    expect(inFlightCount(A)).toBe(0);
    expect(isDraining(A)).toBe(false);
    expect(() => attachStore(A, "agent-1")).toThrow(/configureStoreLifecycle/);
    await expect(releaseStore(A)).rejects.toThrow(/configureStoreLifecycle/);
    await expect(
      withStoreScope(A, async () => {
        return 1;
      }),
    ).rejects.toThrow(/configureStoreLifecycle/);
  });

  it("withStoreScope on an unknown path works and leaves no slot behind", async () => {
    const value = await withStoreScope(C, async () => 42);

    expect(value).toBe(42);
    expect(ownerCount(C)).toBe(0);
    expect(inFlightCount(C)).toBe(0);
    expect(isDraining(C)).toBe(false);
    expect(closes).toEqual([]);
  });

  it("releaseStore without a path releases every known path", async () => {
    attachStore(A, "a1");
    attachStore(B, "b1");

    expect(await releaseStore(undefined, { force: true })).toBe(true);

    expect(closes).toEqual([A, B]);
    expect(ownerCount(A)).toBe(0);
    expect(ownerCount(B)).toBe(0);
  });

  it("releaseStore without a path is vacuously true when no path is known", async () => {
    expect(await releaseStore()).toBe(true);
    expect(closes).toEqual([]);
  });

  it("releaseStore without a path reports false when a non-forced path refuses", async () => {
    attachStore(A, "a1");

    expect(await releaseStore()).toBe(false);

    expect(closes).toEqual([]);
    expect(ownerCount(A)).toBe(1);
  });

  it("detachAgent inside its own scope fails loud instead of deadlocking", async () => {
    attachStore(A, "agent-1");

    let failure: unknown = null;
    await withStoreScope(A, async () => {
      failure = await detachAgent("agent-1").then(
        () => null,
        (error: unknown) => error,
      );

      // The drain is already started and waits for this scope, so it cannot settle here.
      expect(isDraining(A)).toBe(true);
      expect(closes).toEqual([]);
    });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/own scope/);
    // The started drain still closed, exactly once, when the scope ended.
    expect(closes).toEqual([A]);
  });

  it("a multi-path detach that rejects still prunes the paths it left idle", async () => {
    attachStore(A, "shared");
    attachStore(B, "shared");

    let failure: unknown = null;
    await withStoreScope(A, async () => {
      failure = await detachAgent("shared").then(
        () => null,
        (error: unknown) => error,
      );

      // B holds no scope of its own: it closed synchronously, inside the call, before the wait.
      expect(closes).toEqual([B]);
      expect(isDraining(A)).toBe(true);
    });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/own scope/);
    expect(closes.slice().sort()).toEqual([A, B].sort());
    expect(ownerCount(A)).toBe(0);
    expect(isDraining(A)).toBe(false);
    // The rejecting detach must not leave B's empty idle slot behind.
    expect(_slotCountForTests()).toBe(0);
  });

  it("releaseStore inside its own scope fails loud instead of deadlocking", async () => {
    let failure: unknown = null;

    await withStoreScope(A, async () => {
      failure = await releaseStore(A).then(
        () => null,
        (error: unknown) => error,
      );

      expect(isDraining(A)).toBe(true);
      expect(closes).toEqual([]);
    });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/own scope/);
    expect(closes).toEqual([A]);
  });

  it("a forced releaseStore inside its own scope fails loud and still closes after the scope", async () => {
    attachStore(A, "agent-1");
    let failure: unknown = null;

    await withStoreScope(A, async () => {
      failure = await releaseStore(A, { force: true }).then(
        () => null,
        (error: unknown) => error,
      );

      // Forced semantics already ran: owners dropped, drain started, no close yet.
      expect(ownerCount(A)).toBe(0);
      expect(isDraining(A)).toBe(true);
      expect(closes).toEqual([]);
    });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/own scope/);
    expect(closes).toEqual([A]);
    expect(ownerCount(A)).toBe(0);
  });

  it("a forced upgrade from outside the scope survives a 0 → 1 re-attach", async () => {
    const gate = deferred();
    const scoped = withStoreScope(A, async () => {
      await gate.promise;
    });
    attachStore(A, "agent-1");
    const drained = detachAgent("agent-1");
    expect(isDraining(A)).toBe(true);

    const released = releaseStore(A, { force: true });
    // This attach must NOT cancel the drain the forced release just upgraded.
    attachStore(A, "agent-2");

    expect(isDraining(A)).toBe(true);
    expect(ownerCount(A)).toBe(1);

    gate.resolve();
    await scoped;

    expect(await released).toBe(true);
    await drained;
    expect(closes).toEqual([A]);
    expect(ownerCount(A)).toBe(1);
  });

  it("two concurrent scopes on one path are not pruned early", async () => {
    const first = deferred();
    const second = deferred();
    const firstScope = withStoreScope(A, async () => {
      await first.promise;
    });
    const secondScope = withStoreScope(A, async () => {
      await second.promise;
    });

    expect(inFlightCount(A)).toBe(2);

    first.resolve();
    await firstScope;

    // The scope that ended must not have pruned the slot the other one still holds.
    expect(inFlightCount(A)).toBe(1);

    attachStore(A, "agent-1");
    const drained = detachAgent("agent-1");
    expect(isDraining(A)).toBe(true);
    expect(closes).toEqual([]);

    second.resolve();
    await secondScope;
    await drained;

    expect(closes).toEqual([A]);
  });

  it("agentPathCount observes reverse-index cleanup per release", async () => {
    attachStore(A, "shared");
    attachStore(B, "shared");
    expect(agentPathCount("shared")).toBe(2);

    await detachAgent("shared");
    expect(agentPathCount("shared")).toBe(0);

    attachStore(A, "t");
    attachStore(B, "t");
    expect(agentPathCount("t")).toBe(2);

    expect(await releaseStore(A, { force: true })).toBe(true);
    expect(agentPathCount("t")).toBe(1);

    expect(await releaseStore(B, { force: true })).toBe(true);
    expect(agentPathCount("t")).toBe(0);

    attachStore(A, "x");
    attachStore(B, "y");

    expect(await releaseStore(undefined, { force: true })).toBe(true);
    expect(agentPathCount("x")).toBe(0);
    expect(agentPathCount("y")).toBe(0);
  });

  it("a non-forced release that joins a drain a later attach cancels reports false", async () => {
    const gate = deferred();
    const scoped = withStoreScope(A, async () => {
      await gate.promise;
    });
    attachStore(A, "agent-1");
    const drained = detachAgent("agent-1");

    const released = releaseStore(A);
    attachStore(A, "agent-2");

    gate.resolve();
    await scoped;

    expect(await released).toBe(false);
    await drained;
    expect(closes).toEqual([]);
    expect(ownerCount(A)).toBe(1);
  });

  it("an idle releaseStore closes synchronously inside the call", async () => {
    const released = releaseStore(A);

    // No await yet: nothing gates this release, so the close already ran.
    expect(closes).toEqual([A]);
    expect(await released).toBe(true);
  });

  it("a throwing close still clears the drain and lets a retry close", async () => {
    let failNext = true;
    configureStoreLifecycle({
      close: (storePath) => {
        if (failNext) {
          failNext = false;
          throw new Error("close exploded");
        }
        open.delete(storePath);
        closes.push(storePath);
      },
      isOpen: (storePath) => open.has(storePath),
    });
    attachStore(A, "agent-1");

    await expect(detachAgent("agent-1")).rejects.toThrow("close exploded");

    expect(isDraining(A)).toBe(false);
    expect(ownerCount(A)).toBe(0);
    expect(closes).toEqual([]);

    expect(await releaseStore(A)).toBe(true);
    expect(closes).toEqual([A]);
  });

  it("a throwing close during detachAgent still prunes the slot it left idle", async () => {
    let failNext = true;
    configureStoreLifecycle({
      close: (storePath) => {
        if (failNext) {
          failNext = false;
          throw new Error("close exploded");
        }
        open.delete(storePath);
        closes.push(storePath);
      },
      isOpen: (storePath) => open.has(storePath),
    });
    attachStore(A, "agent-1");

    await expect(detachAgent("agent-1")).rejects.toThrow("close exploded");

    // The close failed, but the drain retired and the now-idle slot must not be stranded.
    expect(ownerCount(A)).toBe(0);
    expect(isDraining(A)).toBe(false);
    expect(_slotCountForTests()).toBe(0);
  });

  it("a close that throws while a scope settles rejects the scope, not the drain waiter", async () => {
    let failNext = true;
    configureStoreLifecycle({
      close: (storePath) => {
        if (failNext) {
          failNext = false;
          throw new Error("close exploded");
        }
        open.delete(storePath);
        closes.push(storePath);
      },
      isOpen: (storePath) => open.has(storePath),
    });
    const gate = deferred();
    const scoped = withStoreScope(A, async () => {
      await gate.promise;
      return "body";
    });
    attachStore(A, "agent-1");
    const drained = detachAgent("agent-1");

    expect(isDraining(A)).toBe(true);
    expect(closes).toEqual([]);

    gate.resolve();
    // The close error supersedes the scope's body result...
    await expect(scoped).rejects.toThrow("close exploded");
    // ...while the drain waiter resolved: the drain record retired either way.
    await drained;

    expect(isDraining(A)).toBe(false);
    expect(closes).toEqual([]);

    // The throwing close left the handle open, so the retry closes it for real.
    expect(await releaseStore(A)).toBe(true);
    expect(closes).toEqual([A]);
    expect(_slotCountForTests()).toBe(0);
  });
});
