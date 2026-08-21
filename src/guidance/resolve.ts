/**
 * Resolver: IO-light seam owning "first existing candidate wins, blank=skip,
 * malformed=fallback+report" policy for guidance override files.
 *
 * Tested via temp-home FS; materializer stubs this module.
 * @module dsh-better-edit/guidance/resolve
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	EDIT_GUIDANCE,
	READ_GUIDANCE,
	UNDO_GUIDANCE,
	type ToolGuidance,
} from "../prompts.js";
import { errCode } from "../utils.js";
import { isBlankOverride, parseSectionFile } from "./parse.js";

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

/** The three sections, in default-order sequence. */
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
	/** Set when the override file was malformed and the compiled default was used. */
	malformed?: { file: string; reason: string };
}

/**
 * Resolve one section's guidance: the first override file that exists wins,
 * falling back to the compiled default. A missing or blank file (ENOENT, or
 * whitespace-only with no fence) advances the chain; a malformed file resolves
 * to the compiled default and reports itself; any other read error propagates.
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
		if (parsed.malformed) {
			// A broken override must never reach the model. Resolve to the
			// compiled default and report the file + parse reason to the caller.
			return {
				order: section.defaultOrder,
				text: section.renderDefault(),
				malformed: {
					file: candidate,
					reason: parsed.reason ?? "malformed override",
				},
			};
		}
		// Blank (no fence, whitespace-only) means "use the default": advance the
		// fallback chain rather than render an empty section.
		if (isBlankOverride(content)) continue;
		return { order: parsed.order ?? section.defaultOrder, text: parsed.text };
	}
	return { order: section.defaultOrder, text: section.renderDefault() };
}

/** The resolved configuration of one section, ready for the systemPrompt registry. */
export interface SectionOverride {
	name: string;
	order: number;
	text: string;
	/** Set when the override file was malformed and the compiled default was used. */
	malformed?: { file: string; reason: string };
}

/**
 * Resolve all three sections for a preset. `presetId === undefined` skips the
 * `<preset>/` layer and resolves straight to the compiled defaults.
 */
export async function composeSections(
	presetId: string | undefined,
	homeDir: string,
): Promise<SectionOverride[]> {
	return Promise.all(
		GUIDANCE_SECTIONS.map(async (section) => {
			const resolved = await resolveSection(section.name, {
				presetId,
				homeDir,
			});
			return {
				name: section.name,
				order: resolved.order,
				text: resolved.text,
				malformed: resolved.malformed,
			};
		}),
	);
}
