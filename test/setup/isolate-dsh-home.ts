import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DSH_HOME?.trim()) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-test-home-"));
}
