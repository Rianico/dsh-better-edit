/**
 * The undecorated `str_replace_editor` — an import guard for a registration decision.
 *
 * `src/index.ts` registers that tool without the agent-store wrapper because its body never
 * resolves or opens the store. The property is invisible at the call site, so it is pinned here as
 * the module's import set: a store touch in the body fails this guard and the registration must be
 * decorated instead. The `tool-read.ts` contrast keeps the ban non-vacuous.
 *
 * Ref: docs/adr/0057-session-scoped-per-workspace-store-lifecycle.md
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(import.meta.dirname, "..", "..", "src");
/** A specifier that reaches the store: the handle, the served rows, the scope, the wrapper, the read seam. */
const STORE_MODULE =
  /(?:^|\/)(?:hash-store|session-view|store-lifecycle-slot|agent-store|read-and-serve)(?:\.js)?$/;

/** Every static `from "…"` specifier in the file (multi-line import clauses included). */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/\bfrom\s+"([^"]+)"/g)) specifiers.push(match[1]!);
  return specifiers;
}

function storeImportsOf(file: string): string[] {
  return importSpecifiers(readFileSync(join(SRC_ROOT, file), "utf8")).filter((specifier) =>
    STORE_MODULE.test(specifier),
  );
}

describe("undeclared store users (undecorated registrations)", () => {
  it("keeps every store module out of `str_replace_editor`", () => {
    expect(storeImportsOf("tool-str-replace-editor.ts")).toEqual([]);
  });

  it("the file exists, carries a body, and really has imports", () => {
    const file = join(SRC_ROOT, "tool-str-replace-editor.ts");
    expect(existsSync(file)).toBe(true);
    const source = readFileSync(file, "utf8");
    expect(source.trim().length).toBeGreaterThan(0);
    expect(source.split("\n").some((line) => /\bfrom\s+"/.test(line))).toBe(true);
  });

  it("the decorated contrast still imports a store module", () => {
    expect(storeImportsOf("tool-read.ts")).not.toEqual([]);
  });
});
