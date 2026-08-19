import { describe, expect, it } from "vitest";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

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
import {
	BATCH_EDIT_GUIDANCE,
	EDIT_GUIDANCE,
	READ_GUIDANCE,
	UNDO_GUIDANCE,
} from "../src/prompts.js";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
	const home = await mkdtemp(
		join(await getWritableTempRoot(), "dsh-guidance-test-"),
	);
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

const bullets = (lines: readonly string[]) =>
	lines.map((line) => `- ${line}`).join("\n");

describe("guidance sections", () => {
	it("exposes the four sections with stable order, file names, and defaults", () => {
		expect(GUIDANCE_SECTIONS.map((s) => s.name)).toEqual([
			"tool:read",
			"tool:edit",
			"tool:batch_edit",
			"tool:undo_last_edit",
		]);
		expect(GUIDANCE_SECTIONS.map((s) => s.file)).toEqual([
			"read.md",
			"edit.md",
			"batch_edit.md",
			"undo_last_edit.md",
		]);
		expect(GUIDANCE_SECTIONS.map((s) => s.defaultOrder)).toEqual([
			130, 131, 132, 133,
		]);
	});

	it("default render matches today's inline section text", () => {
		expect(renderSectionDefault("tool:read")).toBe(
			[READ_GUIDANCE.intro, "", bullets(READ_GUIDANCE.lines)].join("\n"),
		);
		expect(renderSectionDefault("tool:edit")).toBe(
			[EDIT_GUIDANCE.intro, "", bullets(EDIT_GUIDANCE.lines)].join("\n"),
		);
		expect(renderSectionDefault("tool:batch_edit")).toBe(
			[BATCH_EDIT_GUIDANCE.intro, "", bullets(BATCH_EDIT_GUIDANCE.lines)].join(
				"\n",
			),
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
				presetId: "code",
				homeDir: home,
			});
			expect(resolved).toEqual({
				order: 131,
				text: renderSectionDefault("tool:edit"),
			});
		});
	});

	it("reads the preset file when one exists", async () => {
		await withHome(async (home) => {
			await writeSection(home, "code", "edit.md", "preset edit text");
			const resolved = await resolveSection("tool:edit", {
				presetId: "code",
				homeDir: home,
			});
			expect(resolved).toEqual({ order: 131, text: "preset edit text" });
		});
	});

	it("applies the front-matter order override", async () => {
		await withHome(async (home) => {
			await writeSection(
				home,
				"minimal",
				"edit.md",
				"---\norder: 300\n---\nminimal text",
			);
			const resolved = await resolveSection("tool:edit", {
				presetId: "minimal",
				homeDir: home,
			});
			expect(resolved).toEqual({ order: 300, text: "minimal text" });
		});
	});

	it("ignores preset files when presetId is undefined", async () => {
		await withHome(async (home) => {
			await writeSection(home, "code", "edit.md", "preset edit text");
			const resolved = await resolveSection("tool:edit", {
				presetId: undefined,
				homeDir: home,
			});
			expect(resolved).toEqual({
				order: 131,
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
				order: 131,
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
				order: 130,
				text: renderSectionDefault("tool:read"),
			});
		});
	});

	it("throws on an unknown section name", async () => {
		await withHome(async (home) => {
			await expect(
				resolveSection("tool:nope", { presetId: "code", homeDir: home }),
			).rejects.toThrow("unknown guidance section");
		});
	});

	it("treats a blank override file as absent and uses the compiled default", async () => {
		await withHome(async (home) => {
			await writeSection(home, "code", "edit.md", "");
			const resolved = await resolveSection("tool:edit", {
				presetId: "code",
				homeDir: home,
			});
			expect(resolved).toEqual({
				order: 131,
				text: renderSectionDefault("tool:edit"),
			});
		});
	});

	it("treats a whitespace-only override file as absent and uses the compiled default", async () => {
		await withHome(async (home) => {
			await writeSection(home, "code", "edit.md", "   \n\t  \n");
			const resolved = await resolveSection("tool:edit", {
				presetId: "code",
				homeDir: home,
			});
			expect(resolved).toEqual({
				order: 131,
				text: renderSectionDefault("tool:edit"),
			});
		});
	});

	it("resolves a malformed override file to the compiled default and reports the file + reason", async () => {
		await withHome(async (home) => {
			const file = join(home, "code", "edit.md");
			await writeSection(
				home,
				"code",
				"edit.md",
				"---\norder: abc\n---\nmalformed body",
			);
			const resolved = await resolveSection("tool:edit", {
				presetId: "code",
				homeDir: home,
			});
			expect(resolved).toEqual({
				order: 131,
				text: renderSectionDefault("tool:edit"),
				malformed: { file, reason: "non-integer order 'abc'" },
			});
		});
	});

	it("malformed never renders the file's text", async () => {
		await withHome(async (home) => {
			await writeSection(
				home,
				"code",
				"edit.md",
				"---\norder: abc\n---\nNEVER-SHOW",
			);
			const resolved = await resolveSection("tool:edit", {
				presetId: "code",
				homeDir: home,
			});
			expect(resolved.text).toBe(renderSectionDefault("tool:edit"));
			expect(resolved.text).not.toContain("NEVER-SHOW");
		});
	});

	it("a missing-closing-fence override is malformed and falls back to the compiled default", async () => {
		await withHome(async (home) => {
			const file = join(home, "code", "edit.md");
			await writeSection(home, "code", "edit.md", "---\norder: 150\nbody then");
			const resolved = await resolveSection("tool:edit", {
				presetId: "code",
				homeDir: home,
			});
			expect(resolved.malformed).toEqual({
				file,
				reason: "missing closing fence",
			});
			expect(resolved.text).toBe(renderSectionDefault("tool:edit"));
		});
	});

	it("a non-blank file wins over the compiled default", async () => {
		await withHome(async (home) => {
			await writeSection(home, "code", "edit.md", "   \nactual guidance\n");
			const resolved = await resolveSection("tool:edit", {
				presetId: "code",
				homeDir: home,
			});
			expect(resolved).toEqual({ order: 131, text: "   \nactual guidance\n" });
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
		});
	});

	it("preserves a deliberate keyless blank-with-fence by rendering an empty string at the default order", async () => {
		await withHome(async (home) => {
			await writeSection(home, "minimal", "edit.md", "---\n---\n");
			const resolved = await resolveSection("tool:edit", {
				presetId: "minimal",
				homeDir: home,
			});
			expect(resolved).toEqual({ order: 131, text: "" });
		});
	});
});

