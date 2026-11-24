import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  _resetConfigCache,
  ensureDefaultConfig,
  EOL_DEFAULT,
  EOL_SETTINGS,
  isEolSetting,
  parseEnvEolSetting,
} from "../../src/store-config.js";
import {
  EOL_ENV_VAR,
  countLineEndings,
  dominantEnding,
  endingName,
  changedTerminatorCount,
  terminatorKindsUsed,
  resolveEffectiveEol,
  resolveEffectiveEolFromCounts,
} from "../../src/eol-config.js";

/** The platform terminator a file with no terminator of its own gets. */
const SYSTEM_ENDING = process.platform === "win32" ? "\r\n" : "\n";

const configDir = (home: string): string => join(home, ".dsh", "plugins", "dsh-better-edit");

let tmpHome: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

const envKeys = [
  "DSH_BETTER_EDIT_EOL",
  "DSH_BETTER_EDIT_STORE_DIR",
  "DSH_BETTER_EDIT_AUTO_GUESS_ENCODING",
  "DSH_BETTER_EDIT_NORMALIZE_TO_UTF8",
  "DSH_BETTER_EDIT_SUPPORTED_ENCODINGS",
  "DSH_BETTER_EDIT_AUTO_GITIGNORE",
] as const;

async function writeConfigYaml(yaml: string): Promise<void> {
  const dir = configDir(tmpHome);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.yaml"), yaml, "utf-8");
  _resetConfigCache();
}

async function readConfigYaml(): Promise<string> {
  return readFile(join(configDir(tmpHome), "config.yaml"), "utf-8");
}

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "eolcfg-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
  for (const k of envKeys) vi.stubEnv(k, "");
  for (const k of envKeys) {
    if (process.env[k] === "") delete process.env[k];
  }
  _resetConfigCache();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetConfigCache();
  await rm(tmpHome, { recursive: true, force: true });
});

describe("eol-config — countLineEndings", () => {
  it("counts nothing in an empty string", () => {
    expect(countLineEndings("")).toEqual({ crlf: 0, lf: 0, cr: 0 });
  });

  it("counts a CRLF pair once, never as CR plus LF", () => {
    expect(countLineEndings("one\r\ntwo\r\nthree")).toEqual({ crlf: 2, lf: 0, cr: 0 });
  });

  it("keeps a lone CR and a lone LF apart", () => {
    expect(countLineEndings("a\rb\nc")).toEqual({ crlf: 0, lf: 1, cr: 1 });
  });

  it("counts a trailing CR after a CRLF pair", () => {
    expect(countLineEndings("a\r\n\r")).toEqual({ crlf: 1, lf: 0, cr: 1 });
  });
});

describe("eol-config — dominantEnding tie-breaks", () => {
  it("prefers LF over CRLF at 1/1", () => {
    expect(dominantEnding("a\r\nb\n")).toBe("\n");
  });

  it("prefers CRLF over CR at 1/1", () => {
    expect(dominantEnding("a\r\nb\rc")).toBe("\r\n");
  });

  it("prefers LF over CR at 1/1", () => {
    expect(dominantEnding("a\nb\rc")).toBe("\n");
  });

  it("prefers LF when all three kinds tie", () => {
    expect(dominantEnding("a\r\nb\nc\rd")).toBe("\n");
  });

  it("is undefined with no terminator", () => {
    expect(dominantEnding("single line")).toBeUndefined();
  });
});

