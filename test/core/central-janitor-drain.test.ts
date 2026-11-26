/**
 * The central janitor and the store that is still draining.
 *
 * `src/hash-store.ts` deletes a path's entry only AFTER a successful close, so a draining path is
 * still key-visible while its handle is live — that ordering is what keeps the janitor away from a
 * directory whose sqlite file is about to be checkpointed and closed. These cases pin it against
 * the REAL `stores` getter (nothing is stubbed): the shield must come from the drain staying listed,
 * not from a test seam.
 *
 * Probe of the shield's boundary: with `storeMaxTotalBytes: 0` every non-live directory is
 * eviction-eligible, so "still there while draining, gone once idle" is one live-set claim, not an
 * age coincidence.
 *
 * Production bindings only: the lifecycle hooks are bound when `src/hash-store.ts` loads, so this
 * file never calls `configureStoreLifecycle` or `_resetForTests`. `_resetLifecycleForTests` is the
 * narrow hook for this suite's own throttle state (the janitor is throttled to once a day).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { initHasher } from "../../src/hashline/hash-assign.js";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import {
  attachStore,
  detachAgent,
  isDraining,
  withStoreScope,
} from "../../src/store-lifecycle-slot.js";
import { runCentralJanitorIfDue, _resetLifecycleForTests } from "../../src/store-lifecycle.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { getWritableTempRoot } from "../support/fixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A real (empty but valid) sqlite file, so the janitor's checkpoint path is exercised for real. */
function createStoreFile(dir: string): void {
  const db = new DatabaseSync(join(dir, "hash-store.sqlite"));
  db.close();
}

describe("central janitor — a draining path stays out of the sweep", () => {
  let home: string;
  let dshHome: string;
  let runtimeDir: string;
  let workspace: string;

  beforeAll(async () => {
    await initHasher();
  });

  beforeEach(async () => {
    home = await mkdtemp(join(await getWritableTempRoot(), "dsh-janitor-drain-"));
    dshHome = join(home, ".dsh");
    runtimeDir = join(dshHome, "plugins", "dsh-better-edit", "runtime");
    workspace = join(home, "workspace");
    await mkdir(workspace, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("DSH_HOME", dshHome);
    vi.stubEnv("XDG_CONFIG_HOME", "");
  });

  afterEach(async () => {
    await detachAgent("drainer");
    shutdownHashStore();
    _resetLifecycleForTests();
    vi.unstubAllEnvs();
    _resetConfigCache();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it("deletes an old dir but not the one whose entry is still draining", async () => {
    // The sweep's own settings: any non-live dir is evictable, and only age decides the old one.
    await writeFile(
      join(dshHome, "plugins", "dsh-better-edit", "config.yaml"),
      "storeDir: central\nstoreMaxAgeS: 1\nstoreMaxTotalBytes: 0\n",
      "utf-8",
    );
    _resetConfigCache();

    // An unrelated cache dir from 60 days ago: the age arm of the sweep, not the live set, evicts it.
    const oldDir = join(runtimeDir, "old-workspace-deadbeef");
    await mkdir(oldDir, { recursive: true });
    createStoreFile(oldDir);
    const oldSeconds = (Date.now() - 60 * DAY_MS) / 1000;
    await utimes(oldDir, oldSeconds, oldSeconds);

    // The live path: open, then detached under a held scope — the drain is deferred, so the entry
    // (and its handle) stays in `stores` and the janitor sees the directory as live.
    await loadHashStore(workspace);
    const storePath = hashStorePath(workspace);
    const workspaceDir = dirname(storePath);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    attachStore(storePath, "drainer");
    const scope = withStoreScope(storePath, () => gate);
    const detached = detachAgent("drainer");
    expect(isDraining(storePath)).toBe(true);

    _resetLifecycleForTests();
    await runCentralJanitorIfDue();

    // The shield: the draining directory is named by the real `stores` getter, so it survives while
    // the unrelated old one is deleted.
    expect(existsSync(workspaceDir)).toBe(true);
    // Sanity: this IS the workspace's central cache dir (`<sanitized-basename>-<hash8>`), not some
    // other live directory that happens to sit under `runtime/`.
    expect(basename(workspaceDir)).toMatch(/^workspace-[0-9a-f]{8}$/);
    expect(existsSync(oldDir)).toBe(false);

    // The other side: release the deferral. The drain closes and deletes the entry, so the closed
    // idle directory is no longer live and the next sweep evicts it.
    releaseGate();
    await scope;
    await detached;
    expect(isDraining(storePath)).toBe(false);
    expect(existsSync(workspaceDir)).toBe(true);

    _resetLifecycleForTests();
    await runCentralJanitorIfDue();
    expect(existsSync(workspaceDir)).toBe(false);
  });
});
