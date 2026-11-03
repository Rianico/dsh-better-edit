import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Install-surface manifest pin — the applicable slice of pi-better-edit@b0a3e30 (#101).
 *
 * Upstream ships an esbuild bundle as the extension entry because its host transpiles TypeScript
 * on every session start; that whole pipeline (build script, freshness/mutation guards, esbuild
 * dependency, import-ratio gate, CI matrix) is DECLINED here, because a dsh plugin's entry is the
 * tsc-built `lib/` and the bundle patch rides `cordis.patch.yml`.
 *
 * What survives is the manifest contract both install surfaces depend on, expressed for this
 * package: the entry is ONE built artifact reachable through both `main` and `exports`, the tarball
 * ships it together with the declared bundle patch, and neither `prepare` nor `prepublishOnly` may
 * swallow a failed build. A manifest alone cannot keep those true — this can.
 */

const ROOT = join(import.meta.dirname, "..", "..");

type Manifest = {
  main?: string;
  exports?: Record<string, { default?: string } | string>;
  files?: string[];
  scripts?: Record<string, string>;
  dsh?: { bundle?: { patch?: string } };
};

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Manifest;

function exportEntry(): string | undefined {
  const root = pkg.exports?.["."];
  return typeof root === "string" ? root : root?.default;
}

/** Both fields spell the same file; `exports` conventionally carries the `./` prefix. */
function sameEntry(a: string | undefined, b: string | undefined): boolean {
  const norm = (value: string | undefined): string | undefined => value?.replace(/^\.\//, "");
  return norm(a) === norm(b);
}

describe("install surface (manifest)", () => {
  it("names the same single built entry through main and exports", () => {
    const entry = exportEntry();
    expect(entry).toBeDefined();
    expect(sameEntry(pkg.main, entry), "main and exports must name one entry").toBe(true);
    // The entry is the tsc output, never TypeScript source (upstream's artifact rule, adapted).
    expect(pkg.main?.endsWith(".ts"), "main must point at built JS, not source").toBe(false);
    expect(pkg.main?.startsWith("lib/"), "main must live under the built lib/ tree").toBe(true);
  });

  it("ships the entry and the declared bundle patch in the tarball", () => {
    const patch = pkg.dsh?.bundle?.patch;
    expect(patch).toBeDefined();
    const shipped = pkg.files ?? [];
    expect(shipped).toContain("lib");
    expect(shipped).toContain(patch?.replace(/^\.\//, ""));
    // The declared patch must exist on disk: a `dsh.bundle.patch` that dangles makes the
    // plugin surface unresolvable after install.
    expect(existsSync(join(ROOT, patch!))).toBe(true);
  });

  it("cannot swallow a failed build in prepare or prepublishOnly", () => {
    const prepare = pkg.scripts?.prepare ?? "";
    const prepublish = pkg.scripts?.prepublishOnly ?? "";
    expect(prepare).not.toContain("|| true");
    expect(prepare).toContain("tsc");
    expect(prepublish).not.toContain("|| true");
    expect(prepublish).toContain("npm run typecheck");
    expect(prepublish).toContain("npm test");
  });
});
