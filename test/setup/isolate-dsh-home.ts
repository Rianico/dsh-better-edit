/**
 * Point `$DSH_HOME` at a throwaway directory before any test module loads (#194).
 *
 * WHY: `loadHashStore()` in tests that skip the `test/support/fixtures.ts` helpers resolves the
 * operator's live store (`$DSH_HOME/plugins/dsh-better-edit`, else `~/.dsh`). A store written by a
 * newer installed build then refuses with `E_STORE_NEWER_VERSION`, so a local suite — and therefore
 * `pnpm publish`, whose `prepublishOnly` runs it — depended on machine state. Isolating at the
 * process boundary keeps the suite read-only against user data and reproducible on any machine.
 *
 * One directory per worker process: the first setup run creates it, later test files in the same
 * worker reuse it. A caller-supplied `$DSH_HOME` wins (CI's windows-smoke job and any shell that
 * already isolated its home). Temp directories are left to the OS reaper: the store may still hold
 * the file open at process exit, and unlinking an open SQLite file is the EBUSY class #140 fixed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DSH_HOME?.trim()) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-test-home-"));
}
