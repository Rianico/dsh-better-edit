/**
 * Per-preset guidance overrides for the hashline tool sections.
 *
 * Each of the four `tool:*` prompt sections the plugin registers has a
 * compiled default rendered from `prompts.ts` (byte-identical to the inline
 * rendering `src/index.ts` uses today). A user can override any section's text
 * and `order` with a plain markdown file keyed by agent preset: the override
 * files live in the plugin's shared home (`$DSH_HOME/plugins/dsh-better-edit`,
 * never the workspace store) and are resolved per section as
 * `<preset>/<section>.md` → `_default/<section>.md` → compiled default.
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

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	BATCH_EDIT_GUIDELINES,
	EDIT_DESCRIPTION,
	EDIT_GUIDELINES,
	READ_GUIDELINES,
	UNDO_GUIDELINES,
} from "./prompts.js";
import { errCode } from "./utils.js";

/** The fallback/template directory name inside the plugin home. */
export const DEFAULT_GUIDANCE_DIR = "_default";

/**
 * The `tool:read` section header. Mirrors the string `src/index.ts` renders
 * inline today (it is not `READ_DESCRIPTION`, which only feeds the tool
 * schema); the installer ticket removes the inline copy.
 */
const READ_SECTION_HEADER =
	"Use the read tool — not shell commands like cat — to inspect text files.";

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
		defaultOrder: 100,
		renderDefault: () =>
			[READ_SECTION_HEADER, "", bulletLines(READ_GUIDELINES)].join("\n"),
	},
	{
		name: "tool:edit",
		file: "edit.md",
		defaultOrder: 102,
		renderDefault: () =>
			[EDIT_DESCRIPTION, "", bulletLines(EDIT_GUIDELINES)].join("\n"),
	},
	{
		name: "tool:batch_edit",
		file: "batch_edit.md",
		defaultOrder: 103,
		renderDefault: () => bulletLines(BATCH_EDIT_GUIDELINES),
	},
	{
		name: "tool:undo_last_edit",
		file: "undo_last_edit.md",
		defaultOrder: 104,
		renderDefault: () => bulletLines(UNDO_GUIDELINES),
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
	return { order, text: lines.slice(close + 1).join("\n") };
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
	candidates.push(join(options.homeDir, DEFAULT_GUIDANCE_DIR, file));
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
 * `<preset>/` layer (still consulting `_default/`, the live global fallback).
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
