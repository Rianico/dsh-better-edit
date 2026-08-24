/**
 * StoreTenancy — deep module owning tenancy (where DB lives).
 * Owns config (yaml+env, validation, fallback, mtime cache), canonical path via
 * CanonicalPath seam, hash/sanitized basename, sidecar, migration, and
 * tenancyFor() → {dir, mode, runtimeDir, canonical}. File-per-workspace
 * central keeps static prepare() and isolated WAL; no PID level.
 * @module dsh-better-edit/store-tenancy
 */
import { homedir } from "node:os";
import { isAbsolute, join, dirname, parse } from "node:path";
import { resolve as resolvePath } from "node:path";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { errCode } from "./utils.js";
import { canonicalSync } from "./canonical-path.js";

import { loadConfig } from "./store-config.js";

export { loadConfig, _resetConfigCache, expand } from "./store-config.js";
export type { StoreConfig } from "./store-config.js";

export interface Tenancy {
  dir: string;
  mode: "workspace" | "central" | "custom";
  runtimeDir?: string;
  canonical: string;
}

function sanitizedBasename(ws: string): string {
  const base = parse(canonicalSync(ws)).base || "root";
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32);
  return sanitized.length > 0 ? sanitized : "root";
}

function hash8(ws: string): string {
  const canonical = canonicalSync(ws);
  return createHash("sha1").update(canonical).digest("hex").slice(0, 8);
}

function ensureWsPathSidecar(dir: string, canonicalWs: string): void {
  try {
    const wsPathFile = join(dir, ".wsPath");
    if (existsSync(wsPathFile)) {
      const existing = readFileSync(wsPathFile, "utf-8").trim();
      if (existing !== canonicalWs) {
        console.warn(`dsh-better-edit: central store collision for ${dir}: stored wsPath "${existing}" != current "${canonicalWs}" — keeping existing, hash collision risk`);
      }
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(wsPathFile, `${canonicalWs}\n`, "utf-8");
  } catch {
    // best-effort, never throw at path resolution
  }
}

function migrateLegacyIfNeeded(cwd: string, centralDir: string): void {
  try {
    const legacyDir = join(resolvePath(cwd), ".dsh_better_edit");
    const centralDb = join(centralDir, "hash-store.sqlite");
    const legacyDb = join(legacyDir, "hash-store.sqlite");
    if (!existsSync(centralDb) && existsSync(legacyDb)) {
      mkdirSync(centralDir, { recursive: true });
      cpSync(legacyDir, centralDir, { recursive: true, force: false, errorOnExist: false });
      ensureWsPathSidecar(centralDir, canonicalSync(cwd));
      console.warn(`dsh-better-edit: migrated legacy workspace store ${legacyDir} -> ${centralDir}`);
    }
  } catch {
    // best-effort
  }
}

export function tenancyFor(cwd?: string): Tenancy {
  if (cwd === undefined) {
    return {
      dir: join(resolveDshHome(), "plugins", "dsh-better-edit"),
      mode: "central",
      canonical: "",
    };
  }
  const cfg = loadConfig();
  const sd = cfg.storeDir;
  if (sd === "workspace") {
    return { dir: join(resolvePath(cwd), ".dsh_better_edit"), mode: "workspace", canonical: canonicalSync(cwd) };
  }
  const canonical = canonicalSync(cwd);
  const h = hash8(cwd);
  if (sd === "central") {
    const dir = join(resolveDshHome(), "plugins", "dsh-better-edit", "runtime", `${sanitizedBasename(cwd)}-${h}`);
    ensureWsPathSidecar(dir, canonical);
    migrateLegacyIfNeeded(cwd, dir);
    return { dir, mode: "central", runtimeDir: join(resolveDshHome(), "plugins", "dsh-better-edit", "runtime"), canonical };
  }
  const dir = join(sd, h);
  ensureWsPathSidecar(dir, canonical);
  migrateLegacyIfNeeded(cwd, dir);
  return { dir, mode: "custom", runtimeDir: sd, canonical };
}

// Compat shims — paths.ts delegates here
export function configDir(cwd?: string): string {
  return tenancyFor(cwd).dir;
}

export function hashStorePath(cwd?: string): string {
  return join(tenancyFor(cwd).dir, "hash-store.sqlite");
}

export function hashStoreDir(cwd?: string): string {
  return tenancyFor(cwd).dir;
}

export function legacyHashStorePath(cwd?: string): string {
  if (cwd === undefined) return join(resolveDshHome(), "plugins", "dsh-better-edit", "hash-store.json");
  return join(resolvePath(cwd), ".dsh_better_edit", "hash-store.json");
}
