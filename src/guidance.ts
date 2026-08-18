/**
 * Per-preset guidance overrides for the hashline tool sections.
 *
 * Each of the four `tool:*` prompt sections the plugin registers has a
 * compiled default rendered from `prompts.ts` (byte-identical to the inline
 * rendering `src/index.ts` uses today). A user can override any section's text
 * and `order` with a plain markdown file keyed by agent preset: the override
 * files live in the plugin's shared home (`$DSH_HOME/plugins/dsh-better-edit`,
 * never the workspace store) and are resolved per section as
 * `<preset>/<section>.md` → compiled default.
 *
 * An override file is pure prose unless it opens with a valid YAML front-matter
 * fence carrying only an `order` key (`---` / `order: N` / `---`); anything
 * else — a missing closing fence, a non-integer `order`, an unknown key —
 * degrades the WHOLE file to prose so the mistake stays visible in the
 * rendered section.
 *
 * Resolution is pure: no cordis services, no harness wiring. The installer
 * ticket reads the resolved sections once per agent at session-start;
 * nothing here watches or caches files.
 * @module dsh-better-edit/guidance
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	BATCH_EDIT_GUIDANCE,
	EDIT_GUIDANCE,
	READ_GUIDANCE,
	UNDO_GUIDANCE,
	type ToolGuidance,
} from "./prompts.js";
import { errCode } from "./utils.js";

/** The presets shipped by the harness, each seeded with editable guidance. */
export const DEFAULT_PRESETS: readonly string[] = [
	"standard",
	"code",
	"minimal",
	"cordis",
];

/**
 * Render one tool's guidance as its intro line, a blank line, then bullets.
 * Uniform across the four sections: no tool-schema description is duplicated
 * (that already reaches the model through the tool catalog).
 */
function guidanceText(g: ToolGuidance): string {
	return [g.intro, "", bulletLines(g.lines)].join("\n");
}

