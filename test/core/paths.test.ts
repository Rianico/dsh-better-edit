import { describe, expect, it, vi } from "vitest";
import { join, dirname } from "node:path";
import { defaultDshHome } from "@deepseek-ai/dsh-home-paths";
import { configDir, hashStorePath, hashStoreDir } from "../../src/paths.js";

describe("configDir", () => {
	it("returns the store dir under the default DSH home when DSH_HOME is unset", () => {
		const previousDsh = process.env.DSH_HOME;
		delete process.env.DSH_HOME;
		try {
			expect(configDir()).toBe(
				join(defaultDshHome(), "plugins", "dsh-better-edit"),
			);
		} finally {
			if (previousDsh === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previousDsh;
		}
	});

	it("uses DSH_HOME when set", () => {
		const previousDsh = process.env.DSH_HOME;
		process.env.DSH_HOME = "/custom/dsh";
		try {
			expect(configDir()).toBe(join("/custom/dsh", "plugins", "dsh-better-edit"));
		} finally {
			if (previousDsh === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previousDsh;
		}
	});

	it("ignores an empty DSH_HOME", () => {
		const previousDsh = process.env.DSH_HOME;
		process.env.DSH_HOME = "   ";
		try {
			expect(configDir()).toBe(
				join(defaultDshHome(), "plugins", "dsh-better-edit"),
			);
		} finally {
			if (previousDsh === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previousDsh;
		}
	});
});

describe("hashStorePath", () => {
	it("returns the hash store file path", () => {
		const path = hashStorePath();
		expect(path).toBe(join(configDir(), "hash-store.sqlite"));
	});
});

describe("hashStoreDir", () => {
	it("returns the directory of the hash store path", () => {
		const dir = hashStoreDir();
		expect(dir).toBe(dirname(hashStorePath()));
	});
});

describe("store tenancy — central default", () => {
	it("defaults to central runtime/<name>-<hash8> when cwd given", async () => {
		const { configDir, _resetConfigCache } = await import("../../src/paths.js");
		_resetConfigCache();
		const prevStore = process.env.DSH_BETTER_EDIT_STORE_DIR;
		const prevAuto = process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE;
		const prevDsh = process.env.DSH_HOME;
		delete process.env.DSH_BETTER_EDIT_STORE_DIR;
		delete process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE;
		process.env.DSH_HOME = "/tmp/dsh-home-test";
		try {
			const dir = configDir("/ws/my-app");
			expect(dir.startsWith(join("/tmp/dsh-home-test", "plugins", "dsh-better-edit", "runtime", "my-app-"))).toBe(true);
			expect(dir.slice(-8)).toMatch(/^[0-9a-f]{8}$/);
		} finally {
			if (prevStore === undefined) delete process.env.DSH_BETTER_EDIT_STORE_DIR;
			else process.env.DSH_BETTER_EDIT_STORE_DIR = prevStore;
			if (prevAuto === undefined) delete process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE;
			else process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE = prevAuto;
			if (prevDsh === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = prevDsh;
			const { _resetConfigCache: r } = await import("../../src/paths.js");
			r();
		}
	});

	it("env workspace overrides to legacy .dsh_better_edit", async () => {
		const { configDir, _resetConfigCache } = await import("../../src/paths.js");
		_resetConfigCache();
		const prevStore = process.env.DSH_BETTER_EDIT_STORE_DIR;
		process.env.DSH_BETTER_EDIT_STORE_DIR = "workspace";
		try {
			expect(configDir("/ws/my-app")).toBe(join("/ws/my-app", ".dsh_better_edit"));
		} finally {
			if (prevStore === undefined) delete process.env.DSH_BETTER_EDIT_STORE_DIR;
			else process.env.DSH_BETTER_EDIT_STORE_DIR = prevStore;
			const { _resetConfigCache: r } = await import("../../src/paths.js");
			r();
		}
	});

	it("env custom abs path uses hash suffix", async () => {
		const { configDir, _resetConfigCache } = await import("../../src/paths.js");
		_resetConfigCache();
		const prevStore = process.env.DSH_BETTER_EDIT_STORE_DIR;
		process.env.DSH_BETTER_EDIT_STORE_DIR = "/custom/store";
		try {
			const dir = configDir("/ws/my-app");
			expect(dir.startsWith("/custom/store/")).toBe(true);
			expect(dir.slice(-8)).toMatch(/^[0-9a-f]{8}$/);
		} finally {
			if (prevStore === undefined) delete process.env.DSH_BETTER_EDIT_STORE_DIR;
			else process.env.DSH_BETTER_EDIT_STORE_DIR = prevStore;
			const { _resetConfigCache: r } = await import("../../src/paths.js");
			r();
		}
	});

	it("malformed storeDir falls back to central with warn", async () => {
		const { configDir, _resetConfigCache } = await import("../../src/paths.js");
		_resetConfigCache();
		const prevStore = process.env.DSH_BETTER_EDIT_STORE_DIR;
		process.env.DSH_BETTER_EDIT_STORE_DIR = "./relative";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const dir = configDir("/ws/my-app");
			expect(dir).toContain("runtime");
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			if (prevStore === undefined) delete process.env.DSH_BETTER_EDIT_STORE_DIR;
			else process.env.DSH_BETTER_EDIT_STORE_DIR = prevStore;
			const { _resetConfigCache: r } = await import("../../src/paths.js");
			r();
		}
	});

	it("DSH_BETTER_EDIT_AUTO_GITIGNORE true|false case-insensitive", async () => {
		const { loadConfig, _resetConfigCache } = await import("../../src/paths.js");
		_resetConfigCache();
		const prevAuto = process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE;
		process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE = "TRUE";
		try {
			expect(loadConfig().autoGitignore).toBe(true);
		} finally {
			if (prevAuto === undefined) delete process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE;
			else process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE = prevAuto;
			const { _resetConfigCache: r } = await import("../../src/paths.js");
			r();
		}
		_resetConfigCache();
		process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE = "False";
		expect(loadConfig().autoGitignore).toBe(false);
		if (prevAuto === undefined) delete process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE;
		else process.env.DSH_BETTER_EDIT_AUTO_GITIGNORE = prevAuto;
		const { _resetConfigCache: r2 } = await import("../../src/paths.js");
		r2();
	});
});
