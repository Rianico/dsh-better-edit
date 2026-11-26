import { defineConfig } from "vitest/config";

/**
 * Isolate `$DSH_HOME` before any test module loads. `test/setup/isolate-dsh-home.ts` owns the
 * seam and records why it must run first (#194).
 */
export default defineConfig({
  test: {
    setupFiles: ["./test/setup/isolate-dsh-home.ts"],
  },
});
