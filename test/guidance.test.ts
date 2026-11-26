import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getWritableTempRoot } from "./support/fixtures.js";
import {
  DEFAULT_PRESETS,
  GUIDANCE_HOME_README,
  GUIDANCE_HOME_README_ZH,
  GUIDANCE_SECTIONS,
  composeSections,
  ensurePresetGuidance,
  parseSectionFile,
  isBlankOverride,
  isMalformedOverride,
  renderSectionDefault,
  resolveSection,
} from "../src/guidance.js";
import { seedHash } from "../src/guidance/seed.js";
import { EDIT_GUIDANCE, READ_GUIDANCE, UNDO_GUIDANCE } from "../src/prompts.js";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(await getWritableTempRoot(), "dsh-guidance-test-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeSection(
  home: string,
  preset: string,
  file: string,
  content: string,
): Promise<void> {
  const dir = join(home, preset);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content, "utf-8");
}

const SEED_FIXTURES = fileURLToPath(new URL("./fixtures/guidance-seeds/", import.meta.url));

const MANIFEST = ".seeded.json";

interface ParsedManifest {
  version: number;
  files: Record<string, string>;
}

async function readManifest(home: string): Promise<ParsedManifest> {
  const raw = await readFile(join(home, MANIFEST), "utf-8");
  return JSON.parse(raw) as ParsedManifest;
}

