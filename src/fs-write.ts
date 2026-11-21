import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, join } from "node:path";
import { errCode } from "./utils.js";
import { resolveTarget } from "./paths.js";
import { DomainError } from "./domain-errors.js";

const TEMP_PREFIX = ".tmp-";
const TEMP_UUID_RE = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STALE_TEMP_MS = 60 * 60 * 1000;
const sweptDirs = new Set<string>();

async function sweepStaleTemps(dir: string): Promise<void> {
  if (sweptDirs.has(dir)) return;
  sweptDirs.add(dir);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !TEMP_UUID_RE.test(entry.name)) continue;
      const tempPath = join(dir, entry.name);
      try {
        const stats = await stat(tempPath);
        if (now - stats.mtimeMs > STALE_TEMP_MS) {
          await rm(tempPath, { force: true });
        }
      } catch (error: unknown) {
        console.error("[fs-write] failed to inspect stale temp", error);
      }
    }
  } catch (error: unknown) {
    console.error("[fs-write] failed to sweep stale temps", error);
  }
}

async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    console.error("[fs-write] failed to sync directory", error);
  }
}

/** Per-call write mode for {@link writeAtomic}. */
export interface WriteAtomicOptions {
  /**
   * Create the target or fail — never rename over an existing file. The guard
   * is `O_EXCL` on the target itself, so a file that appears after the caller
   * looked (a competitor's create) is refused with `E_FILE_EXISTS` instead of
   * being overwritten. Omitted/`false` keeps the unconditional write.
   */
  readonly exclusive?: boolean;
}

/**
 * Create-or-fail without rename-over: `wx` is `O_CREAT | O_EXCL`, so the
 * target itself is the exclusivity token — the pre-check that decided to write
 * cannot race the publication. The partially created target is removed only
 * when this call created it (`open` succeeded), never a pre-existing file.
 */
async function writeExclusive(path: string, content: string): Promise<void> {
  const targetPath = await resolveTarget(path);
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(targetPath, "wx", 0o600);
  } catch (error: unknown) {
    if (errCode(error) === "EEXIST") {
      throw new DomainError("E_FILE_EXISTS", { path: targetPath });
    }
    throw error;
  }
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } catch (error: unknown) {
    try {
      await handle.close();
    } catch (closeError: unknown) {
      console.error("[fs-write] failed to close partially created file", closeError);
    }
    try {
      await rm(targetPath, { force: true });
    } catch (cleanupError: unknown) {
      console.error("[fs-write] failed to remove partially created file", cleanupError);
    }
    throw error;
  }
  await handle.close();
  await syncDir(dir);
}

export async function writeAtomic(
  path: string,
  content: string,
  options?: WriteAtomicOptions,
): Promise<void> {
  if (options?.exclusive === true) {
    await writeExclusive(path, content);
    return;
  }

  const targetPath = await resolveTarget(path);

  let existingStats: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    existingStats = await stat(targetPath);
  } catch (error: unknown) {
    if (errCode(error) !== "ENOENT") {
      throw error;
    }
  }

  if (existingStats && existingStats.nlink > 1) {
    await writeFile(targetPath, content, "utf-8");
    return;
  }

  const dir = dirname(targetPath);
  await sweepStaleTemps(dir);
  const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const tempHandle = await open(tempPath, "wx", 0o600);
  try {
    await tempHandle.writeFile(content, "utf-8");
    if (existingStats) {
      await tempHandle.chmod(existingStats.mode & 0o7777);
    }
    await tempHandle.sync();
  } catch (error: unknown) {
    await tempHandle.close();
    try {
      await rm(tempPath, { force: true });
    } catch (error: unknown) {
      console.error("[fs-write] failed to remove temp file", error);
    }
    throw error;
  }
  try {
    await tempHandle.close();
    await rename(tempPath, targetPath);
    await syncDir(dir);
  } catch (error: unknown) {
    if (process.platform === "win32" && errCode(error) === "EPERM") {
      try {
        await writeFile(targetPath, content, "utf-8");
        return;
      } finally {
        try {
          await rm(tempPath, { force: true });
        } catch (error: unknown) {
          console.error("[fs-write] failed to remove temp file", error);
        }
      }
    }
    try {
      await rm(tempPath, { force: true });
    } catch (error: unknown) {
      console.error("[fs-write] failed to remove temp file", error);
    }
    throw error;
  }
}
