/**
 * StoreConfig — deep module owning store tenancy config.
 * Owns yaml parsing, Zod validation, fs + env adapters, merge and mtime cache.
 * Paths and hash-store remain thin adapters via loadConfig().
 * @module dsh-better-edit/store-config
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { z } from "zod";
import { errCode } from "./utils.js";

// ---- helpers (pure, no IO) ----

function homeBase(): string {
	const envHome = process.env.HOME;
	return envHome && envHome.length > 0 ? envHome : homedir();
}

export function expand(filePath: string): string {
	const home = homeBase();
	if (filePath === "~") return home;
	if (filePath.startsWith("~/")) return home + filePath.slice(1);
	return filePath;
}

function stripQuotes(value: string): string {
	const t = value.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
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

// ---- Zod schema (single source of truth) ----

const StoreConfigSchema = z.object({
	storeDir: z
		.string()
		.default("central")
		.transform((v) => normalizeStoreDir(v) ?? "central"), // where the store lives: "central" (default, in $DSH_HOME/.../runtime/<name>-<hash8>/) | "workspace" (legacy <ws>/.dsh_better_edit/) | "/abs/path" (custom root)
	autoGitignore: z.boolean().default(false), // workspace only: auto-append ".dsh_better_edit/" to .gitignore when .git exists but entry missing (false = warn once)
	undo_ttl_s: z.number().int().min(-1).default(604800), // undo history TTL in seconds; -1 = keep forever (default 604800 = 7 days)
	storeMaxAgeS: z.number().int().min(1).default(2592000), // central janitor: max idle age in seconds before evicting runtime/<name>-<hash8>/ (default 2592000 = 30 days)
	storeMaxTotalBytes: z.number().int().min(0).default(524288000), // central janitor: max total bytes under runtime/ before LRU eviction (default 524288000 = 500 MB)
});

export type StoreConfig = z.infer<typeof StoreConfigSchema>;

const DEFAULT_CONFIG: StoreConfig = StoreConfigSchema.parse({});

let cachedConfig: StoreConfig | undefined;
let cachedMtimeMs: number | undefined;
let cachedYamlPath: string | undefined;
let cachedEnvStoreDir: string | undefined;
let cachedEnvAutoGitignore: string | undefined;

function configYamlPath(): string {
	return join(resolveDshHome(), "plugins", "dsh-better-edit", "config.yaml");
}

/** Default config.yaml content with comments — generated when the file does not exist. */
export const DEFAULT_CONFIG_YAML = `# dsh-better-edit config
# Location: $DSH_HOME/plugins/dsh-better-edit/config.yaml
# Docs: https://github.com/Rianico/dsh-better-edit#configuration
# Generated with defaults on first load — edit or delete freely.
# DB files are disposable caches — safe to delete, rebuilt on next \`read\`.

# where the store lives: "central" (default, in $DSH_HOME/.../runtime/<name>-<hash8>/) | "workspace" (legacy <ws>/.dsh_better_edit/) | "/abs/path" (custom root)
storeDir: central

# workspace only: when .git exists but .gitignore lacks .dsh_better_edit/, true = auto-append ".dsh_better_edit/", false = warn once
autoGitignore: false

# undo history TTL in seconds; -1 = keep forever (default 604800 = 7 days)
undo_ttl_s: 604800

# central janitor: max idle age in seconds before evicting runtime/<name>-<hash8>/ (default 2592000 = 30 days)
storeMaxAgeS: 2592000

# central janitor: max total bytes under runtime/ before LRU eviction (default 524288000 = 500 MB)
storeMaxTotalBytes: 524288000
`;

/**
 * Ensure a default config.yaml exists in the plugin home.
 * Idempotent and concurrent-safe (wx) — never overwrites an existing file.
 * Best-effort: failures are logged but never throw to the caller.
 */
