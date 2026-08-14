import { describe, expect, it } from "vitest";
import * as os from "node:os";
import { resolve } from "node:path";
import { toCwd } from "../../src/paths.js";

describe("toCwd", () => {
  const cwd = "/home/user/project";

  it("resolves a relative path against cwd", () => {
    expect(toCwd("src/main.ts", cwd)).toBe(
      resolve(cwd, "src/main.ts"),
    );
  });

  it("returns absolute paths unchanged", () => {
    expect(toCwd("/etc/hosts", cwd)).toBe("/etc/hosts");
  });

  it("expands ~ to home directory", () => {
    expect(toCwd("~/file.txt", cwd)).toBe(
      os.homedir() + "/file.txt",
    );
  });

  it("expands bare ~ to home directory", () => {
    expect(toCwd("~", cwd)).toBe(os.homedir());
  });

  it("preserves a leading @ in relative paths", () => {
    expect(toCwd("@src/main.ts", cwd)).toBe(
      resolve(cwd, "@src/main.ts"),
    );
  });

  it("preserves unicode spaces in file names", () => {
    expect(toCwd("src/my\u00A0file.ts", cwd)).toBe(
      resolve(cwd, "src/my\u00A0file.ts"),
    );
  });

  it("does not treat @~ as home-directory expansion", () => {
    expect(toCwd("@~/notes.md", cwd)).toBe(
      resolve(cwd, "@~/notes.md"),
    );
  });
});
