/**
 * StoreLifecycle — deep module owning store lifecycle (central GC + row TTL + WAL).
 *
 * Previously scattered: handleGitPollution + served/undo prune + pruneMissing throttling
 * in hash-store.ts openStore, and runCentralJanitorIfDue throttling in hash-store.ts
 * but scheduled from index.ts apply/session-start. No locality: WAL, TTL, readdir and
 * throttling lived in different places and leaked stores/openings Maps.
 *
 * This module owns lastPruneMsByStore, lastJanitorMs, live-set computation, readdir/stat,
 * and exposes onStoreOpen / onAppStart / onSessionStart / onClose.
 * @module dsh-better-edit/store-lifecycle
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { hashStorePath, loadConfig } from "./paths.js";
import { workspaceCwd } from "./workspace.js";
import { errCode, splitLines } from "./utils.js";
import { HASH_STORE_BUSY_TIMEOUT, SERVED_TTL_MS } from "./constants.js";
import type { HashStore } from "./hash-store.js";

// ---- throttling state (owned here) ----
let lastPruneMsByStore = new Map<string, number>();
let lastJanitorMs = 0;
const PRUNE_THROTTLE_MS = 24 * 60 * 60 * 1000;
const JANITOR_THROTTLE_MS = 24 * 60 * 60 * 1000;

let getStores: (() => Map<string, { path: string }>) | undefined;
let getOpenings: (() => Map<string, Promise<any>>) | undefined;

export function setStoresGetter(
  getS: () => Map<string, { path: string }>,
  getO: () => Map<string, Promise<any>>,
): void {
  getStores = getS;
  getOpenings = getO;
}

// ---- git pollution state ----
const warnedGitWarn = new Set<string>();

function gitignoreHasEntry(ws: string): boolean {
  try {
    const content = readFileSync(join(ws, ".gitignore"), "utf-8");
    return content.split("\n").some((l) => {
      const t = l.trim();
      return t === ".dsh_better_edit" || t === ".dsh_better_edit/" || t.startsWith(".dsh_better_edit/");
    });
  } catch {
    return false;
  }
}

function handleGitPollution(storePath: string): void {
  try {
    const cfg = loadConfig();
    if (cfg.storeDir !== "workspace") return;
    const ws = dirname(dirname(storePath));
    if (!existsSync(join(ws, ".git")) || gitignoreHasEntry(ws)) return;

    if (cfg.autoGitignore) {
      const gitignorePath = join(ws, ".gitignore");
      try {
        if (!existsSync(gitignorePath)) {
          appendFileSync(gitignorePath, ".dsh_better_edit/\n");
        } else {
          const content = readFileSync(gitignorePath, "utf-8");
          const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
          appendFileSync(gitignorePath, `${prefix}.dsh_better_edit/\n`);
        }
      } catch (error) {
        console.warn(`dsh-better-edit: failed to update .gitignore for ${ws}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (warnedGitWarn.has(ws)) return;
    warnedGitWarn.add(ws);
    console.warn(`dsh-better-edit: workspace store at ${ws}/.dsh_better_edit/ not in .gitignore — add ".dsh_better_edit/" to .gitignore or set storeDir: central / autoGitignore: true`);
  } catch (error) {
    console.warn(`dsh-better-edit: handleGitPollution failed: ${error instanceof Error ? error.message : String(error)}`); // best-effort, never throw at store open
  }
}

// ---- central janitor ----

export async function runCentralJanitorIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastJanitorMs < JANITOR_THROTTLE_MS) return;
  lastJanitorMs = now;

  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch (error) {
    console.warn(`dsh-better-edit: loadConfig failed in janitor: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (cfg.storeDir === "workspace") return;

  const runtimeDir = join(resolveDshHome(), "plugins", "dsh-better-edit", "runtime");
  let entries: string[];
  try {
    entries = await readdir(runtimeDir);
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") return;
    console.error("central janitor readdir failed:", error);
    return;
  }

  	const liveDirs = new Set<string>();
	if (getStores) {
		for (const storePath of getStores().keys()) {
			if (storePath.startsWith(runtimeDir + "/")) {
				const base = storePath.slice(runtimeDir.length + 1).split("/")[0];
				if (base) liveDirs.add(base);
			}
		}
	}
	if (getOpenings) {
		for (const storePath of getOpenings().keys()) {
			if (storePath.startsWith(runtimeDir + "/")) {
				const base = storePath.slice(runtimeDir.length + 1).split("/")[0];
				if (base) liveDirs.add(base);
			}
		}
	}

  const infos: { name: string; dir: string; mtimeMs: number; totalBytes: number }[] = [];
  for (const name of entries) {
    if (liveDirs.has(name)) continue;
    const dir = join(runtimeDir, name);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
      let totalBytes = 0;
      for (const file of ["hash-store.sqlite", "hash-store.sqlite-wal", "hash-store.sqlite-shm", ".wsPath"] as const) {
        try {
          totalBytes += (await stat(join(dir, file))).size;
        } catch {}
      }
      infos.push({ name, dir, mtimeMs: st.mtimeMs, totalBytes });
    } catch (error) {
      console.warn(`dsh-better-edit: stat failed for central dir ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  infos.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const maxAgeMs = cfg.storeMaxAgeDays * 24 * 60 * 60 * 1000;
  const toDelete: typeof infos = [];
  for (const info of infos) {
    if (now - info.mtimeMs > maxAgeMs) toDelete.push(info);
  }

  let remaining = infos.filter((info) => !toDelete.includes(info));
  let currentCount = liveDirs.size + remaining.length + toDelete.length;
  let currentBytes = [...remaining, ...toDelete].reduce((sum, info) => sum + info.totalBytes, 0);

  for (const info of [...remaining].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (currentCount < 100 && currentBytes < cfg.storeMaxTotalBytes) break;
    toDelete.push(info);
    currentCount--;
    currentBytes -= info.totalBytes;
    remaining = remaining.filter((x) => x !== info);
  }

  for (const info of toDelete) {
    try {
      const dbPath = join(info.dir, "hash-store.sqlite");
      if (existsSync(dbPath)) {
        const tmpDb = new DatabaseSync(dbPath, { timeout: HASH_STORE_BUSY_TIMEOUT });
        try {
          tmpDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (error) {
          console.warn(`dsh-better-edit: wal_checkpoint failed for ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          try {
            tmpDb.close();
          } catch (error) {
            console.warn(`dsh-better-edit: close failed for ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      await rm(info.dir, { recursive: true, force: true });
    } catch (error) {
      console.error("central janitor delete failed for", info.dir, error);
    }
  }
}

// Called from hash-store openStore after db is ready
export async function onStoreOpen(
  storePath: string,
  stmts: { servedPruneOlderThan: (ts: number) => void; undoPruneOlderThan: (ts: number) => void },
  store: HashStore,
): Promise<void> {
  handleGitPollution(storePath);

  // Row TTL — always (not throttled) but cheap
  try {
    stmts.servedPruneOlderThan(Date.now() - SERVED_TTL_MS);
  } catch (error) {
    console.warn(`dsh-better-edit: served prune failed for ${storePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const cfg = loadConfig();
    if (cfg.undo_ttl_s !== -1) {
      stmts.undoPruneOlderThan(Date.now() - cfg.undo_ttl_s * 1000);
    }
  } catch (error) {
    console.warn(`dsh-better-edit: undo prune failed for ${storePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // pruneMissing throttled per-store 24h
  try {
    const lastPrune = lastPruneMsByStore.get(storePath) ?? 0;
    if (Date.now() - lastPrune > PRUNE_THROTTLE_MS) {
      lastPruneMsByStore.set(storePath, Date.now());
      store.pruneMissing().catch((e) => console.error("pruneMissing failed:", e));
    }
  } catch (error) {
    console.warn(`dsh-better-edit: pruneMissing throttling check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function onAppStart(): Promise<void> {
  await runCentralJanitorIfDue();
}

export async function onSessionStart(): Promise<void> {
  await runCentralJanitorIfDue();
}

// For tests
export function _resetLifecycleForTests(): void {
  lastPruneMsByStore = new Map<string, number>();
  lastJanitorMs = 0;
  warnedGitWarn.clear();
}
