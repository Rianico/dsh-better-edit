import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath, join, dirname } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/**
 * On-disk home for dsh-better-edit state, under the DeepSeek Harness home
 * ($DSH_HOME, defaulting to ~/.dsh). The hashline hash snapshots, served-state
 * rows, and undo history live under a plugin-owned subdirectory so multiple
 * dsh installs on one machine share one coherent store keyed by absolute path.
 */
export function configDir(): string {
	return join(resolveDshHome(), "plugins", "dsh-better-edit");
}

export function hashStorePath(): string {
	return join(configDir(), "hash-store.sqlite");
}

export function legacyHashStorePath(): string {
	return join(configDir(), "hash-store.json");
}

export function hashStoreDir(): string {
	return dirname(hashStorePath());
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
