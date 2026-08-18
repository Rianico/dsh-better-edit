import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getWritableTempRoot } from "./support/fixtures.js";
import {
	DEFAULT_GUIDANCE_DIR,
	DEFAULT_GUIDANCE_README,
	GUIDANCE_SECTIONS,
	composeSections,
	ensureDefaultGuidance,
	parseSectionFile,
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
			[BATCH_EDIT_GUIDANCE.intro, "", bullets(BATCH_EDIT_GUIDANCE.lines)].join("\n"),
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

	it("treats a missing closing fence as prose", () => {
		const content = "---\norder: 150\nbody then";
		expect(parseSectionFile(content)).toEqual({ text: content });
	});

	it("treats a non-integer order as prose", () => {
		const content = "---\norder: abc\n---\nbody";
		expect(parseSectionFile(content)).toEqual({ text: content });
	});

	it("treats an unknown front-matter key as prose", () => {
		const content = "---\ntitle: x\n---\nbody";
		expect(parseSectionFile(content)).toEqual({ text: content });
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

	it("uses the _default file when the preset file is absent", async () => {
		await withHome(async (home) => {
			await writeSection(home, DEFAULT_GUIDANCE_DIR, "edit.md", "global edit text");
			const resolved = await resolveSection("tool:edit", {
				presetId: "code",
				homeDir: home,
			});
			expect(resolved).toEqual({ order: 131, text: "global edit text" });
		});
	});

	it("prefers the preset file over the _default file", async () => {
		await withHome(async (home) => {
			await writeSection(home, "code", "edit.md", "preset edit text");
			await writeSection(home, DEFAULT_GUIDANCE_DIR, "edit.md", "global edit text");
			const resolved = await resolveSection("tool:edit", {
				presetId: "code",
				homeDir: home,
			});
			expect(resolved).toEqual({ order: 131, text: "preset edit text" });
		});
	});

	it("applies the front-matter order override", async () => {
		await withHome(async (home) => {
			await writeSection(home, "minimal", "edit.md", "---\norder: 300\n---\nminimal text");
			const resolved = await resolveSection("tool:edit", {
				presetId: "minimal",
				homeDir: home,
			});
			expect(resolved).toEqual({ order: 300, text: "minimal text" });
		});
	});

	it("skips the preset layer when presetId is undefined but still reads _default", async () => {
		await withHome(async (home) => {
			await writeSection(home, "code", "edit.md", "preset edit text");
			await writeSection(home, DEFAULT_GUIDANCE_DIR, "edit.md", "global edit text");
			const resolved = await resolveSection("tool:edit", {
				presetId: undefined,
				homeDir: home,
			});
			expect(resolved).toEqual({ order: 131, text: "global edit text" });
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
			await writeSection(home, "code", "edit.md", "---\norder: 210\n---\ncode edits");
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


describe("ensureDefaultGuidance", () => {
	it("creates the four section files as order front-matter + compiled default, plus a README", async () => {
		await withHome(async (home) => {
			await ensureDefaultGuidance(home);
			const templateDir = join(home, DEFAULT_GUIDANCE_DIR);
			for (const section of GUIDANCE_SECTIONS) {
				const content = await readFile(
					join(templateDir, section.file),
					"utf-8",
				);
				expect(content).toBe(`---\norder: ${section.defaultOrder}\n---\n\n${section.renderDefault()}`);
			}
			const readme = await readFile(join(templateDir, "README.md"), "utf-8");
			expect(readme).toBe(DEFAULT_GUIDANCE_README);
			expect(readme).toContain("cp -r _default");
			expect(readme).toContain("order");
		});
	});

	it("never rewrites existing files — a user-edited template survives repeated calls", async () => {
		await withHome(async (home) => {
			await ensureDefaultGuidance(home);
			const editFile = join(home, DEFAULT_GUIDANCE_DIR, "edit.md");
			const custom = "---\norder: 150\n---\nMy custom edit guidance, kept verbatim.";
			await writeFile(editFile, custom, "utf-8");
			await ensureDefaultGuidance(home);
			expect(await readFile(editFile, "utf-8")).toBe(custom);
		});
	});

	it("fills in only the files that are missing", async () => {
		await withHome(async (home) => {
			const templateDir = join(home, DEFAULT_GUIDANCE_DIR);
			await mkdir(templateDir, { recursive: true });
			await writeFile(
				join(templateDir, "edit.md"),
				"custom edit guidance",
				"utf-8",
			);
			await ensureDefaultGuidance(home);
			expect(await readFile(join(templateDir, "edit.md"), "utf-8")).toBe(
				"custom edit guidance",
			);
			for (const section of GUIDANCE_SECTIONS) {
				if (section.file === "edit.md") continue;
				expect(
					await readFile(join(templateDir, section.file), "utf-8"),
				).toBe(`---\norder: ${section.defaultOrder}\n---\n\n${section.renderDefault()}`);
			}
			expect(await readFile(join(templateDir, "README.md"), "utf-8")).toBe(
				DEFAULT_GUIDANCE_README,
			);
		});
	});

	it("the materialized _default layer is honoured by the resolver as the global fallback", async () => {
		await withHome(async (home) => {
			await ensureDefaultGuidance(home);
			await writeFile(
				join(home, DEFAULT_GUIDANCE_DIR, "edit.md"),
				"---\norder: 151\n---\ncustom global edit guidance",
				"utf-8",
			);
			const resolved = await resolveSection("tool:edit", { homeDir: home });
			expect(resolved).toEqual({
				order: 151,
				text: "custom global edit guidance",
			});
			const read = await resolveSection("tool:read", { homeDir: home });
			expect(read).toEqual({
				order: 130,
				text: renderSectionDefault("tool:read"),
			});
		});
	});
});

