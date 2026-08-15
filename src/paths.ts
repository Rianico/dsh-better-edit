import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath, join, dirname } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/**
 * On-disk home for dsh-better-edit state. Inside a tool call the store lives
 * co-located with the files being edited: `<workspace>/.dsh_better_edit/` (the
 * workspace is the session cwd, carried through the execution by
 * `withWorkspace`). Outside a tool call — tests, previews, startup — the store
 * falls back to the shared DeepSeek Harness home
 * (`$DSH_HOME/plugins/dsh-better-edit`, default `~/.dsh/plugins/dsh-better-edit`),
 * so a caller without a workspace never writes into an arbitrary cwd.
 * @param cwd - the workspace root, or undefined for the shared-home fallback.
 */
export function configDir(cwd?: string): string {
	return cwd !== undefined
		? join(resolvePath(cwd), ".dsh_better_edit")
		: join(resolveDshHome(), "plugins", "dsh-better-edit");
}

export function hashStorePath(cwd?: string): string {
	return join(configDir(cwd), "hash-store.sqlite");
}

export function legacyHashStorePath(cwd?: string): string {
	return join(configDir(cwd), "hash-store.json");
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
