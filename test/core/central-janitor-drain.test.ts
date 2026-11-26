/**
 * The central janitor and the store that is still draining.
 *
 * A path's entry is deleted only AFTER a successful close, so a draining path stays key-visible
 * while its handle is live and the janitor keeps away from it. These cases pin that ordering
 * against the real `stores` getter, with `storeMaxTotalBytes: 0` so age cannot fake it.
 *
 * Ref: docs/adr/0057-session-scoped-per-workspace-store-lifecycle.md
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
    await writeFile(
      join(dshHome, "plugins", "dsh-better-edit", "config.yaml"),
      "storeDir: central\nstoreMaxAgeS: 1\nstoreMaxTotalBytes: 0\n",
      "utf-8",
    );
    _resetConfigCache();

    const oldDir = join(runtimeDir, "old-workspace-deadbeef");
    await mkdir(oldDir, { recursive: true });
    createStoreFile(oldDir);
    const oldSeconds = (Date.now() - 60 * DAY_MS) / 1000;
    await utimes(oldDir, oldSeconds, oldSeconds);

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

    expect(existsSync(workspaceDir)).toBe(true);
    expect(basename(workspaceDir)).toMatch(/^workspace-[0-9a-f]{8}$/);
    expect(existsSync(oldDir)).toBe(false);

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