export async function ensureDefaultConfig(homeDir?: string): Promise<void> {
	const dir = homeDir ?? join(resolveDshHome(), "plugins", "dsh-better-edit");
	const yamlPath = join(dir, "config.yaml");
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(yamlPath, DEFAULT_CONFIG_YAML, { encoding: "utf-8", flag: "wx" });
	} catch (error: unknown) {
		if (errCode(error) === "EEXIST") return;
		// ENOENT for missing parent is handled by mkdir, other errors are best-effort
		console.warn(
			`dsh-better-edit: failed to materialize default config at ${yamlPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

// ---- adapters ----

function fsAdapter(): Partial<StoreConfig> {
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
				// validate via Zod shape for enum/abs
				const res = z.string().safeParse(norm);
				if (res.success) out.storeDir = norm;
			}
		}

		if (parsed.autoGitignore !== undefined) {
			const b = parseAutoGitIgnoreRaw(parsed.autoGitignore);
			if (b === undefined) {
				console.warn(
					`dsh-better-edit: autoGitignore "${parsed.autoGitignore}" invalid — expected true|false, fallback to false`,
				);
			} else {
				const res = z.boolean().safeParse(b);
				if (res.success) out.autoGitignore = b;
			}
		}

		if (parsed.undo_ttl_s !== undefined) {
			const n = Number(parsed.undo_ttl_s);
			const res = z.number().int().min(-1).safeParse(n);
			if (res.success) {
				out.undo_ttl_s = n;
			} else {
				console.warn(
					`dsh-better-edit: undo_ttl_s "${parsed.undo_ttl_s}" invalid — expected int -1 or >=0, fallback to 604800`,
				);
			}
		}

		// storeMaxAgeS — unified seconds (canonical); deprecated aliases: storeMaxAgeDays / store_max_age_days (days -> seconds), store_max_age_s (snake)
		{
			let rawMaxAge: string | undefined;
			let rawSource: string | undefined;
			if (parsed.storeMaxAgeS !== undefined) {
				rawMaxAge = parsed.storeMaxAgeS;
				rawSource = "storeMaxAgeS";
			} else if (parsed.store_max_age_s !== undefined) {
				rawMaxAge = parsed.store_max_age_s;
				rawSource = "store_max_age_s";
			} else if (parsed.storeMaxAgeDays !== undefined) {
				rawMaxAge = parsed.storeMaxAgeDays;
				rawSource = "storeMaxAgeDays";
			} else if (parsed.store_max_age_days !== undefined) {
				rawMaxAge = parsed.store_max_age_days;
				rawSource = "store_max_age_days";
			}
			if (rawMaxAge !== undefined && rawSource !== undefined) {
				const n = Number(rawMaxAge);
				const isLegacyDays = rawSource === "storeMaxAgeDays" || rawSource === "store_max_age_days";
				if (isLegacyDays) {
					const res = z.number().int().min(1).safeParse(n);
					if (res.success) {
						out.storeMaxAgeS = n * 86400;
						console.warn(
							`dsh-better-edit: ${rawSource} is deprecated — use storeMaxAgeS (seconds) instead; converted ${n} days -> ${n * 86400} seconds`,
						);
					} else {
						console.warn(
							`dsh-better-edit: ${rawSource} "${rawMaxAge}" invalid — expected int >=1 (days)`,
						);
					}
				} else {
					const res = z.number().int().min(1).safeParse(n);
					if (res.success) {
						out.storeMaxAgeS = n;
						if (rawSource !== "storeMaxAgeS") {
							console.warn(
								`dsh-better-edit: ${rawSource} is deprecated — use storeMaxAgeS instead`,
							);
						}
					} else {
						console.warn(
							`dsh-better-edit: ${rawSource} "${rawMaxAge}" invalid — expected int >=1 (seconds)`,
						);
					}
				}
			}
		}

		if (parsed.storeMaxTotalBytes !== undefined) {
			const n = Number(parsed.storeMaxTotalBytes);
			const res = z.number().int().min(0).safeParse(n);
			if (res.success) {
				out.storeMaxTotalBytes = n;
			} else {
				console.warn(
					`dsh-better-edit: storeMaxTotalBytes "${parsed.storeMaxTotalBytes}" invalid — expected int >=0`,
				);
			}
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

function envAdapter(base: StoreConfig): Partial<StoreConfig> {
	const out: Partial<StoreConfig> = {};
	const envStoreDir = process.env.DSH_BETTER_EDIT_STORE_DIR;
	if (envStoreDir !== undefined) {
		const trimmed = envStoreDir.trim();
		if (trimmed.length === 0) {
			console.warn(`dsh-better-edit: DSH_BETTER_EDIT_STORE_DIR empty — fallback to ${base.storeDir}`);
		} else {
			const norm = normalizeStoreDir(trimmed);
			if (norm === undefined) {
				console.warn(
					`dsh-better-edit: DSH_BETTER_EDIT_STORE_DIR "${envStoreDir}" illegal/malformed — not absolute after expand, fallback to central`,
				);
			} else {
				out.storeDir = norm;
			}
		}
	}

	const envAuto = process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE;
	if (envAuto !== undefined) {
		const b = parseAutoGitIgnoreRaw(envAuto);
		if (b === undefined) {
			console.warn(
				`dsh-better-edit: DSH_BETTER_EDIT_AUTO_GITIGNORE "${envAuto}" invalid — expected true|false, fallback to ${base.autoGitignore}`,
			);
		} else {
			out.autoGitignore = b;
		}
	}
	return out;
}

// ---- public load (merged, cached) ----

export function loadConfig(): StoreConfig {
	const yamlPath = configYamlPath();
	let mtime: number | undefined;
	try {
		mtime = statSync(yamlPath).mtimeMs;
	} catch {
		// no yaml file — fall through to defaults/cache miss
	}
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

	const yamlPartial = fsAdapter();
	const envPartial = envAdapter({ ...DEFAULT_CONFIG, ...yamlPartial });
	const merged = { ...DEFAULT_CONFIG, ...yamlPartial, ...envPartial };

	// final Zod validation + normalization (expand abs, fallback)
	const parsed = StoreConfigSchema.safeParse(merged);
	const cfg = parsed.success ? parsed.data : { ...DEFAULT_CONFIG, ...yamlPartial, ...envPartial };

	if (cfg.storeDir !== "workspace" && cfg.storeDir !== "central") {
		const expanded = expand(cfg.storeDir);
		if (isAbsolute(expanded)) cfg.storeDir = expanded;
		else {
			console.warn(`dsh-better-edit: storeDir "${cfg.storeDir}" illegal/malformed — fallback to central`);
			cfg.storeDir = "central";
		}
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
