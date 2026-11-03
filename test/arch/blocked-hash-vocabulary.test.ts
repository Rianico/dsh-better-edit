import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR-0028 vocabulary pin — the freed-hash concept has exactly one downstream name.
 *
 * Downstream names the concept `retired` (`retired anchor` for the hash, `retirement` for the
 * cause; ADR-0013, GLOSSARY). `tombstone` is the legacy term the glossary tells readers to avoid,
 * and `blockedHashes` is upstream's name for the same concept (pi-better-edit@8ad9a51). Neither may
 * appear in `src/`: upstream's end state after `3e1f6dc` is a cause vocabulary with no
 * tombstone/blocked-hash member, and downstream reaches that same end state by deleting the dead
 * `"tombstone"` RangeCause member rather than renaming it.
 *
 * This is the refutable half of the ADR: re-introducing either word fails here, and the ADR must be
 * amended deliberately instead.
 */

const SRC_ROOT = join(import.meta.dirname, "..", "..", "src");
const LEGACY_TERM = /\btombstone/i;
const UPSTREAM_TERM = /\bblocked[-_ ]?hashes?\b/i;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

async function offenders(pattern: RegExp): Promise<string[]> {
  const found: string[] = [];
  for (const file of await sourceFiles(SRC_ROOT)) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line))
        found.push(`${file.slice(SRC_ROOT.length + 1)}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe("blocked-hash vocabulary (ADR-0028)", () => {
  it("keeps the legacy `tombstone` term out of src/", async () => {
    expect(await offenders(LEGACY_TERM)).toEqual([]);
  });

  it("keeps upstream's `blockedHashes` name out of src/", async () => {
    expect(await offenders(UPSTREAM_TERM)).toEqual([]);
  });
});