describe("eol-config — pure helpers", () => {
  it("spells each terminator the way the setting does", () => {
    expect(endingName("\n")).toBe("LF");
    expect(endingName("\r\n")).toBe("CRLF");
    expect(endingName("\r")).toBe("CR");
  });

  it("counts changed terminators per target", () => {
    const counts = { crlf: 2, lf: 3, cr: 1 };
    expect(changedTerminatorCount(counts, "\r\n")).toBe(4);
    expect(changedTerminatorCount(counts, "\n")).toBe(3);
    expect(changedTerminatorCount(counts, "\r")).toBe(5);
  });

  it("reports zero changed terminators for a uniform file already at the target", () => {
    expect(changedTerminatorCount({ crlf: 0, lf: 3, cr: 0 }, "\n")).toBe(0);
  });

  it("counts the distinct terminator kinds used", () => {
    expect(terminatorKindsUsed({ crlf: 0, lf: 0, cr: 0 })).toBe(0);
    expect(terminatorKindsUsed({ crlf: 0, lf: 4, cr: 0 })).toBe(1);
    expect(terminatorKindsUsed({ crlf: 2, lf: 0, cr: 1 })).toBe(2);
    expect(terminatorKindsUsed({ crlf: 1, lf: 1, cr: 1 })).toBe(3);
  });
});

describe("eol-config — AUTO keeps the file's own terminator", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("keeps a uniform %s file at %j with source file", (_name, ending) => {
    expect(resolveEffectiveEol(`one${ending}two${ending}`)).toEqual({
      value: ending,
      source: "file",
    });
  });

  it("derives the same answer from explicit counts", () => {
    expect(resolveEffectiveEolFromCounts({ crlf: 2, lf: 0, cr: 0 })).toEqual({
      value: "\r\n",
      source: "file",
    });
  });
});

describe("eol-config — system rung", () => {
  it("falls back to the platform terminator when the file has none", () => {
    expect(resolveEffectiveEol("single line")).toEqual({
      value: SYSTEM_ENDING,
      source: "system",
    });
  });

  it("derives the system rung from empty counts", () => {
    expect(resolveEffectiveEolFromCounts({ crlf: 0, lf: 0, cr: 0 })).toEqual({
      value: SYSTEM_ENDING,
      source: "system",
    });
  });

  it.skipIf(process.platform === "win32")(
    "uses CRLF on win32 for a file with no terminator",
    () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        expect(resolveEffectiveEol("single line")).toEqual({
          value: "\r\n",
          source: "system",
        });
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    },
  );
});

describe("eol-config — forced env setting", () => {
  it("wins over the file with source env", () => {
    vi.stubEnv(EOL_ENV_VAR, "CRLF");
    expect(resolveEffectiveEol("a\nb\n")).toEqual({ value: "\r\n", source: "env" });
  });

  it("is trimmed and upper-cased", () => {
    vi.stubEnv(EOL_ENV_VAR, "  crlf  ");
    expect(resolveEffectiveEol("a\nb\n")).toEqual({ value: "\r\n", source: "env" });
  });

  it("wins over config and file", () => {
    vi.stubEnv(EOL_ENV_VAR, "CR");
    return writeConfigYaml("eol: LF\n").then(() => {
      expect(resolveEffectiveEol("a\nb\n")).toEqual({ value: "\r", source: "env" });
    });
  });

  it("stops the ladder at AUTO so config cannot override the file", () => {
    vi.stubEnv(EOL_ENV_VAR, "AUTO");
    return writeConfigYaml("eol: LF\n").then(() => {
      expect(resolveEffectiveEol("a\r\nb\r\n")).toEqual({
        value: "\r\n",
        source: "file",
      });
    });
  });
});

describe("eol-config — forced config setting", () => {
  it("wins over the file with source config", () => {
    return writeConfigYaml("eol: CRLF\n").then(() => {
      expect(resolveEffectiveEol("a\nb\n")).toEqual({ value: "\r\n", source: "config" });
    });
  });

  it("leaves the file rung when AUTO", () => {
    return writeConfigYaml("eol: AUTO\n").then(() => {
      expect(resolveEffectiveEol("a\r\nb\r\n")).toEqual({
        value: "\r\n",
        source: "file",
      });
    });
  });

  it("rejects a lowercase file value and falls through to the file rung", () => {
    return writeConfigYaml("eol: crlf\n").then(() => {
      expect(resolveEffectiveEol("a\nb\n")).toEqual({ value: "\n", source: "file" });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('eol "crlf" invalid'));
    });
  });
});

