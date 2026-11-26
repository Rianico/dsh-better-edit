import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_REGISTRY, formatError } from "../../src/domain-errors.js";
import { DEFAULT_CONFIG_YAML } from "../../src/store-config.js";

/**
 * #210 pin — the `[E_ENCODING_UNWRITABLE]` refusal names the consent surface, not the caller's
 * environment.
 *
 * The retired wording told the model to "Set normalizeToUtf8: true
 * (DSH_BETTER_EDIT_NORMALIZE_TO_UTF8=true)". `normalizeToUtf8` reads like a payload key but is a
 * config-only spelling the caller cannot send on an `edit`, and the parenthesised env var is a
 * host detail no tool-argument surface accepts. The shipped text names what a caller can actually
 * do: the per-call `allow_encoding_migration` value (`"utf8"` / `"utf8bom"`), the standing
 * `allowEncodingMigration` setting (its location, `$DSH_HOME/plugins/dsh-better-edit/config.yaml`,
 * is named too so the standing route is actionable — #180 §3), or a re-encode outside the plugin.
 */

const ROOT = join(import.meta.dirname, "..", "..");
/** The standing consent route lives here; naming it stops the caller guessing (#180 §3). */
const CONFIG_PATH = "$DSH_HOME/plugins/dsh-better-edit/config.yaml";

const message = formatError("E_ENCODING_UNWRITABLE", {
  path: "legacy.txt",
  encoding: "utf16le",
});
const remedy = ERROR_REGISTRY.E_ENCODING_UNWRITABLE.remedy ?? "";

/** Shell, command-line and OS tokens: a remedy may not name the caller's host to act on. */
const ENVIRONMENT_TOKENS = [
  "bash",
  "zsh",
  "shell",
  "powershell",
  "pwsh",
  "cmd",
  "command line",
  "terminal",
  "windows",
  "linux",
  "macos",
  "darwin",
  "win32",
  "unix",
  "get-content",
  "out-file",
  "export-clixml",
  "iconv",
  "sed",
  "awk",
  "chmod",
] as const;

