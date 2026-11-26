/**
 * The undecorated `str_replace_editor` — an import guard for a registration decision.
 *
 * `src/index.ts` registers `str_replace_editor` WITHOUT the agent-store wrapper, because every
 * decoration costs a path resolution, and in central/custom mode that resolution creates the runtime
 * directory and writes the `.wsPath` sidecar. The reason it may skip the wrapper is a property of the
 * BODY: it never resolves or opens the store, so no scope and no attach is owed for the call.
 *
 * That property is invisible at the call site, so it is pinned here as the module's import set: a body
 * that never imports `hash-store`, `session-view`, `store-lifecycle-slot`, `agent-store` or
 * `read-and-serve` cannot open the store, resolve its path, or enter a scope. If a future edit gives
 * this tool a store touch, this guard fires and the registration must be decorated (or the import
 * redirected through a seam), rather than the tool quietly running unscoped.
 *
 * The positive half matters: a deleted or emptied file would satisfy the ban vacuously, and
 * `src/tool-read.ts` is the contrast that keeps the pattern meaningful — it DOES import a store
 * module (`read-and-serve`), which is why `read` is registered decorated.
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
    // Without this hair, the ban above would pass on a file whose imports were all stripped
    // (or on a rename that left a stub): `importSpecifiers` would simply return nothing to filter.
    expect(source.split("\n").some((line) => /\bfrom\s+"/.test(line))).toBe(true);
  });

  it("the decorated contrast still imports a store module", () => {
    // `read` is registered WITH the wrapper; if this list ever emptied, the guard above would be
    // describing a module tree that no longer has store-importing tools at all.
    expect(storeImportsOf("tool-read.ts")).not.toEqual([]);
  });
});
