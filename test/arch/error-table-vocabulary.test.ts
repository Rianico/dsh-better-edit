import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_REGISTRY } from "../../src/domain-errors.js";

/**
 * #124 pin — the README error tables mirror the live vocabulary.
 *
 * Both READMEs list the codes a model can see. They drifted twice: `README.md` was
 * missing 16 of the 29 model-facing codes (including `E_ENCODING_UNWRITABLE`), and
 * `README.zh.md` still listed 14 pre-rename names that `src/` no longer produces.
 *
 * This test is the refutable half of the fix: the docs name every `audience: "MODEL"`
 * code and no other `E_*` token. Adding a code without documenting it, or leaving a
 * retired name in the docs, fails here.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const DOCS = ["README.md", "README.zh.md"] as const;

const MODEL_CODES = Object.entries(ERROR_REGISTRY)
  .filter(([, spec]) => spec.audience === "MODEL")
  .map(([code]) => code)
  .sort();

async function codesNamedIn(file: string): Promise<string[]> {
  const text = await readFile(join(ROOT, file), "utf8");
  return [...new Set(text.match(/\bE_[A-Z][A-Z0-9_]*\b/g) ?? [])].sort();
}

describe("README error vocabulary mirrors ERROR_REGISTRY", () => {
  for (const file of DOCS) {
    it(`${file} names every model-facing code`, async () => {
      const named = await codesNamedIn(file);
      expect(MODEL_CODES.filter((code) => !named.includes(code))).toEqual([]);
    });

    it(`${file} names no retired code`, async () => {
      const named = await codesNamedIn(file);
      expect(named.filter((code) => !MODEL_CODES.includes(code))).toEqual([]);
    });
  }
});
