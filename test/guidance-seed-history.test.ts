import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { KNOWN_HISTORICAL_SEEDS } from "../src/guidance/seed-history.js";
import { seedHash } from "../src/guidance/seed.js";

const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/guidance-seeds/", import.meta.url));

const PRESETS = ["standard", "ptc", "minimal", "cordis"] as const;

type SeededFileName = "read.md" | "edit.md" | "undo_last_edit.md";

const FILES: readonly SeededFileName[] = ["read.md", "edit.md", "undo_last_edit.md"];

const EXPECTED_DISTINCT_PER_FILE: Readonly<Record<SeededFileName, number>> = {
  "read.md": 4,
  "edit.md": 8,
  "undo_last_edit.md": 4,
};

interface Fixture {
  /** Section file name the fixture stands for. */
  readonly file: SeededFileName;
  /** Absolute path, used to name drift in failure messages. */
  readonly path: string;
  /** `seedHash` of the fixture's on-disk bytes. */
  readonly hash: string;
}
function isSeededFileName(name: string): name is SeededFileName {
  return (FILES as readonly string[]).includes(name);
}

/** Walk `guidance-seeds/<tag>/<file>` two levels deep, refusing any other shape. */
function collectFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const tag of readdirSync(FIXTURE_ROOT).sort()) {
    const tagDir = join(FIXTURE_ROOT, tag);
    if (!statSync(tagDir).isDirectory()) {
      throw new Error(`unexpected non-directory entry in fixture root: ${tagDir}`);
    }
    for (const name of readdirSync(tagDir).sort()) {
      const path = join(tagDir, name);
      if (!statSync(path).isFile() || !isSeededFileName(name)) {
        throw new Error(
          `unexpected fixture entry (want <tag>/<read.md|edit.md|undo_last_edit.md>): ${path}`,
        );
      }
      fixtures.push({ file: name, path, hash: seedHash(readFileSync(path, "utf8")) });
    }
  }
  return fixtures;
}

const FIXTURES = collectFixtures();

/** Every hash in the ledger, deduplicated across keys. */
const LEDGER_HASHES = new Set(Object.values(KNOWN_HISTORICAL_SEEDS).flat());

function ledgerFor(preset: (typeof PRESETS)[number], file: SeededFileName): readonly string[] {
  return KNOWN_HISTORICAL_SEEDS[`${preset}/${file}`];
}

describe("guidance seed history — fixtures", () => {
  it("ships exactly 16 fixtures", () => {
    expect(FIXTURES.length).toBe(16);
  });

  it("has no duplicate (tag, file) fixture and exactly 16 distinct hashes", () => {
    const paths = FIXTURES.map((fixture) => fixture.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(FIXTURES.map((fixture) => fixture.hash)).size).toBe(16);
  });

  it("has the expected distinct count per file", () => {
    for (const file of FILES) {
      const hashes = new Set(
        FIXTURES.filter((fixture) => fixture.file === file).map((fixture) => fixture.hash),
      );
      expect(hashes.size, `${file} distinct fixture hashes`).toBe(EXPECTED_DISTINCT_PER_FILE[file]);
    }
  });
});

describe("guidance seed history — ledger", () => {
  it("keys all 4 presets x 3 section files", () => {
    expect(Object.keys(KNOWN_HISTORICAL_SEEDS).sort()).toEqual(
      PRESETS.flatMap((preset) => FILES.map((file) => `${preset}/${file}`)).sort(),
    );
  });

  it("holds exactly 16 distinct hashes", () => {
    expect(LEDGER_HASHES.size).toBe(16);
  });

  it("backs every ledger hash with a fixture (no orphan ledger entries)", () => {
    const fixtureHashes = new Set(FIXTURES.map((fixture) => fixture.hash));
    for (const [key, hashes] of Object.entries(KNOWN_HISTORICAL_SEEDS)) {
      for (const hash of hashes) {
        expect(fixtureHashes.has(hash), `${key}: ledger hash ${hash} has no fixture`).toBe(true);
      }
    }
  });

  it("includes every fixture hash in every preset's array for that file", () => {
    for (const fixture of FIXTURES) {
      for (const preset of PRESETS) {
        expect(
          ledgerFor(preset, fixture.file),
          `${fixture.path} is missing from ${preset}/${fixture.file}`,
        ).toContain(fixture.hash);
      }
    }
  });

  it("keeps each file's history identical across the four presets", () => {
    for (const file of FILES) {
      for (const preset of PRESETS) {
        expect(ledgerFor(preset, file), `${preset}/${file} must match standard/${file}`).toEqual(
          ledgerFor("standard", file),
        );
      }
    }
  });
});
