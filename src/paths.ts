import { homedir } from "node:os";
import {
	isAbsolute,
	resolve as resolvePath,
	join,
	dirname,
	parse,
} from "node:path";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { canonicalAsync, canonicalSync } from "./canonical-path.js";
import { createHash } from "node:crypto";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { errCode } from "./utils.js";

// ---- config seam (ticket 01) ----

export interface StoreConfig {
	storeDir: string; // "workspace" | "central" | "/abs/path" (expanded, absolute or enum)
	autoGitignore: boolean;
	undo_ttl_s: number;
	storeMaxAgeDays: number;
	storeMaxTotalBytes: number;
}

const DEFAULT_CONFIG: StoreConfig = {
	storeDir: "central",
	autoGitignore: false,
	undo_ttl_s: 604800,
	storeMaxAgeDays: 30,
	storeMaxTotalBytes: 524288000,
};

let cachedConfig: StoreConfig | undefined;
let cachedMtimeMs: number | undefined;
let cachedYamlPath: string | undefined;
let cachedEnvStoreDir: string | undefined;
let cachedEnvAutoGitignore: string | undefined;

function configYamlPath(): string {
	return join(resolveDshHome(), "plugins", "dsh-better-edit", "config.yaml");
}

function stripQuotes(value: string): string {
	const t = value.trim();
	if (
		(t.startsWith('"') && t.endsWith('"')) ||
		(t.startsWith("'") && t.endsWith("'"))
	) {
		return t.slice(1, -1).trim();
	}
	return t;
}

function stripInlineComment(value: string): string {
	const idx = value.indexOf(" #");
	return idx === -1 ? value : value.slice(0, idx).trim();
}

function parseSimpleYaml(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		let value = line.slice(colon + 1).trim();
		value = stripQuotes(value);
		value = stripInlineComment(value);
		out[key] = value;
	}
	return out;
}

function expandHome(filePath: string): string {
	return expand(filePath);
}

function normalizeStoreDir(v: string): string | undefined {
	const val = stripQuotes(v.trim());
	if (val.length === 0) return undefined;
	if (val === "workspace" || val === "central") return val;
	const expanded = expand(val);
	return isAbsolute(expanded) ? expanded : undefined;
}

function parseAutoGitIgnoreRaw(v: string): boolean | undefined {
	const t = v.trim().toLowerCase();
	if (t === "true") return true;
	if (t === "false") return false;
	return undefined;
}

function loadYamlConfig(): Partial<StoreConfig> {
	const yamlPath = configYamlPath();
	try {
		const raw = readFileSync(yamlPath, "utf-8");
		const parsed = parseSimpleYaml(raw);
		const out: Partial<StoreConfig> = {};
		if (parsed.storeDir !== undefined) {
			const norm = normalizeStoreDir(parsed.storeDir);
			if (norm === undefined) {
				console.warn(
					`dsh-better-edit: storeDir "${parsed.storeDir}" illegal/malformed — not absolute after expand, fallback to central`,
				);
			} else {
				out.storeDir = norm;
			}
		}
		if (parsed.autoGitignore !== undefined) {
			const b = parseAutoGitIgnoreRaw(parsed.autoGitignore);
			if (b === undefined) {
				console.warn(
					`dsh-better-edit: autoGitignore "${parsed.autoGitignore}" invalid — expected true|false, fallback to false`,
				);
			} else {
				out.autoGitignore = b;
			}
		}
		if (parsed.undo_ttl_s !== undefined) {
			const n = Number(parsed.undo_ttl_s);
			if (Number.isInteger(n) && (n === -1 || n >= 0)) out.undo_ttl_s = n;
			else
				console.warn(
					`dsh-better-edit: undo_ttl_s "${parsed.undo_ttl_s}" invalid — expected int -1 or >=0, fallback to 604800`,
				);
		}
		if (parsed.storeMaxAgeDays !== undefined) {
			const n = Number(parsed.storeMaxAgeDays);
			if (Number.isInteger(n) && n >= 1) out.storeMaxAgeDays = n;
			else
				console.warn(
					`dsh-better-edit: storeMaxAgeDays "${parsed.storeMaxAgeDays}" invalid — expected int >=1`,
				);
		}
		if (parsed.storeMaxTotalBytes !== undefined) {
			const n = Number(parsed.storeMaxTotalBytes);
			if (Number.isInteger(n) && n >= 0) out.storeMaxTotalBytes = n;
			else
				console.warn(
					`dsh-better-edit: storeMaxTotalBytes "${parsed.storeMaxTotalBytes}" invalid — expected int >=0`,
				);
		}
		return out;
	} catch (error: unknown) {
		if (errCode(error) === "ENOENT") return {};
		console.warn(
			`dsh-better-edit: failed to read config yaml ${yamlPath}: ${error instanceof Error ? error.message : String(error)} — fallback to central`,
		);
		return {};
	}
}

