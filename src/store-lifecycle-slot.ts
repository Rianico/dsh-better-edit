import { AsyncLocalStorage } from "node:async_hooks";

/**
 * StoreLifecycleSlot — per-`storePath` registry that owns WHEN a store handle closes.
 *
 * ONE BOUNDARY: this module decides when a close becomes due (owners crossing `1 → 0`, gated by
 * in-flight scopes); the close itself is injected through `StoreLifecycleHooks.close` and owned by
 * the caller's handle map. A close runs at most once per drain, and only while `isOpen` reports a
 * live handle. Only `node:async_hooks` is imported, so the store cycle stays acyclic.
 *
 * Ref: docs/adr/0057-session-scoped-per-workspace-store-lifecycle.md
 */

/** The two injected operations the registry needs. Both are synchronous by contract. */
export interface StoreLifecycleHooks {
  /** Closes the handle for this storePath. Called only while isOpen(storePath) is true. */
  readonly close: (storePath: string) => void;
  /** Synchronous liveness probe for the handle at this storePath. */
  readonly isOpen: (storePath: string) => boolean;
}

/**
 * One pending close. `finish` resolves the promise every waiter holds; `cancelled` says a new
 * owner arrived first and the handle must stay open; `closed` records that THIS drain ran the
 * close, which is the flag `release` reports; `forced` marks a drain no attach may cancel.
 */
interface Drain {
  forced: boolean;
  cancelled: boolean;
  closed: boolean;
  readonly promise: Promise<void>;
  readonly finish: () => void;
}

/**
 * The lifecycle ledger for one store path. Reads bottom-up: `ownerCount` and `inFlightCount` are
 * the two counters, `#drain` is the single pending close, and every public method either moves a
 * counter or advances that one record. Module-private on purpose — the registry below is the
 * whole surface, so no caller can hold a slot across a reconfigure.
 */
class Slot {
  readonly #storePath: string;
  readonly #owners = new Set<string>();
  readonly #scopeContext = new AsyncLocalStorage<true>();
  #inFlight = 0;
  #drain: Drain | null = null;

  constructor(storePath: string) {
    this.#storePath = storePath;
  }

  get ownerCount(): number {
    return this.#owners.size;
  }

  get inFlightCount(): number {
    return this.#inFlight;
  }

  get isDraining(): boolean {
    return this.#drain !== null;
  }

