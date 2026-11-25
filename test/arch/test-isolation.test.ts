import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { describe, expect, it } from "vitest";

/**
 * Guard for #194 — the suite must never resolve the operator's live harness home.
 *
 * `test/setup/isolate-dsh-home.ts` points `$DSH_HOME` at a throwaway directory for every test
 * process, so tests that call `loadHashStore()` cannot read or write a store an installed build
 * left behind (a newer schema refuses with `E_STORE_NEWER_VERSION`, which once blocked
 * `pnpm publish` through `prepublishOnly`). This test fails if that isolation disappears: the
 * resolved home must sit inside the OS temp root and must not be the operator's `~/.dsh`.
 */
describe("test isolation — $DSH_HOME", () => {
  it("resolves the harness home inside the OS temp root", () => {
    const resolved = resolveDshHome();
    const fromTempRoot = relative(tmpdir(), resolved);

    expect(process.env.DSH_HOME?.trim()).toBeTruthy();
    expect(isAbsolute(resolved)).toBe(true);
    expect(isAbsolute(fromTempRoot) || fromTempRoot.startsWith("..")).toBe(false);
  });

  it("never resolves to the operator's live ~/.dsh", () => {
    expect(resolveDshHome()).not.toBe(join(homedir(), ".dsh"));
  });

  it("resolves once per process, so every test file in a worker shares the store", () => {
    expect(resolveDshHome()).toBe(resolveDshHome());
  });
});