function bulletLines(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

/** One overridable tool section. */
export interface GuidanceSection {
	/** Registry section name, e.g. `tool:edit`. */
	name: string;
	/** Override file name inside a preset directory, e.g. `edit.md`. */
	file: string;
	/** Order used when the override file carries no front-matter `order`. */
	defaultOrder: number;
	/** The compiled default text, byte-identical to today's inline rendering. */
	renderDefault(): string;
}

/** The four sections, in default-order sequence. */
export const GUIDANCE_SECTIONS: readonly GuidanceSection[] = [
	{
		name: "tool:read",
		file: "read.md",
		defaultOrder: 130,
		renderDefault: () => guidanceText(READ_GUIDANCE),
	},
	{
		name: "tool:edit",
		file: "edit.md",
		defaultOrder: 131,
		renderDefault: () => guidanceText(EDIT_GUIDANCE),
	},
	{
		name: "tool:batch_edit",
		file: "batch_edit.md",
		defaultOrder: 132,
		renderDefault: () => guidanceText(BATCH_EDIT_GUIDANCE),
	},
	{
		name: "tool:undo_last_edit",
		file: "undo_last_edit.md",
		defaultOrder: 133,
		renderDefault: () => guidanceText(UNDO_GUIDANCE),
	},
];

const SECTION_BY_NAME = new Map(
	GUIDANCE_SECTIONS.map((section) => [section.name, section]),
);

/** Render the compiled default text for one section. */
export function renderSectionDefault(name: string): string {
	const section = SECTION_BY_NAME.get(name);
	if (!section) throw new Error(`unknown guidance section: ${name}`);
	return section.renderDefault();
}

/** The parsed content of one override file. */
export interface ParsedSection {
	/** Front-matter `order`, when present and valid. */
	order?: number;
	/** The section text: the file body, or the whole file when front-matter is absent or malformed. */
	text: string;
}

function stripCR(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Parse an override file. Only a leading `---` fence whose lines are empty or
 * `order: <integer>` is accepted; every other shape (no fence, no closing
 * fence, unknown key, non-integer value) yields the whole file as prose.
 */
export function parseSectionFile(content: string): ParsedSection {
	const lines = content.split("\n");
	if (lines.length < 3 || stripCR(lines[0]) !== "---") {
		return { text: content };
	}
	const close = lines.findIndex(
		(line, index) => index > 0 && stripCR(line) === "---",
	);
	if (close < 0) return { text: content };
	let order: number | undefined;
	for (let index = 1; index < close; index++) {
		const line = stripCR(lines[index]);
		if (line.trim() === "") continue;
		const match = /^order:\s*(-?\d+)\s*$/.exec(line);
		if (!match) return { text: content };
		order = Number.parseInt(match[1] as string, 10);
	}
	// Front-matter body: strip leading blank lines after the closing fence so
	// `---\n…\n---\n\nbody` and `---\n…\n---\nbody` parse identically (the
	// materialized preset files carry a blank line after the fence).
	const body = lines.slice(close + 1);
	let bodyStart = 0;
	while (bodyStart < body.length && body[bodyStart]!.trim() === "")
		bodyStart++;
	return { order, text: body.slice(bodyStart).join("\n") };
}

/** Options for resolving one section's guidance. */
export interface ResolveGuidanceOptions {
	/** Agent preset id, or undefined to skip the preset layer. */
	presetId?: string;
	/** Plugin shared home directory (`$DSH_HOME/plugins/dsh-better-edit`). */
	homeDir: string;
}

function overrideCandidates(
	file: string,
	options: ResolveGuidanceOptions,
): string[] {
	const candidates: string[] = [];
	if (options.presetId !== undefined) {
		candidates.push(join(options.homeDir, options.presetId, file));
	}
	return candidates;
}

/** The resolved text and order for one section. */
export interface GuidanceResolution {
	order: number;
	text: string;
}

/**
 * Resolve one section's guidance: the first override file that exists wins,
 * falling back to the compiled default. A missing file (ENOENT) advances the
 * chain; any other read error propagates.
 */
export async function resolveSection(
	name: string,
	options: ResolveGuidanceOptions,
): Promise<GuidanceResolution> {
	const section = SECTION_BY_NAME.get(name);
	if (!section) throw new Error(`unknown guidance section: ${name}`);
	for (const candidate of overrideCandidates(section.file, options)) {
		const content = await readFile(candidate, "utf-8").catch((error: unknown) => {
			if (errCode(error) === "ENOENT") return undefined;
			throw error;
		});
		if (content === undefined) continue;
		const parsed = parseSectionFile(content);
		return { order: parsed.order ?? section.defaultOrder, text: parsed.text };
	}
	return { order: section.defaultOrder, text: section.renderDefault() };
}

/** The resolved configuration of one section, ready for the systemPrompt registry. */
export interface SectionOverride {
	name: string;
	order: number;
	text: string;
}

/**
 * Resolve all four sections for a preset. `presetId === undefined` skips the
 * `<preset>/` layer and resolves straight to the compiled defaults.
 */
export async function composeSections(
	presetId: string | undefined,
	homeDir: string,
): Promise<SectionOverride[]> {
	return Promise.all(
		GUIDANCE_SECTIONS.map(async (section) => {
			const { order, text } = await resolveSection(section.name, {
				presetId,
				homeDir,
			});
			return { name: section.name, order, text };
		}),
	);
}

/**
 * The root README: the per-preset customization convention users see in the
 * plugin home.
 */
export const GUIDANCE_HOME_README = `# dsh-better-edit guidance

Each agent preset has its own guidance directory here: \`<preset>/<section>.md\`.
On first boot the plugin seeds the shipped presets (\`standard\`, \`code\`,
\`minimal\`, \`cordis\`) with the compiled defaults; existing files are never
overwritten, so your edits survive.

Each file is one tool section:

- \`read.md\` -> \`tool:read\`
- \`edit.md\` -> \`tool:edit\`
- \`batch_edit.md\` -> \`tool:batch_edit\`
- \`undo_last_edit.md\` -> \`tool:undo_last_edit\`

## Customize

Edit the \`<section>.md\` file for the preset and section you want to change —
the file body IS the text the model reads for that section. Files are read once
per agent at session-start, so edits apply to new sessions.

An optional YAML front-matter fence places the section at a custom position in
the assembled system prompt:

    ---
    order: 150
    ---

    <section text>

A file without front-matter keeps the default order. A malformed fence (a
missing closing \`---\`, a non-integer \`order\`, an unknown key) makes the whole
file plain prose.

## Fallback

A preset with no directory here, or a missing section file, falls back to the
compiled defaults in the plugin bundle. To customize a preset that has no
seeded directory, copy a seeded one to its name.
`;

/**
 * Materialize per-preset guidance directories in the plugin home.
 *
 * For each of \`DEFAULT_PRESETS\` creates \`<preset>/{read,edit,batch_edit,
 * undo_last_edit}.md\` rendered from the compiled defaults (with order
 * front-matter), plus a root \`README.md\` documenting the convention.
 * Idempotent: existing files are never rewritten (a user-edited file survives
 * repeated calls) and missing directories are created on demand. Each file is
 * written exclusively, so two concurrent first runs race safely.
 */
export async function ensurePresetGuidance(homeDir: string): Promise<void> {
	await mkdir(homeDir, { recursive: true });
	await Promise.all(
		DEFAULT_PRESETS.map(async (preset) => {
			const dir = join(homeDir, preset);
			await mkdir(dir, { recursive: true });
			const existing = new Set(await readdir(dir));
			await Promise.all(
				GUIDANCE_SECTIONS.map(async (section) => {
					if (existing.has(section.file)) return;
					const content = `---\norder: ${section.defaultOrder}\n---\n\n${section.renderDefault()}`;
					await writeFile(join(dir, section.file), content, {
						encoding: "utf-8",
						flag: "wx",
					}).catch((error: unknown) => {
						// A concurrent writer landed first; never clobber it.
						if (errCode(error) === "EEXIST") return;
						throw error;
					});
				}),
			);
		}),
	);
	if (!(await readdir(homeDir)).includes("README.md")) {
		await writeFile(join(homeDir, "README.md"), GUIDANCE_HOME_README, {
			encoding: "utf-8",
			flag: "wx",
		}).catch((error: unknown) => {
			if (errCode(error) === "EEXIST") return;
			throw error;
		});
	}
}