describe("eol-config — precedence env over config", () => {
  it("resolves CRLF/env from config LF plus env CRLF on mixed content", () => {
    vi.stubEnv(EOL_ENV_VAR, "CRLF");
    return writeConfigYaml("eol: LF\n").then(() => {
      expect(resolveEffectiveEol("a\nb\r\nc")).toEqual({ value: "\r\n", source: "env" });
    });
  });
});

describe("eol-config — invalid env value", () => {
  it("warns and falls through to config without throwing", () => {
    vi.stubEnv(EOL_ENV_VAR, "bogus");
    return writeConfigYaml("eol: LF\n").then(() => {
      expect(() => resolveEffectiveEol("a\r\nb\r\n")).not.toThrow();
      expect(resolveEffectiveEol("a\r\nb\r\n")).toEqual({ value: "\n", source: "config" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`DSH_BETTER_EDIT_EOL "bogus" invalid`),
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(resolveEffectiveEol("a\r\nb\r\n")).toEqual({ value: "\n", source: "config" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("falls through to the file rung when no config forces a value", () => {
    vi.stubEnv(EOL_ENV_VAR, "LOL");
    expect(resolveEffectiveEol("a\r\nb\r\n")).toEqual({ value: "\r\n", source: "file" });
  });
});

describe("eol-config — malformed config", () => {
  it("warns and falls through to the file rung without throwing", () => {
    return writeConfigYaml("eol: [broken\n").then(() => {
      expect(() => resolveEffectiveEol("a\nb\n")).not.toThrow();
      expect(resolveEffectiveEol("a\nb\n")).toEqual({ value: "\n", source: "file" });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('eol "[broken" invalid'));
    });
  });

  it("warns and keeps the file rung when the config path is unreadable", async () => {
    await writeFile(join(tmpHome, ".dsh"), "not a directory", "utf-8");
    _resetConfigCache();
    expect(() => resolveEffectiveEol("a\r\nb\r\n")).not.toThrow();
    expect(resolveEffectiveEol("a\r\nb\r\n")).toEqual({ value: "\r\n", source: "file" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failed to read config yaml"));
  });
});

describe("store-config — eol setting integration", () => {
  it("exposes the AUTO default vocabulary", () => {
    expect(EOL_SETTINGS).toEqual(["AUTO", "LF", "CRLF", "CR"]);
    expect(EOL_DEFAULT).toBe("AUTO");
    expect(loadConfig().eol).toBe("AUTO");
  });

  it("guards the enum and parses env spellings", () => {
    expect(isEolSetting("LF")).toBe(true);
    expect(isEolSetting("lf")).toBe(false);
    expect(isEolSetting(1)).toBe(false);
    expect(parseEnvEolSetting(" crlf ")).toBe("CRLF");
    expect(parseEnvEolSetting("bogus")).toBeUndefined();
    expect(parseEnvEolSetting(undefined)).toBeUndefined();
    expect(parseEnvEolSetting("")).toBeUndefined();
  });

  it("writes eol: AUTO into the generated default config", async () => {
    await ensureDefaultConfig();
    expect(await readConfigYaml()).toContain("eol: AUTO");
  });

  it("complements a minimal config with eol: AUTO", async () => {
    await writeConfigYaml("storeDir: central\n");
    expect(loadConfig().eol).toBe("AUTO");
    expect(await readConfigYaml()).toContain("eol: AUTO");
  });

  it("reflects the env override and invalidates the cache when it changes or clears", () => {
    vi.stubEnv(EOL_ENV_VAR, "CRLF");
    expect(loadConfig().eol).toBe("CRLF");

    vi.stubEnv(EOL_ENV_VAR, "LF");
    expect(loadConfig().eol).toBe("LF");

    delete process.env[EOL_ENV_VAR];
    expect(loadConfig().eol).toBe("AUTO");
  });
});
