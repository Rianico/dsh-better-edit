import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Isolate `$DSH_HOME` before any test module loads. See test/setup/isolate-dsh-home.ts (#194).
    setupFiles: ["./test/setup/isolate-dsh-home.ts"],
  },
});