async function writeManifest(home: string, files: Record<string, string>): Promise<void> {
  const body = `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
  await writeFile(join(home, MANIFEST), body, "utf-8");
}

async function readFixture(tag: string, file: string): Promise<string> {
  return readFile(join(SEED_FIXTURES, tag, file), "utf-8");
}

const bullets = (lines: readonly string[]) => lines.map((line) => `- ${line}`).join("\n");

/** The two-line divergence notice the resolver appends to a diverged override. */
const DIVERGED_NOTICE = [
  "[USER] [W_PROMPT_DIVERGED]",
  "Local guidance differs from the plugin defaults; follow the local instructions.",
].join("\n");

/** Assert `text` carries the divergence notice at its very end. */
function expectDivergenceNotice(text: string): void {
  expect(text).toContain("[USER] [W_PROMPT_DIVERGED]");
  expect(text).toContain("Local guidance differs");
  expect(text.endsWith(`\n\n${DIVERGED_NOTICE}`)).toBe(true);
}

function requireSection(
  sections: readonly { name: string; order: number; text: string }[],
  name: string,
): { name: string; order: number; text: string } {
  const section = sections.find((candidate) => candidate.name === name);
  if (!section) throw new Error(`section ${name} missing`);
  return section;
}

describe("guidance sections", () => {
  it("exposes the three sections with stable order, file names, and defaults", () => {
    expect(GUIDANCE_SECTIONS.map((s) => s.name)).toEqual([
      "tool:read",
      "tool:edit",
      "tool:undo_last_edit",
    ]);
    expect(GUIDANCE_SECTIONS.map((s) => s.file)).toEqual([
      "read.md",
      "edit.md",
      "undo_last_edit.md",
    ]);
    expect(GUIDANCE_SECTIONS.map((s) => s.defaultOrder)).toEqual([1100, 1300, 1310]);
  });

  it("default render matches today's inline section text", () => {
    expect(renderSectionDefault("tool:read")).toBe(
      [READ_GUIDANCE.intro, "", bullets(READ_GUIDANCE.lines)].join("\n"),
    );
    expect(renderSectionDefault("tool:edit")).toBe(
      [EDIT_GUIDANCE.intro, "", bullets(EDIT_GUIDANCE.lines)].join("\n"),
    );
    expect(renderSectionDefault("tool:undo_last_edit")).toBe(
      [UNDO_GUIDANCE.intro, "", bullets(UNDO_GUIDANCE.lines)].join("\n"),
    );
  });
});

describe("parseSectionFile", () => {
  it("treats a file without front-matter as pure prose", () => {
    expect(parseSectionFile("plain prose line\nsecond line")).toEqual({
      text: "plain prose line\nsecond line",
    });
  });

  it("parses order from a valid front-matter fence", () => {
    expect(parseSectionFile("---\norder: 150\n---\nbody line")).toEqual({
      order: 150,
      text: "body line",
    });
  });

  it("strips leading blank lines after the closing fence", () => {
    expect(parseSectionFile("---\norder: 150\n---\n\nbody")).toEqual({
      order: 150,
      text: "body",
    });
  });

  it("accepts a fence without an order key (body only)", () => {
    expect(parseSectionFile("---\n---\nbody")).toEqual({
      text: "body",
    });
  });

  it("accepts negative orders", () => {
    expect(parseSectionFile("---\norder: -5\n---\nbody").order).toBe(-5);
  });

  it("treats a missing closing fence as malformed", () => {
    const content = "---\norder: 150\nbody then";
    expect(parseSectionFile(content)).toEqual({
      text: content,
      malformed: true,
      reason: "missing closing fence",
    });
  });

  it("treats a non-integer order as malformed", () => {
    const content = "---\norder: abc\n---\nbody";
    expect(parseSectionFile(content)).toEqual({
      text: content,
      malformed: true,
      reason: "non-integer order 'abc'",
    });
  });

  it("treats an unknown front-matter key as malformed", () => {
    const content = "---\ntitle: x\n---\nbody";
    expect(parseSectionFile(content)).toEqual({
      text: content,
      malformed: true,
      reason: "unknown key 'title'",
    });
  });

  it("is CRLF-tolerant for the fence", () => {
    expect(parseSectionFile("---\r\norder: 201\r\n---\r\nbody")).toEqual({
      order: 201,
      text: "body",
    });
  });

  it("parses a BOM + LF order fence identically to its BOM-less twin", () => {
    const twin = "---\norder: 150\n---\nbody line";
    expect(parseSectionFile(`\uFEFF${twin}`)).toEqual(parseSectionFile(twin));
    expect(parseSectionFile(`\uFEFF${twin}`)).toEqual({ order: 150, text: "body line" });
  });

  it("parses a BOM + CRLF order fence identically to its BOM-less twin", () => {
    const twin = "---\r\norder: 201\r\n---\r\nbody";
    expect(parseSectionFile(`\uFEFF${twin}`)).toEqual(parseSectionFile(twin));
    expect(parseSectionFile(`\uFEFF${twin}`)).toEqual({ order: 201, text: "body" });
  });

  it("strips one leading BOM from prose", () => {
    expect(parseSectionFile("\uFEFFprose line")).toEqual({ text: "prose line" });
  });

  it("treats a BOM + malformed fence as malformed", () => {
    const body = "---\norder: abc\n---\nbody";
    expect(parseSectionFile(`\uFEFF${body}`)).toEqual({
      text: body,
      malformed: true,
      reason: "non-integer order 'abc'",
    });
  });

  it("returns an empty string for an empty file", () => {
    expect(parseSectionFile("")).toEqual({ text: "" });
  });
});

describe("guidance override predicates", () => {
  it("treats an empty file as blank, not malformed", () => {
    expect(parseSectionFile("")).toEqual({ text: "" });
    expect(isBlankOverride("")).toBe(true);
    expect(isMalformedOverride("")).toBe(false);
  });

  it("treats a whitespace-only file as blank, not malformed", () => {
    expect(isBlankOverride("  \n\t\n ")).toBe(true);
    expect(isMalformedOverride("  \n\t\n ")).toBe(false);
  });

  it("treats prose with content as not blank", () => {
    expect(isBlankOverride("hello")).toBe(false);
    expect(isMalformedOverride("hello")).toBe(false);
  });

  it("treats a valid keyless fence as a deliberate blank (not blank, not malformed)", () => {
    expect(parseSectionFile("---\n---\n")).toEqual({ text: "" });
    expect(isBlankOverride("---\n---\n")).toBe(false);
    expect(isMalformedOverride("---\n---\n")).toBe(false);
  });

  it("treats a BOM + keyless fenced blank as a deliberate blank", () => {
    expect(parseSectionFile("\uFEFF---\n---\n")).toEqual({ text: "" });
    expect(isBlankOverride("\uFEFF---\n---\n")).toBe(false);
    expect(isMalformedOverride("\uFEFF---\n---\n")).toBe(false);
  });

  it("treats a BOM-only file as a bare blank", () => {
    expect(parseSectionFile("\uFEFF")).toEqual({ text: "" });
    expect(isBlankOverride("\uFEFF")).toBe(true);
    expect(isMalformedOverride("\uFEFF")).toBe(false);
  });

  it("treats a valid empty-body fence with an order as not blank", () => {
    expect(parseSectionFile("---\norder: 150\n---\n")).toEqual({
      order: 150,
      text: "",
    });
    expect(isBlankOverride("---\norder: 150\n---\n")).toBe(false);
    expect(isMalformedOverride("---\norder: 150\n---\n")).toBe(false);
  });

  it("treats a whitespace-only body under a valid fence as not blank", () => {
    expect(isBlankOverride("---\n---\n\n  \n")).toBe(false);
    expect(isMalformedOverride("---\n---\n\n  \n")).toBe(false);
  });

  it("treats a malformed file as not blank and malformed", () => {
    expect(isBlankOverride("---\norder: abc\n---\nbody")).toBe(false);
    expect(isMalformedOverride("---\norder: abc\n---\nbody")).toBe(true);
  });
});

describe("resolveSection", () => {
  it("falls back to the compiled default when no override exists", async () => {
    await withHome(async (home) => {
      const resolved = await resolveSection("tool:edit", {
        presetId: "standard",
        homeDir: home,
      });
      expect(resolved).toEqual({
        order: 1300,
        text: renderSectionDefault("tool:edit"),
      });
    });
  });

  it("reads the preset file when one exists", async () => {
    await withHome(async (home) => {
      await writeSection(home, "standard", "edit.md", "preset edit text");
      const resolved = await resolveSection("tool:edit", {
        presetId: "standard",
        homeDir: home,
      });
      expect(resolved.order).toBe(1300);
      expect(resolved.text).toContain("preset edit text");
      expectDivergenceNotice(resolved.text);
    });
  });

  it("applies the front-matter order override", async () => {
    await withHome(async (home) => {
      await writeSection(home, "minimal", "edit.md", "---\norder: 300\n---\nminimal text");
      const resolved = await resolveSection("tool:edit", {
        presetId: "minimal",
        homeDir: home,
      });
      expect(resolved.order).toBe(300);
      expect(resolved.text).toContain("minimal text");
      expectDivergenceNotice(resolved.text);
    });
  });

  it("ignores preset files when presetId is undefined", async () => {
    await withHome(async (home) => {
      await writeSection(home, "standard", "edit.md", "preset edit text");
      const resolved = await resolveSection("tool:edit", {
        presetId: undefined,
        homeDir: home,
      });
      expect(resolved).toEqual({
        order: 1300,
        text: renderSectionDefault("tool:edit"),
      });
    });
  });

  it("falls back to compiled defaults when the preset has no directory", async () => {
    await withHome(async (home) => {
      const resolved = await resolveSection("tool:edit", {
        presetId: "ghost",
        homeDir: home,
      });
      expect(resolved).toEqual({
        order: 1300,
        text: renderSectionDefault("tool:edit"),
      });
    });
  });

  it("resolves to compiled defaults when presetId is undefined and nothing exists", async () => {
    await withHome(async (home) => {
      const resolved = await resolveSection("tool:read", {
        presetId: undefined,
        homeDir: home,
      });
      expect(resolved).toEqual({
        order: 1100,
        text: renderSectionDefault("tool:read"),
      });
    });
  });

  it("throws on an unknown section name", async () => {
    await withHome(async (home) => {
      await expect(
        resolveSection("tool:nope", { presetId: "standard", homeDir: home }),
      ).rejects.toThrow("unknown guidance section");
    });
  });

  it("treats a blank override file as absent and uses the compiled default", async () => {
    await withHome(async (home) => {
      await writeSection(home, "standard", "edit.md", "");
      const resolved = await resolveSection("tool:edit", {
        presetId: "standard",
        homeDir: home,
      });
      expect(resolved).toEqual({
        order: 1300,
        text: renderSectionDefault("tool:edit"),
      });
      expect(resolved.text).not.toContain("[USER] [W_PROMPT_DIVERGED]");
    });
  });

  it("treats a whitespace-only override file as absent and uses the compiled default", async () => {
    await withHome(async (home) => {
      await writeSection(home, "standard", "edit.md", "   \n\t  \n");
      const resolved = await resolveSection("tool:edit", {
        presetId: "standard",
        homeDir: home,
      });
      expect(resolved).toEqual({
        order: 1300,
        text: renderSectionDefault("tool:edit"),
      });
      expect(resolved.text).not.toContain("[USER] [W_PROMPT_DIVERGED]");
    });
  });

  it("resolves a malformed override file to the compiled default and reports the file + reason", async () => {
    await withHome(async (home) => {
      const file = join(home, "standard", "edit.md");
      await writeSection(home, "standard", "edit.md", "---\norder: abc\n---\nmalformed body");
      const resolved = await resolveSection("tool:edit", {
        presetId: "standard",
        homeDir: home,
      });
      expect(resolved).toEqual({
        order: 1300,
        text: renderSectionDefault("tool:edit"),
        malformed: { file, reason: "non-integer order 'abc'" },
      });
    });
  });

  it("malformed never renders the file's text", async () => {
    await withHome(async (home) => {
      await writeSection(home, "standard", "edit.md", "---\norder: abc\n---\nNEVER-SHOW");
      const resolved = await resolveSection("tool:edit", {
        presetId: "standard",
        homeDir: home,
      });
      expect(resolved.text).toBe(renderSectionDefault("tool:edit"));
      expect(resolved.text).not.toContain("NEVER-SHOW");
      expect(resolved.text).not.toContain("[USER] [W_PROMPT_DIVERGED]");
    });
  });

  it("a missing-closing-fence override is malformed and falls back to the compiled default", async () => {
    await withHome(async (home) => {
      const file = join(home, "standard", "edit.md");
      await writeSection(home, "standard", "edit.md", "---\norder: 150\nbody then");
      const resolved = await resolveSection("tool:edit", {
        presetId: "standard",
        homeDir: home,
      });
      expect(resolved.malformed).toEqual({
        file,
        reason: "missing closing fence",
      });
      expect(resolved.text).toBe(renderSectionDefault("tool:edit"));
      expect(resolved.text).not.toContain("[USER] [W_PROMPT_DIVERGED]");
    });
  });

  it("a non-blank file wins over the compiled default", async () => {
    await withHome(async (home) => {
      await writeSection(home, "standard", "edit.md", "   \nactual guidance\n");
      const resolved = await resolveSection("tool:edit", {
        presetId: "standard",
        homeDir: home,
      });
      expect(resolved.order).toBe(1300);
      expect(resolved.text).toBe(`   \nactual guidance\n\n${DIVERGED_NOTICE}`);
    });
  });

  it("preserves a deliberate blank-with-fence by rendering an empty string at its order", async () => {
    await withHome(async (home) => {
      await writeSection(home, "minimal", "edit.md", "---\norder: 300\n---\n");
      const resolved = await resolveSection("tool:edit", {
        presetId: "minimal",
        homeDir: home,
      });
      expect(resolved).toEqual({ order: 300, text: "" });
      expect(resolved.text).not.toContain("[USER] [W_PROMPT_DIVERGED]");
    });
  });

  it("preserves a deliberate keyless blank-with-fence by rendering an empty string at the default order", async () => {
    await withHome(async (home) => {
      await writeSection(home, "minimal", "edit.md", "---\n---\n");
      const resolved = await resolveSection("tool:edit", {
        presetId: "minimal",
        homeDir: home,
      });
      expect(resolved).toEqual({ order: 1300, text: "" });
      expect(resolved.text).not.toContain("[USER] [W_PROMPT_DIVERGED]");
    });
  });
  it("does not mark a current-default override as diverged", async () => {
    await withHome(async (home) => {
      await writeSection(home, "standard", "edit.md", renderSectionDefault("tool:edit"));
      const resolved = await resolveSection("tool:edit", {
        presetId: "standard",
        homeDir: home,
      });
      expect(resolved).toEqual({ order: 1300, text: renderSectionDefault("tool:edit") });
      expect(resolved.text).not.toContain("[USER] [W_PROMPT_DIVERGED]");
    });
  });

  it("does not mark a normally seeded preset dir as diverged in any section", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      for (const section of GUIDANCE_SECTIONS) {
        const resolved = await resolveSection(section.name, {
          presetId: "standard",
          homeDir: home,
        });
        expect(resolved.text).toBe(section.renderDefault());
        expect(resolved.text).not.toContain("[USER] [W_PROMPT_DIVERGED]");
      }
    });
  });

  it("marks a historical stale seed as diverged", async () => {
    await withHome(async (home) => {
      const staleSeed = await readFile(
        fileURLToPath(new URL("./fixtures/guidance-seeds/v1.2.4/edit.md", import.meta.url)),
        "utf-8",
      );
      await writeSection(home, "standard", "edit.md", staleSeed);
      const resolved = await resolveSection("tool:edit", {
        presetId: "standard",
        homeDir: home,
      });
      expect(resolved.text).toContain("[USER] [W_PROMPT_DIVERGED]");
      expect(resolved.text).toContain("Local guidance differs");
      expectDivergenceNotice(resolved.text);
    });
  });
});

describe("composeSections", () => {
  it("returns the three sections in default-order sequence", async () => {
    await withHome(async (home) => {
      const sections = await composeSections(undefined, home);
      expect(sections.map((s) => s.name)).toEqual([
        "tool:read",
        "tool:edit",
        "tool:undo_last_edit",
      ]);
      expect(sections.map((s) => s.order)).toEqual([1100, 1300, 1310]);
      expect(sections.map((s) => s.text)).toEqual(GUIDANCE_SECTIONS.map((s) => s.renderDefault()));
    });
  });

  it("overrides only the sections that have preset files", async () => {
    await withHome(async (home) => {
      await writeSection(home, "standard", "edit.md", "---\norder: 210\n---\ncode edits");
      const sections = await composeSections("standard", home);
      const edit = requireSection(sections, "tool:edit");
      expect(edit.order).toBe(210);
      expect(edit.text).toContain("code edits");
      expectDivergenceNotice(edit.text);
      expect(sections.find((s) => s.name === "tool:read")).toEqual({
        name: "tool:read",
        order: 1100,
        text: renderSectionDefault("tool:read"),
      });
    });
  });
});

describe("ensurePresetGuidance", () => {
  it("seeds each shipped preset with the compiled default body and records the ledger", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      for (const preset of DEFAULT_PRESETS) {
        for (const section of GUIDANCE_SECTIONS) {
          const content = await readFile(join(home, preset, section.file), "utf-8");
          expect(content).toBe(section.renderDefault());
          expect(content).not.toMatch(/^---$/m);
        }
      }
      const manifest = await readManifest(home);
      expect(manifest.version).toBe(1);
      expect(Object.keys(manifest.files).sort()).toEqual(
        DEFAULT_PRESETS.flatMap((preset) =>
          GUIDANCE_SECTIONS.map((section) => `${preset}/${section.file}`),
        ).sort(),
      );
      for (const [key, hash] of Object.entries(manifest.files)) {
        const content = await readFile(join(home, ...key.split("/")), "utf-8");
        expect(hash).toBe(seedHash(content));
      }
      const readme = await readFile(join(home, "README.md"), "utf-8");
      expect(readme).toBe(GUIDANCE_HOME_README);
      expect(readme).toContain("order");
      const readmeZh = await readFile(join(home, "README.zh.md"), "utf-8");
      expect(readmeZh).toBe(GUIDANCE_HOME_README_ZH);
      expect(readmeZh).toContain("order");
    });
  });

  it("never rewrites existing files - a user-edited preset file survives repeated calls", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      const editFile = join(home, "standard", "edit.md");
      const custom = "---\norder: 150\n---\nMy custom edit guidance, kept verbatim.";
      await writeFile(editFile, custom, "utf-8");
      await ensurePresetGuidance(home);
      expect(await readFile(editFile, "utf-8")).toBe(custom);
    });
  });

  it("fills in only the files that are missing", async () => {
    await withHome(async (home) => {
      await mkdir(join(home, "standard"), { recursive: true });
      await writeFile(join(home, "standard", "edit.md"), "custom edit guidance", "utf-8");
      await ensurePresetGuidance(home);
      expect(await readFile(join(home, "standard", "edit.md"), "utf-8")).toBe(
        "custom edit guidance",
      );
      for (const section of GUIDANCE_SECTIONS) {
        if (section.file === "edit.md") continue;
        expect(await readFile(join(home, "standard", section.file), "utf-8")).toBe(
          section.renderDefault(),
        );
      }
      expect(await readFile(join(home, "README.md"), "utf-8")).toBe(GUIDANCE_HOME_README);
      expect(await readFile(join(home, "README.zh.md"), "utf-8")).toBe(GUIDANCE_HOME_README_ZH);
    });
  });

  it("a seeded preset dir is honoured as that preset's editable default", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      await writeFile(
        join(home, "standard", "edit.md"),
        "---\norder: 151\n---\ncustom code edit guidance",
        "utf-8",
      );
      const resolved = await resolveSection("tool:edit", {
        presetId: "standard",
        homeDir: home,
      });
      expect(resolved.order).toBe(151);
      expect(resolved.text).toContain("custom code edit guidance");
      expectDivergenceNotice(resolved.text);
      const read = await resolveSection("tool:read", {
        presetId: "standard",
        homeDir: home,
      });
      expect(read).toEqual({
        order: 1100,
        text: renderSectionDefault("tool:read"),
      });
      expect(read.text).not.toContain("[USER] [W_PROMPT_DIVERGED]");
    });
  });

  it("re-seeds a blank section file in a shipped preset with the compiled default", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      const editFile = join(home, "standard", "edit.md");
      await writeFile(editFile, "", "utf-8");
      await ensurePresetGuidance(home);
      expect(await readFile(editFile, "utf-8")).toBe(renderSectionDefault("tool:edit"));
    });
  });

  it("re-seeds a blank section file in a custom preset dir present on disk", async () => {
    await withHome(async (home) => {
      await mkdir(join(home, "ghost"), { recursive: true });
      const ghostRead = join(home, "ghost", "read.md");
      await writeFile(ghostRead, "  \n\t \n", "utf-8");
      await ensurePresetGuidance(home);
      expect(await readFile(ghostRead, "utf-8")).toBe(renderSectionDefault("tool:read"));
    });
  });

  it("leaves a malformed override file byte-identical and warns once", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      const editFile = join(home, "standard", "edit.md");
      const malformed = "---\norder: abc\n---\nsalvageable body";
      await writeFile(editFile, malformed, "utf-8");
      const warn = vi.fn();
      await ensurePresetGuidance(home, warn);
      expect(await readFile(editFile, "utf-8")).toBe(malformed);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(editFile);
    });
  });

  it("leaves a non-blank override file byte-identical", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      const editFile = join(home, "standard", "edit.md");
      const custom = "plain prose guidance";
      await writeFile(editFile, custom, "utf-8");
      await ensurePresetGuidance(home);
      expect(await readFile(editFile, "utf-8")).toBe(custom);
    });
  });

  it("does not fabricate absent custom-preset section files", async () => {
    await withHome(async (home) => {
      await mkdir(join(home, "ghost"), { recursive: true });
      await ensurePresetGuidance(home);
      expect(await readdir(join(home, "ghost"))).toEqual([]);
    });
  });

  it("lets a deliberate-blank (valid-fence) file survive boot untouched", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      const editFile = join(home, "standard", "edit.md");
      const deliberate = "---\norder: 150\n---\n";
      await writeFile(editFile, deliberate, "utf-8");
      await ensurePresetGuidance(home);
      expect(await readFile(editFile, "utf-8")).toBe(deliberate);
    });
  });

  it("lets a deliberate keyless-blank (valid-fence) file survive boot untouched", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      const editFile = join(home, "standard", "edit.md");
      const deliberate = "---\n---\n";
      await writeFile(editFile, deliberate, "utf-8");
      const warn = vi.fn();
      await ensurePresetGuidance(home, warn);
      expect(await readFile(editFile, "utf-8")).toBe(deliberate);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("re-seeds all section files after a shipped preset dir is deleted", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      await rm(join(home, "standard"), { recursive: true, force: true });
      await ensurePresetGuidance(home);
      for (const section of GUIDANCE_SECTIONS) {
        expect(await readFile(join(home, "standard", section.file), "utf-8")).toBe(
          section.renderDefault(),
        );
      }
    });
  });

  it("preserves a customized shipped file and reports it in one aggregated warning", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      const editFile = join(home, "standard", "edit.md");
      const customized = `${renderSectionDefault("tool:edit")}\n\n- extra local rule`;
      await writeFile(editFile, customized, "utf-8");
      const warn = vi.fn();
      await ensurePresetGuidance(home, warn);
      expect(await readFile(editFile, "utf-8")).toBe(customized);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).toContain("1 guidance override file(s)");
      expect(message).toContain(editFile);
    });
  });
  it("aggregates every customized shipped file into one counted warning", async () => {
    await withHome(async (home) => {
      await ensurePresetGuidance(home);
      const editFile = join(home, "standard", "edit.md");
      const readOverride = join(home, "minimal", "read.md");
      const customizedEdit = `${renderSectionDefault("tool:edit")}\n\n- extra local edit rule`;
      const customizedRead = `${renderSectionDefault("tool:read")}\n\n- extra local read rule`;
      await writeFile(editFile, customizedEdit, "utf-8");
      await writeFile(readOverride, customizedRead, "utf-8");

      const warn = vi.fn();
      await ensurePresetGuidance(home, warn);

      expect(await readFile(editFile, "utf-8")).toBe(customizedEdit);
      expect(await readFile(readOverride, "utf-8")).toBe(customizedRead);

      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).toContain("2 guidance override file(s)");
      expect(message.startsWith("dsh-better-edit: 2 guidance override file(s)")).toBe(true);
      expect(message).toContain(editFile);
      expect(message).toContain(readOverride);
    });
  });

  it("refreshes a shipped file whose bytes match a historical seed", async () => {
    await withHome(async (home) => {
      await writeSection(home, "standard", "edit.md", await readFixture("v1.2.4", "edit.md"));
      await ensurePresetGuidance(home);
      const refreshed = await readFile(join(home, "standard", "edit.md"), "utf-8");
      expect(refreshed).toBe(renderSectionDefault("tool:edit"));
      expect(refreshed).not.toMatch(/^---$/m);
      const manifest = await readManifest(home);
      expect(manifest.files["standard/edit.md"]).toBe(seedHash(refreshed));
    });
  });

  it("refreshes a shipped file whose hash the ledger recorded", async () => {
    await withHome(async (home) => {
      const oldBody = "an older compiled default body";
      await writeSection(home, "standard", "edit.md", oldBody);
      await writeManifest(home, { "standard/edit.md": seedHash(oldBody) });
      await ensurePresetGuidance(home);
      const refreshed = await readFile(join(home, "standard", "edit.md"), "utf-8");
      expect(refreshed).toBe(renderSectionDefault("tool:edit"));
      const manifest = await readManifest(home);
      expect(manifest.files["standard/edit.md"]).toBe(seedHash(refreshed));
    });
  });

  it("refreshes a BOM + CRLF variant of a historical seed to the LF default", async () => {
    await withHome(async (home) => {
      const historical = await readFixture("v1.2.4", "edit.md");
      const variant = `\uFEFF${historical.replace(/\r?\n/g, "\r\n")}`;
      await writeSection(home, "standard", "edit.md", variant);
      await ensurePresetGuidance(home);
      const refreshed = await readFile(join(home, "standard", "edit.md"), "utf-8");
      expect(refreshed).toBe(renderSectionDefault("tool:edit"));
      const manifest = await readManifest(home);
      expect(manifest.files["standard/edit.md"]).toBe(seedHash(refreshed));
    });
  });

  it("replaces a corrupt ledger with a valid one", async () => {
    await withHome(async (home) => {
      await writeFile(join(home, MANIFEST), "{oops", "utf-8");
      await ensurePresetGuidance(home);
      const manifest = await readManifest(home);
      expect(manifest.version).toBe(1);
      expect(Object.keys(manifest.files)).toHaveLength(12);
      for (const section of GUIDANCE_SECTIONS) {
        const content = await readFile(join(home, "standard", section.file), "utf-8");
        expect(manifest.files[`standard/${section.file}`]).toBe(seedHash(content));
      }
    });
  });

  it("warns about a stale seed in a custom preset without refreshing it", async () => {
    await withHome(async (home) => {
      const historical = await readFixture("v1.2.4", "edit.md");
      await writeSection(home, "ghost", "edit.md", historical);
      const warn = vi.fn();
      await ensurePresetGuidance(home, warn);
      expect(await readFile(join(home, "ghost", "edit.md"), "utf-8")).toBe(historical);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(join(home, "ghost", "edit.md"));
    });
  });

  it("stays silent about a custom preset file that matches the current default", async () => {
    await withHome(async (home) => {
      await writeSection(home, "ghost", "read.md", renderSectionDefault("tool:read"));
      const warn = vi.fn();
      await ensurePresetGuidance(home, warn);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe("composeSections — harness slot resolution", () => {
  it("defaults an unoverridden section to the harness's live slot", async () => {
    await withHome(async (home) => {
      const slots: Record<string, number> = { "tool:read": 1201, "tool:edit": 1401 };
      const sections = await composeSections(
        undefined,
        home,
        (section) => slots[section.name] ?? section.defaultOrder,
      );
      expect(sections.map((s) => s.order)).toEqual([1201, 1401, 1310]);
    });
  });

  it("lets an override file's explicit order win over the harness slot", async () => {
    await withHome(async (home) => {
      await writeSection(home, "standard", "edit.md", "---\norder: 77\n---\npreset edit text");
      const sections = await composeSections("standard", home, () => 1401);
      const explicit = requireSection(sections, "tool:edit");
      expect(explicit.order).toBe(77);
      expect(explicit.text).toContain("preset edit text");
      expectDivergenceNotice(explicit.text);
      await writeSection(home, "minimal", "edit.md", "---\n---\nkeyless guidance");
      const keyless = await composeSections("minimal", home, () => 1401);
      const keylessSection = requireSection(keyless, "tool:edit");
      expect(keylessSection.order).toBe(1401);
      expect(keylessSection.text).toContain("keyless guidance");
      expectDivergenceNotice(keylessSection.text);
    });
  });

  it("a malformed override falls back to the harness slot", async () => {
    await withHome(async (home) => {
      await writeSection(home, "standard", "edit.md", "---\norder: abc\n---\nNEVER-SHOW");
      const sections = await composeSections("standard", home, () => 1401);
      expect(sections.find((s) => s.name === "tool:edit")).toEqual({
        name: "tool:edit",
        order: 1401,
        text: renderSectionDefault("tool:edit"),
        malformed: { file: join(home, "standard", "edit.md"), reason: "non-integer order 'abc'" },
      });
      expect(requireSection(sections, "tool:edit").text).not.toContain(
        "[USER] [W_PROMPT_DIVERGED]",
      );
    });
  });
});