describe("composeSections", () => {
	it("returns the four sections in default-order sequence", async () => {
		await withHome(async (home) => {
			const sections = await composeSections(undefined, home);
			expect(sections.map((s) => s.name)).toEqual([
				"tool:read",
				"tool:edit",
				"tool:batch_edit",
				"tool:undo_last_edit",
			]);
			expect(sections.map((s) => s.order)).toEqual([130, 131, 132, 133]);
			expect(sections.map((s) => s.text)).toEqual(
				GUIDANCE_SECTIONS.map((s) => s.renderDefault()),
			);
		});
	});

	it("overrides only the sections that have preset files", async () => {
		await withHome(async (home) => {
			await writeSection(
				home,
				"code",
				"edit.md",
				"---\norder: 210\n---\ncode edits",
			);
			const sections = await composeSections("code", home);
			expect(sections.find((s) => s.name === "tool:edit")).toEqual({
				name: "tool:edit",
				order: 210,
				text: "code edits",
			});
			// Unoverridden sections keep their compiled defaults.
			expect(sections.find((s) => s.name === "tool:read")).toEqual({
				name: "tool:read",
				order: 130,
				text: renderSectionDefault("tool:read"),
			});
		});
	});
});

describe("ensurePresetGuidance", () => {
	it("seeds each shipped preset with the four section files plus a root README", async () => {
		await withHome(async (home) => {
			await ensurePresetGuidance(home);
			for (const preset of DEFAULT_PRESETS) {
				for (const section of GUIDANCE_SECTIONS) {
					const content = await readFile(join(home, preset, section.file), "utf-8");
					expect(content).toBe(
						`---\norder: ${section.defaultOrder}\n---\n\n${section.renderDefault()}`,
					);
				}
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
			const editFile = join(home, "code", "edit.md");
			const custom =
				"---\norder: 150\n---\nMy custom edit guidance, kept verbatim.";
			await writeFile(editFile, custom, "utf-8");
			await ensurePresetGuidance(home);
			expect(await readFile(editFile, "utf-8")).toBe(custom);
		});
	});

	it("fills in only the files that are missing", async () => {
		await withHome(async (home) => {
			await mkdir(join(home, "code"), { recursive: true });
			await writeFile(
				join(home, "code", "edit.md"),
				"custom edit guidance",
				"utf-8",
			);
			await ensurePresetGuidance(home);
			expect(await readFile(join(home, "code", "edit.md"), "utf-8")).toBe(
				"custom edit guidance",
			);
			for (const section of GUIDANCE_SECTIONS) {
				if (section.file === "edit.md") continue;
				expect(await readFile(join(home, "code", section.file), "utf-8")).toBe(
					`---\norder: ${section.defaultOrder}\n---\n\n${section.renderDefault()}`,
				);
			}
			expect(await readFile(join(home, "README.md"), "utf-8")).toBe(
				GUIDANCE_HOME_README,
				GUIDANCE_HOME_README_ZH,
			);
		});
	});

	it("a seeded preset dir is honoured as that preset's editable default", async () => {
		await withHome(async (home) => {
			await ensurePresetGuidance(home);
			await writeFile(
				join(home, "code", "edit.md"),
				"---\norder: 151\n---\ncustom code edit guidance",
				"utf-8",
			);
			const resolved = await resolveSection("tool:edit", {
				presetId: "code",
				homeDir: home,
			});
			expect(resolved).toEqual({
				order: 151,
				text: "custom code edit guidance",
			});
			// An unedited seeded section still equals the compiled default.
			const read = await resolveSection("tool:read", {
				presetId: "code",
				homeDir: home,
			});
			expect(read).toEqual({
				order: 130,
				text: renderSectionDefault("tool:read"),
			});
		});
	});

	it("re-seeds a blank section file in a shipped preset with the compiled default", async () => {
		await withHome(async (home) => {
			await ensurePresetGuidance(home);
			const editFile = join(home, "code", "edit.md");
			await writeFile(editFile, "", "utf-8");
			await ensurePresetGuidance(home);
			expect(await readFile(editFile, "utf-8")).toBe(
				`---\norder: 131\n---\n\n${renderSectionDefault("tool:edit")}`,
			);
		});
	});

	it("re-seeds a blank section file in a custom preset dir present on disk", async () => {
		await withHome(async (home) => {
			await mkdir(join(home, "ghost"), { recursive: true });
			const ghostRead = join(home, "ghost", "read.md");
			await writeFile(ghostRead, "  \n\t \n", "utf-8");
			await ensurePresetGuidance(home);
			expect(await readFile(ghostRead, "utf-8")).toBe(
				`---\norder: 130\n---\n\n${renderSectionDefault("tool:read")}`,
			);
		});
	});

	it("leaves a malformed override file byte-identical", async () => {
		await withHome(async (home) => {
			await ensurePresetGuidance(home);
			const editFile = join(home, "code", "edit.md");
			const malformed = "---\norder: abc\n---\nsalvageable body";
			await writeFile(editFile, malformed, "utf-8");
			await ensurePresetGuidance(home);
			expect(await readFile(editFile, "utf-8")).toBe(malformed);
		});
	});

	it("leaves a non-blank override file byte-identical", async () => {
		await withHome(async (home) => {
			await ensurePresetGuidance(home);
			const editFile = join(home, "code", "edit.md");
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
			const editFile = join(home, "code", "edit.md");
			const deliberate = "---\norder: 150\n---\n";
			await writeFile(editFile, deliberate, "utf-8");
			await ensurePresetGuidance(home);
			expect(await readFile(editFile, "utf-8")).toBe(deliberate);
		});
	});

	it("lets a deliberate keyless-blank (valid-fence) file survive boot untouched", async () => {
		await withHome(async (home) => {
			await ensurePresetGuidance(home);
			const editFile = join(home, "code", "edit.md");
			const deliberate = "---\n---\n";
			await writeFile(editFile, deliberate, "utf-8");
			await ensurePresetGuidance(home);
			expect(await readFile(editFile, "utf-8")).toBe(deliberate);
		});
	});

	it("re-seeds all four section files after a shipped preset dir is deleted", async () => {
		await withHome(async (home) => {
			await ensurePresetGuidance(home);
			await rm(join(home, "standard"), { recursive: true, force: true });
			await ensurePresetGuidance(home);
			for (const section of GUIDANCE_SECTIONS) {
				expect(await readFile(join(home, "standard", section.file), "utf-8")).toBe(
					`---\norder: ${section.defaultOrder}\n---\n\n${section.renderDefault()}`,
				);
			}
		});
	});
});