  /** Registry-only snapshot: the tokens to purge from the reverse index on a forced release. */
  ownerTokens(): readonly string[] {
    return [...this.#owners];
  }

  /**
   * Registers an owner. Idempotent and never opens anything: the slot cannot conjure a handle,
   * so an attach at zero owners only cancels a cancellable drain — the one case where a close
   * that was already decided has to be revoked. A forced drain is never revoked.
   */
  attach(token: string): void {
    if (this.#owners.has(token)) return;
    this.#owners.add(token);
    if (this.#owners.size !== 1) return;
    const drain = this.#drain;
    if (drain === null || drain.forced) return;
    this.#cancelDrain(drain);
  }

  /**
   * Releases an owner. An unmatched token is a no-op. The last owner leaving starts the close:
   * it runs before this promise settles, and synchronously inside the call when no scope is in
   * flight. Await this from OUTSIDE the path's `withStoreScope`: a drain started inside a scope
   * cannot finish before the scope ends, so an in-scope call throws rather than deadlock, and the
   * already-started drain still closes when the scope ends.
   */
  async detach(token: string): Promise<void> {
    if (!this.#owners.delete(token)) return;
    if (this.#owners.size > 0) return;
    await this.#awaitDrain(this.#beginDrain(false));
  }

  /**
   * Marks work that uses the handle, so a detach's close waits for it. The scope never closes
   * anything by itself — an unowned caller stays warm across calls.
   */
  async withScope<T>(fn: () => Promise<T>): Promise<T> {
    this.#inFlight += 1;
    try {
      return await this.#scopeContext.run(true, fn);
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) this.#settleIdle();
    }
  }

  /**
   * Closes on behalf of a teardown. Without `force` it refuses while an owner is attached and
   * otherwise joins or starts a cancellable drain; with `force` it drops every owner and drains
   * regardless. The result is `true` when this release settled its drain and closed — a forced
   * release always reports `true` once its drain settles — and `false` when an attached owner
   * refused it or a new owner cancelled the drain. Await this from OUTSIDE the path's
   * `withStoreScope`: an in-scope call throws rather than deadlock, and the already-started drain
   * still closes when the scope ends.
   */
  async release(options?: { force?: boolean }): Promise<boolean> {
    const force = options?.force === true;
    if (force) {
      this.#owners.clear();
    } else if (this.#owners.size > 0) {
      return false;
    }
    const drain = this.#beginDrain(force);
    await this.#awaitDrain(drain);
    return force ? true : drain.closed;
  }

  /**
   * Waits for a pending close, except from inside this slot's own scope: the drain cannot finish
   * before that scope does, so awaiting there would wait on itself. A bare load calls this to
   * refuse reopening onto a handle that is about to close.
   */
  async awaitDrainingClose(): Promise<void> {
    if (this.#scopeContext.getStore() === true) return;
    const drain = this.#drain;
    if (drain === null) return;
    await drain.promise;
  }

  /**
   * Waits for a drain, except inside this slot's own scope. The drain cannot finish before the
   * scope does, so awaiting it there can never settle; fail loud instead of hanging. The drain was
   * already started, so the close still runs when the scope ends.
   */
  #awaitDrain(drain: Drain): Promise<void> {
    if (this.#drain === drain && this.#scopeContext.getStore() === true) {
      throw new Error("store slot: cannot await a store drain from inside its own scope");
    }
    return drain.promise;
  }

  /** Advances the one pending close: reuse it, upgrade it to forced, or open it and drive it. */
  #beginDrain(forced: boolean): Drain {
    const existing = this.#drain;
    if (existing !== null) {
      if (forced) existing.forced = true;
      return existing;
    }
    let finish: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const drain: Drain = { forced, cancelled: false, closed: false, promise, finish };
    this.#drain = drain;
    if (this.#inFlight === 0) this.#finishDrain(drain);
    return drain;
  }

  #finishDrain(drain: Drain): void {
    try {
      if (!drain.cancelled && requireHooks().isOpen(this.#storePath)) {
        requireHooks().close(this.#storePath);
        drain.closed = true;
      }
    } finally {
      if (this.#drain === drain) this.#drain = null;
      drain.finish();
    }
  }

  #cancelDrain(drain: Drain): void {
    drain.cancelled = true;
    if (this.#drain === drain) this.#drain = null;
    drain.finish();
  }

  #settleIdle(): void {
    const drain = this.#drain;
    if (drain !== null) this.#finishDrain(drain);
  }
}

let hooks: StoreLifecycleHooks | null = null;
let slots = new Map<string, Slot>();
let byToken = new Map<string, Set<string>>();

function requireHooks(): StoreLifecycleHooks {
  if (hooks === null) {
    throw new Error(
      "store lifecycle hooks are not configured: call configureStoreLifecycle() before using a store slot",
    );
  }
  return hooks;
}

/** Installs the hooks and clears every slot and reverse entry. Process start, or a test case. */
export function configureStoreLifecycle(next: StoreLifecycleHooks): void {
  hooks = next;
  slots = new Map();
  byToken = new Map();
}

/**
 * Attaches an agent id to a store path. Repeated calls from the same agent are idempotent, which
 * is what lets every tool call re-attach without counting. Attaching never opens a handle.
 */
export function attachStore(storePath: string, agentToken: string): void {
  const slot = slotFor(storePath);
  slot.attach(agentToken);
  const paths = byToken.get(agentToken);
  if (paths === undefined) byToken.set(agentToken, new Set([storePath]));
  else paths.add(storePath);
}

/**
 * Detaches one agent id from every store it attached to. Every path is detached before the first
 * `await`, so the synchronous close fast path survives for all of them; only then does this wait
 * for their drains, and it prunes the slots they left idle — even when a drain rejects.
 */
export async function detachAgent(agentToken: string): Promise<void> {
  const paths = byToken.get(agentToken);
  if (paths === undefined) return;
  byToken.delete(agentToken);
  const known = [...paths];
  const pending: Promise<void>[] = [];
  for (const storePath of known) {
    const slot = slots.get(storePath);
    if (slot !== undefined) pending.push(slot.detach(agentToken));
  }
  try {
    await Promise.all(pending);
  } finally {
    for (const storePath of known) prune(storePath);
  }
}

/**
 * Runs `fn` inside this path's in-flight barrier, so a close that becomes due meanwhile waits for
 * it. Creates the slot on demand: an unowned caller stays warm and leaves nothing behind.
 */
export async function withStoreScope<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await slotFor(storePath).withScope(fn);
  } finally {
    prune(storePath);
  }
}

/**
 * Closes on behalf of a process-level or path-level teardown. With a path, a forced release
 * clears that slot's owners and its reverse-index entries first; without one, every path the
 * registry KNOWS about is released, and the result is true only when all of them reported true —
 * vacuously true when the registry knows no path, so a path only a bare `releaseStore` never saw
 * is not covered here.
 */
export async function releaseStore(
  storePath?: string,
  options?: { force?: boolean },
): Promise<boolean> {
  const force = options?.force === true;
  if (storePath !== undefined) {
    const slot = slotFor(storePath);
    if (force) purgeTokenIndex(storePath, slot);
    try {
      return await slot.release(options);
    } finally {
      prune(storePath);
    }
  }
  const known = [...slots.keys()];
  const pending: Promise<boolean>[] = [];
  for (const path of known) {
    const slot = slots.get(path);
    if (slot === undefined) continue;
    if (force) purgeTokenIndex(path, slot);
    pending.push(slot.release(options));
  }
  try {
    const outcomes = await Promise.all(pending);
    return outcomes.every((released) => released);
  } finally {
    for (const path of known) prune(path);
  }
}

/** Joins the pending close for this path, if any. A path the registry never saw is a no-op. */
export async function awaitDrainingClose(storePath: string): Promise<void> {
  const slot = slots.get(storePath);
  if (slot === undefined) return;
  await slot.awaitDrainingClose();
}

export function ownerCount(storePath: string): number {
  return slots.get(storePath)?.ownerCount ?? 0;
}

export function inFlightCount(storePath: string): number {
  return slots.get(storePath)?.inFlightCount ?? 0;
}

export function isDraining(storePath: string): boolean {
  return slots.get(storePath)?.isDraining ?? false;
}

/** Read-only probe: how many store paths this token is recorded against. */
export function agentPathCount(agentToken: string): number {
  return byToken.get(agentToken)?.size ?? 0;
}

/** Test-only probe: how many slots the registry currently holds. */
export function _slotCountForTests(): number {
  return slots.size;
}

/** Test-only: drops the hooks and every slot, so each case starts from nothing. */
export function _resetForTests(): void {
  hooks = null;
  slots = new Map();
  byToken = new Map();
}

function slotFor(storePath: string): Slot {
  const existing = slots.get(storePath);
  if (existing !== undefined) return existing;
  requireHooks();
  const created = new Slot(storePath);
  slots.set(storePath, created);
  return created;
}

/**
 * Drops a slot that carries no information: no owner, no scope, no drain. A draining slot stays
 * visible even at zero in-flight scopes, and nothing here runs in the middle of a close that a
 * caller is observing synchronously.
 */
function prune(storePath: string): void {
  const slot = slots.get(storePath);
  if (slot === undefined) return;
  if (slot.ownerCount > 0 || slot.inFlightCount > 0 || slot.isDraining) return;
  slots.delete(storePath);
}

/** Drops every reverse-index entry this path holds, so a forced release cannot strand a claim. */
function purgeTokenIndex(storePath: string, slot: Slot): void {
  for (const token of slot.ownerTokens()) {
    const paths = byToken.get(token);
    if (paths === undefined) continue;
    paths.delete(storePath);
    if (paths.size === 0) byToken.delete(token);
  }
}
