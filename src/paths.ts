import { homedir } from "node:os";
import {
	isAbsolute,
	resolve as resolvePath,
	join,
	dirname,
	parse,
	sep,
} from "node:path";
import { lstat, readlink } from "node:fs/promises";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { errCode } from "./utils.js";

import { loadConfig } from "./store-config.js";
export type { StoreConfig } from "./store-config.js";
export { loadConfig, _resetConfigCache } from "./store-config.js";

// ---- path helpers ----

function canonicalWsSync(ws: string): string {
	const absolutePath = resolvePath(ws);
	const { root } = parse(absolutePath);
	const parts = absolutePath
		.slice(root.length)
		.split(sep)
		.filter((p) => p.length > 0);
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
			if (visited.has(candidate)) {
				const e = new Error(
					`Too many symbolic links while resolving ${ws}`,
				) as NodeJS.ErrnoException;
				e.code = "ELOOP";
				throw e;
			}
			visited.add(candidate);
			const linkTarget = resolvePath(dirname(candidate), readlinkSync(candidate));
			const targetParts = linkTarget
				.slice(parse(linkTarget).root.length)
				.split(sep)
				.filter((p) => p.length > 0);
			current = parse(linkTarget).root;
			remaining = [...targetParts, ...tail];
		} catch (error: unknown) {
			if (errCode(error) === "ENOENT") return join(candidate, ...tail);
			throw error;
		}
	}
	return current;
}

function sanitizedBasename(ws: string): string {
	const base = parse(canonicalWsSync(ws)).base || "root";
	const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32);
	return sanitized.length > 0 ? sanitized : "root";
}

function hash8(ws: string): string {
	const canonical = canonicalWsSync(ws);
	return createHash("sha1").update(canonical).digest("hex").slice(0, 8);
}

function ensureWsPathSidecar(dir: string, canonicalWs: string): void {
	try {
		const wsPathFile = join(dir, ".wsPath");
		if (existsSync(wsPathFile)) {
			const existing = readFileSync(wsPathFile, "utf-8").trim();
			if (existing !== canonicalWs) {
				console.warn(
					`dsh-better-edit: central store collision for ${dir}: stored wsPath "${existing}" != current "${canonicalWs}" — keeping existing, hash collision risk`,
				);
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
			cpSync(legacyDir, centralDir, {
				recursive: true,
				force: false,
				errorOnExist: false,
			});
			ensureWsPathSidecar(centralDir, canonicalWsSync(cwd));
			console.warn(
				`dsh-better-edit: migrated legacy workspace store ${legacyDir} -> ${centralDir}`,
			);
		}
	} catch {
		// best-effort
	}
}

function resolveStoreDir(cwd?: string): string {
	if (cwd === undefined) {
		return join(resolveDshHome(), "plugins", "dsh-better-edit");
	}
	const cfg = loadConfig();
	const sd = cfg.storeDir;
	if (sd === "workspace") {
		return join(resolvePath(cwd), ".dsh_better_edit");
	}
	const canonical = canonicalWsSync(cwd);
	const h = hash8(cwd);
	if (sd === "central") {
		const dir = join(
			resolveDshHome(),
			"plugins",
			"dsh-better-edit",
			"runtime",
			`${sanitizedBasename(cwd)}-${h}`,
		);
		ensureWsPathSidecar(dir, canonical);
		migrateLegacyIfNeeded(cwd, dir);
		return dir;
	}
	const dir = join(sd, h);
	ensureWsPathSidecar(dir, canonical);
	migrateLegacyIfNeeded(cwd, dir);
	return dir;
}
/**
 * On-disk home for dsh-better-edit state. Inside a tool call the store lives
 * according to tenancy config: `central` (default) → `$DSH_HOME/plugins/dsh-better-edit/runtime/<name>-<hash8>/`, `workspace` → `<workspace>/.dsh_better_edit/`, or custom absolute root. Outside a tool call — tests, previews, startup — the store
 * falls back to the shared DeepSeek Harness home
 * (`$DSH_HOME/plugins/dsh-better-edit`, default `~/.dsh/plugins/dsh-better-edit`),
 * so a caller without a workspace never writes into an arbitrary cwd.
 * @param cwd - the workspace root, or undefined for the shared-home fallback.
 */
export function configDir(cwd?: string): string {
	return resolveStoreDir(cwd);
}

export function hashStorePath(cwd?: string): string {
	return join(configDir(cwd), "hash-store.sqlite");
}

export function legacyHashStorePath(cwd?: string): string {
	// legacy always was workspace co-located, regardless of current tenancy
	if (cwd === undefined)
		return join(
			resolveDshHome(),
			"plugins",
			"dsh-better-edit",
			"hash-store.json",
		);
	return join(resolvePath(cwd), ".dsh_better_edit", "hash-store.json");
}

export function hashStoreDir(cwd?: string): string {
	return dirname(hashStorePath(cwd));
}

function homeBase(): string {
	const envHome = process.env.HOME;
	return envHome && envHome.length > 0 ? envHome : homedir();
}

function expand(filePath: string): string {
	const home = homeBase();
	if (filePath === "~") return home;
	if (filePath.startsWith("~/")) return home + filePath.slice(1);
	return filePath;
}

export function toCwd(filePath: string, cwd: string): string {
	const expanded = expand(filePath);
	return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

/**
 * Canonicalize a path, resolving every symlink component to its target
 * (loop-guarded, ELOOP on cycles). Non-existent final components resolve
 * lexically — the canonical form of a not-yet-created file. The hashline
 * tools key their state by canonical absolute paths, so the same file reached
 * through different symlink spellings lands on the same store rows.
 * @param path - the path to canonicalize (absolute or relative).
 */
export async function resolveTarget(path: string): Promise<string> {
	const absolutePath = resolvePath(path);
	const { root } = parse(absolutePath);
	const parts = absolutePath
		.slice(root.length)
		.split(sep)
		.filter((part) => part.length > 0);
	const visitedSymlinks = new Set<string>();

	async function resParts(
		currentPath: string,
		remainingParts: string[],
	): Promise<string> {
		if (remainingParts.length === 0) {
			return currentPath;
		}

		const [nextPart, ...tail] = remainingParts;
		const candidatePath = join(currentPath, nextPart);

		try {
			const candidateStats = await lstat(candidatePath);
			if (!candidateStats.isSymbolicLink()) {
				return resParts(candidatePath, tail);
			}

			if (visitedSymlinks.has(candidatePath)) {
				const error = new Error(
					`Too many symbolic links while resolving ${path}`,
				) as NodeJS.ErrnoException;
				error.code = "ELOOP";
				throw error;
			}
			visitedSymlinks.add(candidatePath);

			const linkTargetPath = resolvePath(
				dirname(candidatePath),
				await readlink(candidatePath),
			);
			const targetParts = linkTargetPath
				.slice(parse(linkTargetPath).root.length)
				.split(sep)
				.filter((part) => part.length > 0);
			return resParts(parse(linkTargetPath).root, [...targetParts, ...tail]);
		} catch (error: unknown) {
			if (errCode(error) === "ENOENT") {
				return join(candidatePath, ...tail);
			}
			throw error;
		}
	}

	return resParts(root, parts);
}
