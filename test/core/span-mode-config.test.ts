import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, _resetConfigCache, DEFAULT_CONFIG_YAML } from "../../src/store-config.js";
import {
  isSpanMode,
  parseSpanMode,
  SPAN_MODE_DEFAULT,
  SPAN_MODE_ENV_VAR,
} from "../../src/span-mode.js";

describe("span mode — config policy seam", () => {
  let tmpHome: string;
  const cfgDir = () => join(tmpHome, ".dsh", "plugins", "dsh-better-edit");

  async function writeCfg(text: string): Promise<void> {
    await mkdir(cfgDir(), { recursive: true });
    await writeFile(join(cfgDir(), "config.yaml"), text, "utf-8");
    _resetConfigCache();
  }

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "span-mode-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
    vi.stubEnv("DSH_BETTER_EDIT_SPAN_MODE", "");
    const stubbed = process.env.DSH_BETTER_EDIT_SPAN_MODE;
    if (stubbed === "") delete process.env.DSH_BETTER_EDIT_SPAN_MODE;
    _resetConfigCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    _resetConfigCache();
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("defaults to hint with no file and no env", () => {
    expect(loadConfig().spanMode).toBe("hint");
  });

  it("leaf resolver parses, rejects and pins constants", () => {
    expect(parseSpanMode(" strict ")).toBe("strict");
    expect(parseSpanMode("hint")).toBe("hint");
    expect(parseSpanMode("")).toBeUndefined();
    expect(parseSpanMode(undefined)).toBeUndefined();
    expect(isSpanMode("STRICT")).toBe(false);
    expect(isSpanMode("maybe")).toBe(false);
    expect(isSpanMode("")).toBe(false);
    expect(isSpanMode(undefined)).toBe(false);
    expect(SPAN_MODE_ENV_VAR).toBe("DSH_BETTER_EDIT_SPAN_MODE");
    expect(SPAN_MODE_DEFAULT).toBe("hint");
  });

  it("reads spanMode from yaml", async () => {
    await writeCfg("spanMode: strict\n");
    expect(loadConfig().spanMode).toBe("strict");
  });

  it("env overrides yaml and is trimmed", async () => {
    await writeCfg("spanMode: hint\n");
    process.env.DSH_BETTER_EDIT_SPAN_MODE = " strict ";
    expect(loadConfig().spanMode).toBe("strict");
  });

  it("invalid env falls through to yaml with one warn", async () => {
    await writeCfg("spanMode: strict\n");
    process.env.DSH_BETTER_EDIT_SPAN_MODE = "STRICT";
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig().spanMode).toBe("strict");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("invalid env with no yaml falls back to hint with one warn", () => {
    process.env.DSH_BETTER_EDIT_SPAN_MODE = "maybe";
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig().spanMode).toBe("hint");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("invalid yaml spanMode falls back to hint with one warn", async () => {
    await writeCfg("spanMode: maybe\n");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig().spanMode).toBe("hint");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("env participates in the cache key", () => {
    expect(loadConfig().spanMode).toBe("hint");
    process.env.DSH_BETTER_EDIT_SPAN_MODE = "strict";
    expect(loadConfig().spanMode).toBe("strict");
    process.env.DSH_BETTER_EDIT_SPAN_MODE = "hint";
    expect(loadConfig().spanMode).toBe("hint");
  });

  it("cache reset restores the default after env removal", () => {
    process.env.DSH_BETTER_EDIT_SPAN_MODE = "strict";
    expect(loadConfig().spanMode).toBe("strict");
    delete process.env.DSH_BETTER_EDIT_SPAN_MODE;
    _resetConfigCache();
    expect(loadConfig().spanMode).toBe("hint");
  });

  it("default yaml template documents spanMode", () => {
    expect(DEFAULT_CONFIG_YAML).toContain("spanMode: hint");
  });

  it("complement appends spanMode when absent", async () => {
    await writeCfg("storeDir: central\n");
    loadConfig();
    const after = await readFile(join(cfgDir(), "config.yaml"), "utf-8");
    expect(after).toContain("spanMode: hint");
  });
});
