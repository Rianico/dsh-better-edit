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
      expect(configDir()).toBe(
        join("/custom/dsh", "plugins", "dsh-better-edit"),
      );
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
  async function withCleanEnv(
    env: Record<string, string | undefined>,
    fn: () => Promise<void> | void,
  ): Promise<void> {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const { _resetConfigCache } = await import("../../src/paths.js");
    _resetConfigCache();
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      const { _resetConfigCache: r } = await import("../../src/paths.js");
      r();
    }
  }

  it("defaults to central runtime/<name>-<hash8> when cwd given", async () => {
    await withCleanEnv(
      {
        DSH_BETTER_EDIT_STORE_DIR: undefined,
        DSH_BETTER_EDIT_AUTO_GITIGNORE: undefined,
        DSH_HOME: "/tmp/dsh-home-test",
      },
      async () => {
        const { configDir } = await import("../../src/paths.js");
        const dir = configDir("/ws/my-app");
        expect(
          dir.startsWith(
            join(
              "/tmp/dsh-home-test",
              "plugins",
              "dsh-better-edit",
              "runtime",
              "my-app-",
            ),
          ),
        ).toBe(true);
        expect(dir.slice(-8)).toMatch(/^[0-9a-f]{8}$/);
      },
    );
  });

  it("env workspace overrides to legacy .dsh_better_edit", async () => {
    await withCleanEnv({ DSH_BETTER_EDIT_STORE_DIR: "workspace" }, async () => {
      const { configDir } = await import("../../src/paths.js");
      expect(configDir("/ws/my-app")).toBe(
        join("/ws/my-app", ".dsh_better_edit"),
      );
    });
  });

  it("env custom abs path uses hash suffix", async () => {
    await withCleanEnv(
      { DSH_BETTER_EDIT_STORE_DIR: "/custom/store" },
      async () => {
        const { configDir } = await import("../../src/paths.js");
        const dir = configDir("/ws/my-app");
        expect(dir.startsWith("/custom/store/")).toBe(true);
        expect(dir.slice(-8)).toMatch(/^[0-9a-f]{8}$/);
      },
    );
  });

  it("malformed storeDir falls back to central with warn", async () => {
    await withCleanEnv(
      {
        DSH_HOME: "/tmp/dsh-home-test-malformed",
        DSH_BETTER_EDIT_STORE_DIR: "./relative",
      },
      async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const { configDir } = await import("../../src/paths.js");
          const dir = configDir("/ws/my-app");
          expect(dir).toContain("runtime");
          expect(warn).toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      },
    );
  });

  it("DSH_BETTER_EDIT_AUTO_GITIGNORE true|false case-insensitive", async () => {
    await withCleanEnv({ DSH_BETTER_EDIT_AUTO_GITIGNORE: "TRUE" }, async () => {
      const { loadConfig } = await import("../../src/paths.js");
      expect(loadConfig().autoGitignore).toBe(true);
    });
    await withCleanEnv(
      { DSH_BETTER_EDIT_AUTO_GITIGNORE: "False" },
      async () => {
        const { loadConfig } = await import("../../src/paths.js");
        expect(loadConfig().autoGitignore).toBe(false);
      },
    );
  });
});
