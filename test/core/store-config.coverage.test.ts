import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, _resetConfigCache, ensureDefaultConfig, expand } from "../../src/store-config.js";

describe("store-config — complement, env, aliases, cache", () => {
	let tmpHome: string;
	const envKeys = [
		"DSH_BETTER_EDIT_STORE_DIR",
		"DSH_BETTER_EDIT_AUTO_GUESS_ENCODING",
		"DSH_BETTER_EDIT_NORMALIZE_TO_UTF8",
		"DSH_BETTER_EDIT_SUPPORTED_ENCODINGS",
		"DSH_BETTER_EDIT_AUTO_GITIGNORE",
	] as const;

	beforeEach(async () => {
		tmpHome = await mkdtemp(join(tmpdir(), "scov-"));
		vi.stubEnv("HOME", tmpHome);
		vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
		for (const k of envKeys) vi.stubEnv(k, "");
		// clear the stubbed empties so they behave as undefined
		for (const k of envKeys) {
			const v = process.env[k];
			if (v === "") delete process.env[k];
		}
		_resetConfigCache();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		_resetConfigCache();
		await rm(tmpHome, { recursive: true, force: true });
	});


	it("ensureDefaultConfig creates file with defaults", async () => {
		const dir = join(tmpHome, ".dsh", "plugins", "dsh-better-edit");
		await ensureDefaultConfig();
		const txt = await readFile(join(dir, "config.yaml"), "utf-8");
		expect(txt).toContain("storeDir: central");
		expect(txt).toContain("autoGuessEncoding: false");
	});

	it("loadConfig complements missing keys by appending defaults", async () => {
		const cfgDir = join(tmpHome, ".dsh", "plugins", "dsh-better-edit");
		await mkdir(cfgDir, { recursive: true });
		// only one key
		await writeFile(join(cfgDir, "config.yaml"), "storeDir: central\n", "utf-8");
		_resetConfigCache();
		const cfg = loadConfig();
		expect(cfg.storeDir).toBe("central");
		// complement should have appended
		const after = await readFile(join(cfgDir, "config.yaml"), "utf-8");
		expect(after).toContain("autoGuessEncoding: false");
		expect(after).toContain("normalizeToUtf8: false");
		expect(after).toContain("supportedEncodings:");
		expect(after).toContain("undo_ttl_s: 604800");
		expect(after).toContain("storeMaxAgeS: 2592000");
		expect(after).toContain("storeMaxTotalBytes: 524288000");
		// second load uses updated mtime cache, still works
		const cfg2 = loadConfig();
		expect(cfg2.autoGuessEncoding).toBe(false);
	});

	it("does not duplicate when file already complete", async () => {
		const cfgDir = join(tmpHome, ".dsh", "plugins", "dsh-better-edit");
		await mkdir(cfgDir, { recursive: true });
		await ensureDefaultConfig();
		const before = await readFile(join(cfgDir, "config.yaml"), "utf-8");
		_resetConfigCache();
		loadConfig();
		const after = await readFile(join(cfgDir, "config.yaml"), "utf-8");
		expect(after).toBe(before);
	});

	it("envAdapter invalid values fall back with warn", async () => {
		const cfgDir = join(tmpHome, ".dsh", "plugins", "dsh-better-edit");
		await mkdir(cfgDir, { recursive: true });
		await writeFile(join(cfgDir, "config.yaml"), "storeDir: central\n", "utf-8");
		process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "notabool";
		process.env.DSH_BETTER_EDIT_SUPPORTED_ENCODINGS = "";
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		_resetConfigCache();
		const cfg = loadConfig();
		expect(cfg.autoGuessEncoding).toBe(false); // default, invalid env ignored
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it("storeMaxAgeS deprecated aliases map correctly", async () => {
		const cfgDir = join(tmpHome, ".dsh", "plugins", "dsh-better-edit");
		await mkdir(cfgDir, { recursive: true });

		// store_max_age_s (snake seconds)
		await writeFile(join(cfgDir, "config.yaml"), "store_max_age_s: 100\n", "utf-8");
		_resetConfigCache();
		expect(loadConfig().storeMaxAgeS).toBe(100);

		// storeMaxAgeDays (days -> seconds)
		await writeFile(join(cfgDir, "config.yaml"), "storeMaxAgeDays: 2\n", "utf-8");
		_resetConfigCache();
		expect(loadConfig().storeMaxAgeS).toBe(2 * 86400);

		// store_max_age_days (snake days)
		await writeFile(join(cfgDir, "config.yaml"), "store_max_age_days: 1\n", "utf-8");
		_resetConfigCache();
		expect(loadConfig().storeMaxAgeS).toBe(86400);

		// canonical takes precedence, alias ignored
		await writeFile(join(cfgDir, "config.yaml"), "storeMaxAgeS: 123\nstore_max_age_s: 999\n", "utf-8");
		_resetConfigCache();
		expect(loadConfig().storeMaxAgeS).toBe(123);
	});

	it("invalid storeMaxAgeS values warn and use default", async () => {
		const cfgDir = join(tmpHome, ".dsh", "plugins", "dsh-better-edit");
		await mkdir(cfgDir, { recursive: true });
		await writeFile(join(cfgDir, "config.yaml"), "storeMaxAgeS: notanumber\n", "utf-8");
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		_resetConfigCache();
		const cfg = loadConfig();
		expect(cfg.storeMaxAgeS).toBe(2592000);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it("expand handles ~ and ~/", () => {
		const home = process.env.HOME!;
		expect(expand("~")).toBe(home);
		expect(expand("~/a/b")).toBe(home + "/a/b");
		expect(expand("/abs")).toBe("/abs");
	});

	it("mtime cache: second load without file change returns same object", async () => {
		const cfgDir = join(tmpHome, ".dsh", "plugins", "dsh-better-edit");
		await mkdir(cfgDir, { recursive: true });
		await writeFile(join(cfgDir, "config.yaml"), "storeDir: central\nautoGuessEncoding: true\n", "utf-8");
		_resetConfigCache();
		const a = loadConfig();
		const b = loadConfig();
		expect(a).toBe(b); // same cached object
		expect(a.autoGuessEncoding).toBe(true);
	});

	it("mtime cache invalidates when file changes", async () => {
		const cfgDir = join(tmpHome, ".dsh", "plugins", "dsh-better-edit");
		await mkdir(cfgDir, { recursive: true });
		await writeFile(join(cfgDir, "config.yaml"), "autoGuessEncoding: false\n", "utf-8");
		_resetConfigCache();
		const a = loadConfig();
		expect(a.autoGuessEncoding).toBe(false);
		// wait a tick and rewrite with different value, ensure mtime changes
		await new Promise((r) => setTimeout(r, 20));
		await writeFile(join(cfgDir, "config.yaml"), "autoGuessEncoding: true\n", "utf-8");
		const b = loadConfig();
		expect(b.autoGuessEncoding).toBe(true);
		expect(b).not.toBe(a);
	});

	it("env cache invalidates when env changes", async () => {
		const cfgDir = join(tmpHome, ".dsh", "plugins", "dsh-better-edit");
		await mkdir(cfgDir, { recursive: true });
		await writeFile(join(cfgDir, "config.yaml"), "autoGuessEncoding: false\n", "utf-8");
		_resetConfigCache();
		expect(loadConfig().autoGuessEncoding).toBe(false);
		process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
		expect(loadConfig().autoGuessEncoding).toBe(true);
		// back to false via env removal
		delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
		expect(loadConfig().autoGuessEncoding).toBe(false);
	});

	it("illegal storeDir falls back to central", async () => {
		const cfgDir = join(tmpHome, ".dsh", "plugins", "dsh-better-edit");
		await mkdir(cfgDir, { recursive: true });
		await writeFile(join(cfgDir, "config.yaml"), "storeDir: relative/path\n", "utf-8");
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		_resetConfigCache();
		const cfg = loadConfig();
		expect(cfg.storeDir).toBe("central");
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});
