/**
 * Canonical path resolution — single seam for symlink-aware canonicalization.
 * Pure traversal owns the visited-set + ELOOP + ENOENT (lexical tail) invariant.
 * Two adapters justify the seam: sync (hash8, sanitizedBasename, central tenancy)
 * and async (resolveTarget). Byte-identical to the previous duplicated impl.
 * @module dsh-better-edit/canonical-path
 */

import { dirname, join, parse, sep } from "node:path";
import { resolve as resolvePath } from "node:path";
import { lstat as lstatAsync, readlink as readlinkAsync } from "node:fs/promises";
import { lstatSync, readlinkSync } from "node:fs";
import { errCode } from "./utils.js";

function splitAfterRoot(absolutePath: string): { root: string; parts: string[] } {
	const { root } = parse(absolutePath);
	return {
		root,
		parts: absolutePath.slice(root.length).split(sep).filter((p) => p.length > 0),
	};
}

function eLoopError(ws: string): NodeJS.ErrnoException {
	const e = new Error(`Too many symbolic links while resolving ${ws}`) as NodeJS.ErrnoException;
	e.code = "ELOOP";
	return e;
}

/** Sync adapter — lstatSync + readlinkSync. */
export function canonicalSync(inputPath: string): string {
	const absolutePath = resolvePath(inputPath);
	const { root, parts } = splitAfterRoot(absolutePath);
	const visited = new Set<string>();
	let current = root;
	let remaining = parts.slice();
	while (remaining.length > 0) {
		const [next, ...tail] = remaining;
		const candidate = join(current, next!);
		try {
			const st = lstatSync(candidate);
			if (!st.isSymbolicLink()) {
				current = candidate;
				remaining = tail;
				continue;
			}
			if (visited.has(candidate)) throw eLoopError(inputPath);
			visited.add(candidate);
			const linkTarget = resolvePath(dirname(candidate), readlinkSync(candidate));
			const targetParts = splitAfterRoot(linkTarget);
			current = targetParts.root;
			remaining = [...targetParts.parts, ...tail];
		} catch (error: unknown) {
			if (errCode(error) === "ENOENT") return join(candidate, ...tail);
			throw error;
		}
	}
	return current;
}

/** Async adapter — lstat + readlink. Thin async shell over the same traversal. */
export async function canonicalAsync(inputPath: string): Promise<string> {
	const absolutePath = resolvePath(inputPath);
	const { root, parts } = splitAfterRoot(absolutePath);
	const visited = new Set<string>();

	async function resParts(currentPath: string, remainingParts: string[]): Promise<string> {
		if (remainingParts.length === 0) return currentPath;
		const [nextPart, ...tail] = remainingParts;
		const candidatePath = join(currentPath, nextPart);
		try {
			const candidateStats = await lstatAsync(candidatePath);
			if (!candidateStats.isSymbolicLink()) return resParts(candidatePath, tail);
			if (visited.has(candidatePath)) throw eLoopError(inputPath);
			visited.add(candidatePath);
			const linkTargetPath = resolvePath(dirname(candidatePath), await readlinkAsync(candidatePath));
			const targetParts = splitAfterRoot(linkTargetPath);
			return resParts(targetParts.root, [...targetParts.parts, ...tail]);
		} catch (error: unknown) {
			if (errCode(error) === "ENOENT") return join(candidatePath, ...tail);
			throw error;
		}
	}

	return resParts(root, parts);
}