/** Whole-word match, so `cmd` does not fire inside a longer identifier and `sed` not inside a word. */
function namesCallerEnvironment(text: string): string[] {
  const haystack = text.toLowerCase();
  return ENVIRONMENT_TOKENS.filter((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`).test(haystack);
  });
}

/**
 * The retired remedy named `normalizeToUtf8` as if it were a payload key. It stays a legitimate
 * legacy config spelling (#209 keeps honouring it), but it may not be offered as the action.
 */
function namesRetiredSpelling(text: string): boolean {
  return text.includes("normalizeToUtf8");
}

function linesOf(text: string): string[] {
  return text.split("\n");
}

describe("the encoding refusal names the consent surface, not the caller environment", () => {
  it("states the seam fact, that nothing was written, and both consent routes", () => {
    expect(message).toContain("[E_ENCODING_UNWRITABLE]");
    expect(message).toContain("Nothing was written");
    expect(message).toContain("text write that always encodes UTF-8");
    expect(message).toContain("allow_encoding_migration");
    expect(message).toContain('"utf8"');
    expect(message).toContain('"utf8bom"');
    expect(message).toContain("allowEncodingMigration");
    expect(message).toContain(CONFIG_PATH);
    expect(message).toContain("outside the plugin");
    expect(message).not.toContain("normalizeToUtf8");
  });

  it("names no shell, command-line or OS token in the message", () => {
    expect(namesCallerEnvironment(message)).toEqual([]);
  });

  it("names no shell, command-line or OS token in the remedy", () => {
    expect(namesCallerEnvironment(remedy)).toEqual([]);
  });

  it("control: the environment guard fires on PowerShell and on a bare bash command", () => {
    expect(namesCallerEnvironment("Run it in PowerShell: Out-File legacy.txt")).toContain(
      "powershell",
    );
    expect(namesCallerEnvironment("then run sed -i s/a/b/ legacy.txt")).toContain("sed");
    expect(namesCallerEnvironment("nothing host-specific here")).toEqual([]);
  });

  it("control: the retired-spelling guard fires on the retired refusal text", () => {
    expect(
      namesRetiredSpelling("Set normalizeToUtf8: true (DSH_BETTER_EDIT_NORMALIZE_TO_UTF8=true)"),
    ).toBe(true);
    expect(namesRetiredSpelling(message)).toBe(false);
    expect(namesRetiredSpelling(remedy)).toBe(false);
  });

  it("renders a one-sentence remedy that names both consent routes", () => {
    expect(remedy).not.toContain("\n");
    expect(remedy.trim().endsWith(".")).toBe(true);
    expect(remedy).toContain("allow_encoding_migration");
    expect(remedy).toContain("allowEncodingMigration");
    expect(remedy).toContain(CONFIG_PATH);
    expect(remedy).toContain('"utf8"');
    expect(remedy).toContain('"utf8bom"');
    expect(remedy).toContain("outside the plugin");
    expect(remedy).not.toContain("normalizeToUtf8");
  });
});

describe("the docs name the payload surface and the config surface distinctly", () => {
  const DOCS = [
    { file: "README.md", paragraphPrefix: "**File encoding**" },
    { file: "README.zh.md", paragraphPrefix: "**文件编码。**" },
  ] as const;

  for (const { file, paragraphPrefix } of DOCS) {
    it(`${file} states the payload value and the config setting in the refusal table row`, async () => {
      const lines = linesOf(await readFile(join(ROOT, file), "utf8"));
      const rows = lines.filter((line) => /^\|\s*`\[E_ENCODING_UNWRITABLE\]`/.test(line));
      expect(rows).toHaveLength(1);
      const row = rows[0] ?? "";
      expect(row).toContain("allow_encoding_migration");
      expect(row).toContain("allowEncodingMigration");
      expect(row).toContain(CONFIG_PATH);
      expect(row).not.toContain("normalizeToUtf8");
    });

    it(`${file} documents the consent ladder in the encoding paragraph`, async () => {
      const lines = linesOf(await readFile(join(ROOT, file), "utf8"));
      const paragraphs = lines.filter((line) => line.startsWith(paragraphPrefix));
      expect(paragraphs).toHaveLength(1);
      const paragraph = paragraphs[0] ?? "";
      expect(paragraph).toContain("allow_encoding_migration");
      expect(paragraph).toContain("allowEncodingMigration");
      expect(paragraph).toContain(CONFIG_PATH);
      expect(paragraph).toContain("normalizeToUtf8");
      expect(paragraph).toContain('"utf8"');
      expect(paragraph).toContain('"utf8bom"');
    });
  }

  it("GLOSSARY.md carries the `encoding migration consent` entry with both surfaces", async () => {
    const text = await readFile(join(ROOT, "GLOSSARY.md"), "utf8");
    const heading = /^\*\*encoding migration consent\*\*:/m.exec(text);
    expect(heading).not.toBeNull();
    const start = heading?.index ?? 0;
    const rest = text.slice(start);
    const end = rest.indexOf("\n\n**");
    const entry = end === -1 ? rest.slice(0, 2000) : rest.slice(0, Math.min(end, 2000));
    expect(entry).toContain("allow_encoding_migration");
    expect(entry).toContain("allowEncodingMigration");
  });

  it("the generated config template documents the consent beside the legacy spelling", () => {
    expect(DEFAULT_CONFIG_YAML).toContain("# allowEncodingMigration: refuse");
    const lines = linesOf(DEFAULT_CONFIG_YAML);
    const legacyLine = lines.findIndex((line) => line.trim() === "normalizeToUtf8: false");
    expect(legacyLine).toBeGreaterThan(-1);
    const commentsAbove: string[] = [];
    for (let index = legacyLine - 1; index >= 0 && lines[index]?.startsWith("#"); index -= 1) {
      commentsAbove.push(lines[index] ?? "");
    }
    expect(commentsAbove.join("\n")).toMatch(/legacy/i);
  });
});