export function loadConfig(): StoreConfig {
	const yamlPath = configYamlPath();
	let mtime: number | undefined;
	try {
		mtime = statSync(yamlPath).mtimeMs;
	} catch {}
	const envStoreDir = process.env.DSH_BETTER_EDIT_STORE_DIR;
	const envAuto = process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE;
	if (
		cachedConfig !== undefined &&
		cachedMtimeMs === mtime &&
		cachedYamlPath === yamlPath &&
		cachedEnvStoreDir === envStoreDir &&
		cachedEnvAutoGitignore === envAuto
	) {
		return cachedConfig;
	}
	const yamlPartial = loadYamlConfig();
	const cfg: StoreConfig = { ...DEFAULT_CONFIG, ...yamlPartial };
	if (envStoreDir !== undefined) {
		const trimmed = envStoreDir.trim();
		if (trimmed.length === 0) {
			console.warn(
				`dsh-better-edit: DSH_BETTER_EDIT_STORE_DIR empty — fallback to ${cfg.storeDir}`,
			);
		} else {
			const norm = normalizeStoreDir(trimmed);
			if (norm === undefined) {
				console.warn(
					`dsh-better-edit: DSH_BETTER_EDIT_STORE_DIR "${envStoreDir}" illegal/malformed — not absolute after expand, fallback to central`,
				);
			} else {
				cfg.storeDir = norm;
			}
		}
	}
	if (envAuto !== undefined) {
		const b = parseAutoGitIgnoreRaw(envAuto);
		if (b === undefined) {
			console.warn(
				`dsh-better-edit: DSH_BETTER_EDIT_AUTO_GITIGNORE "${envAuto}" invalid — expected true|false, fallback to ${cfg.autoGitignore}`,
			);
		} else {
			cfg.autoGitignore = b;
		}
	}
	if (
		cfg.storeDir !== "workspace" &&
		cfg.storeDir !== "central" &&
		!isAbsolute(expand(cfg.storeDir))
	) {
		console.warn(
			`dsh-better-edit: storeDir "${cfg.storeDir}" illegal/malformed — fallback to central`,
		);
		cfg.storeDir = "central";
	} else if (cfg.storeDir !== "workspace" && cfg.storeDir !== "central") {
		cfg.storeDir = expand(cfg.storeDir);
	}
	cachedConfig = cfg;
	cachedMtimeMs = mtime;
	cachedYamlPath = yamlPath;
	cachedEnvStoreDir = envStoreDir;
	cachedEnvAutoGitignore = envAuto;
	return cfg;
}

// For tests: reset cache
export function _resetConfigCache(): void {
	cachedConfig = undefined;
	cachedMtimeMs = undefined;
	cachedYamlPath = undefined;
	cachedEnvStoreDir = undefined;
	cachedEnvAutoGitignore = undefined;
}

// ---- path helpers ----

function canonicalWsSync(ws: string): string {
	return canonicalSync(ws);
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
	return canonicalAsync(path);
}
