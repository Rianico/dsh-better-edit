/**
 * Canonical path — single seam for symlink-resolved canonicalization.
 * Pure resParts shared by sync and async adapters (locality: ELOOP fix in one place).
 * @module dsh-better-edit/canonical-path
 */
import { lstat, readlink } from "node:fs/promises";
import { lstatSync, readlinkSync } from "node:fs";
import { dirname, join, parse, sep } from "node:path";
import { resolve as resolvePath } from "node:path";
import { errCode } from "./utils.js";

function resPartsSync(
  current: string,
  remaining: string[],
  visited: Set<string>,
  originalInput: string,
): string {
  let cur = current;
  let rem = remaining.slice();
  while (rem.length > 0) {
    const [next, ...tail] = rem;
    const candidate = join(cur, next!);
    try {
      const st = lstatSync(candidate);
      if (!st.isSymbolicLink()) {
        cur = candidate;
        rem = tail;
        continue;
      }
      if (visited.has(candidate)) {
        const e = new Error(`Too many symbolic links while resolving ${originalInput}`) as NodeJS.ErrnoException;
        e.code = "ELOOP";
        throw e;
      }
      visited.add(candidate);
      const linkTarget = resolvePath(dirname(candidate), readlinkSync(candidate));
      const targetParts = linkTarget.slice(parse(linkTarget).root.length).split(sep).filter((p) => p.length > 0);
      cur = parse(linkTarget).root;
      rem = [...targetParts, ...tail];
    } catch (error: unknown) {
      if (errCode(error) === "ENOENT") return join(candidate, ...tail);
      throw error;
    }
  }
  return cur;
}

export function canonicalSync(ws: string): string {
  const absolutePath = resolvePath(ws);
  const { root } = parse(absolutePath);
  const parts = absolutePath.slice(root.length).split(sep).filter((p) => p.length > 0);
  return resPartsSync(root, parts, new Set<string>(), ws);
}

async function resPartsAsync(
  current: string,
  remaining: string[],
  visited: Set<string>,
  originalInput: string,
): Promise<string> {
  let cur = current;
  let rem = remaining.slice();
  while (rem.length > 0) {
    const [next, ...tail] = rem;
    const candidate = join(cur, next!);
    try {
      const st = await lstat(candidate);
      if (!st.isSymbolicLink()) {
        cur = candidate;
        rem = tail;
        continue;
      }
      if (visited.has(candidate)) {
        const e = new Error(`Too many symbolic links while resolving ${originalInput}`) as NodeJS.ErrnoException;
        e.code = "ELOOP";
        throw e;
      }
      visited.add(candidate);
      const linkTarget = resolvePath(dirname(candidate), await readlink(candidate));
      const targetParts = linkTarget.slice(parse(linkTarget).root.length).split(sep).filter((p) => p.length > 0);
      cur = parse(linkTarget).root;
      rem = [...targetParts, ...tail];
    } catch (error: unknown) {
      if (errCode(error) === "ENOENT") return join(candidate, ...tail);
      throw error;
    }
  }
  return cur;
}

export async function canonicalAsync(path: string): Promise<string> {
  const absolutePath = resolvePath(path);
  const { root } = parse(absolutePath);
  const parts = absolutePath.slice(root.length).split(sep).filter((p) => p.length > 0);
  return resPartsAsync(root, parts, new Set<string>(), path);
}
