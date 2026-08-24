/**
 * StoreConfig — deep module owning store tenancy config.
 * Owns yaml parsing, Zod validation, fs + env adapters, merge and mtime cache.
 * Paths and hash-store remain thin adapters via loadConfig().
 * @module dsh-better-edit/store-config
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { z } from "zod";
import { errCode } from "./utils.js";

// ---- helpers (pure, no IO) ----

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
		.transform((v) => normalizeStoreDir(v) ?? "central"),
	autoGitignore: z.boolean().default(false),
	undo_ttl_s: z.number().int().min(-1).default(604800),
	storeMaxAgeDays: z.number().int().min(1).default(30),
	storeMaxTotalBytes: z.number().int().min(0).default(524288000),
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
			if (!res.success) {
				console.warn(
					`dsh-better-edit: undo_ttl_s "${parsed.undo_ttl_s}" invalid — expected int -1 or >=0, fallback to 604800`,
				);
			} else {
				out.undo_ttl_s = n;
			}
		}

		if (parsed.storeMaxAgeDays !== undefined) {
			const n = Number(parsed.storeMaxAgeDays);
			const res = z.number().int().min(1).safeParse(n);
			if (!res.success) {
				console.warn(
					`dsh-better-edit: storeMaxAgeDays "${parsed.storeMaxAgeDays}" invalid — expected int >=1`,
				);
			} else {
				out.storeMaxAgeDays = n;
			}
		}

		if (parsed.storeMaxTotalBytes !== undefined) {
			const n = Number(parsed.storeMaxTotalBytes);
			const res = z.number().int().min(0).safeParse(n);
			if (!res.success) {
				console.warn(
					`dsh-better-edit: storeMaxTotalBytes "${parsed.storeMaxTotalBytes}" invalid — expected int >=0`,
				);
			} else {
				out.storeMaxTotalBytes = n;
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
