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
 * fence carrying only an `order` key (`---` / `order: N` / `---`). Any
 * well-formed fence — even keyless, even an empty body — is deliberate content
 * and wins. A leading `---` that does not parse (a missing closing fence, a
 * non-integer `order`, an unknown key) is a MALFORMED override and must never
 * reach the model: resolution falls back to the compiled default and reports
 * the file and parse reason. An absent or blank override (whitespace-only body,
 * no fence) means "use the default" and is re-seeded at boot.
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
	/** The section text: the file body, or the whole file when no fence is present. */
	text: string;
	/** True when a leading `---` fence is present but does not parse (fast fail). */
	malformed?: boolean;
	/** Human-readable parse reason, present only when `malformed` is true. */
	reason?: string;
}

function stripCR(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Parse an override file. Only a leading `---` fence whose lines are empty or
 * `order: <integer>` is accepted. A leading `---` that does not parse (no
 * closing fence, unknown key, non-integer value) is a malformed override;
 * anything else is pure prose (the whole file as text).
 */
export function parseSectionFile(content: string): ParsedSection {
	const lines = content.split("\n");
	if (stripCR(lines[0]) !== "---") {
		return { text: content };
	}
	const close = lines.findIndex(
		(line, index) => index > 0 && stripCR(line) === "---",
	);
	if (close < 0) {
		return { text: content, malformed: true, reason: "missing closing fence" };
	}
	let order: number | undefined;
	for (let index = 1; index < close; index++) {
		const line = stripCR(lines[index]);
		if (line.trim() === "") continue;
		const key = line.split(":")[0].trim();
		const match = /^order:\s*(-?\d+)\s*$/.exec(line);
		if (!match) {
			if (key === "order") {
				const value = line.slice(line.indexOf(":") + 1).trim();
				return {
					text: content,
					malformed: true,
					reason: `non-integer order '${value}'`,
				};
			}
			return {
				text: content,
				malformed: true,
				reason: `unknown key '${key}'`,
			};
		}
		order = Number.parseInt(match[1] as string, 10);
	}
	// Front-matter body: strip leading blank lines after the closing fence so
	// `---\n…\n---\n\nbody` and `---\n…\n---\nbody` parse identically (the
	// materialized preset files carry a blank line after the fence).
	const body = lines.slice(close + 1);
	let bodyStart = 0;
	while (bodyStart < body.length && body[bodyStart]!.trim() === "") bodyStart++;
	return { order, text: body.slice(bodyStart).join("\n") };
}

/**
 * True when an override file is blank: whitespace-only body and NO front-matter
 * fence (the "I want the default" case). The single source of truth for whether
 * a boot-time materialization pass should re-seed a file. False for prose with
 * content, for any valid fence (including a keyless/empty one — a deliberate
 * blank), and for malformed files.
 */
export function isBlankOverride(content: string): boolean {
	const parsed = parseSectionFile(content);
	return (
		!parsed.malformed &&
		parsed.order === undefined &&
		parsed.text.trim() === "" &&
		!startsWithFenceLine(content)
	);
}

/** True when an override file opens with a leading `---` fence that is malformed. */
export function isMalformedOverride(content: string): boolean {
	return parseSectionFile(content).malformed === true;
}

function startsWithFenceLine(content: string): boolean {
	return stripCR(content.split("\n")[0]) === "---";
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
 * Resolve all four sections for a preset. `presetId === undefined` skips the
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

export const GUIDANCE_HOME_README_ZH = `# dsh-better-edit 指引

每个 agent preset 在这里都有自己的指引目录：\`<preset>/<section>.md\`。首次启动时
插件会为随附的 preset（\`standard\`、\`code\`、\`minimal\`、\`cordis\`）写入编译内置的
默认内容；已有文件绝不被覆盖，因此你的编辑会保留。

每个文件对应一个工具片段：

- \`read.md\` -> \`tool:read\`
- \`edit.md\` -> \`tool:edit\`
- \`batch_edit.md\` -> \`tool:batch_edit\`
- \`undo_last_edit.md\` -> \`tool:undo_last_edit\`

## 自定义

编辑你想修改的 preset 与片段的 \`<section>.md\` 文件即可——文件正文就是该片段呈
现给模型的文本。文件在 agent 的 session-start 时读取一次，因此修改只影响新会话。

可以用可选的 YAML front-matter 栅栏把片段放到组装后系统提示中的自定义位置：

    ---
    order: 150
    ---

    <片段文本>

没有 front-matter 的文件保持默认顺序。格式错误的栅栏（缺少收尾 \`---\`、非整数
\`order\`、未知键）会让整个文件退化为纯文本。

## 回退

这里没有对应目录的 preset、或缺失某个片段文件时，会回退到插件包内的编译内置默认
值。要自定义没有种子目录的 preset，把一个种子目录复制成它的名字即可。
`;

/**
 * Materialize per-preset guidance directories in the plugin home.
 *
 * For each of \`DEFAULT_PRESETS\` creates \`<preset>/{read,edit,batch_edit,
 * undo_last_edit}.md\` rendered from the compiled defaults (with order
 * front-matter), plus a root \`README.md\` documenting the convention.
 * Idempotent: a user-edited file survives repeated calls. A blank override file
 * (whitespace-only body, no fence) is re-seeded with the current compiled
 * default; malformed, non-blank, and deliberate-blank (valid-fence) files are
 * never touched. Custom preset directories present on disk are scanned the same
 * way but never fabricated. Missing directories are created on demand (shipped
 * presets only), and shipped files are written exclusively so two concurrent
 * first runs race safely.
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
					const path = join(dir, section.file);
					if (existing.has(section.file)) {
						await healBlankOverride(path, section);
						return;
					}
					await writeFile(path, seededContent(section), {
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
	// Custom presets present on disk: heal existing blank section files only.
	// Absence is respected — a custom preset's files are never fabricated, and
	// malformed / non-blank / deliberate-blank files are left untouched.
	const entries = await readdir(homeDir, { withFileTypes: true });
	await Promise.all(
		entries
			.filter(
				(entry) => entry.isDirectory() && !DEFAULT_PRESETS.includes(entry.name),
			)
			.map(async (entry) => {
				const dir = join(homeDir, entry.name);
				const existing = new Set(await readdir(dir));
				await Promise.all(
					GUIDANCE_SECTIONS.map(async (section) => {
						if (!existing.has(section.file)) return;
						await healBlankOverride(join(dir, section.file), section);
					}),
				);
			}),
	);
	const homeFiles = new Set(await readdir(homeDir));
	const readmes: Array<[string, string]> = [
		["README.md", GUIDANCE_HOME_README],
		["README.zh.md", GUIDANCE_HOME_README_ZH],
	];
	await Promise.all(
		readmes.map(async ([file, content]) => {
			if (homeFiles.has(file)) return;
			await writeFile(join(homeDir, file), content, {
				encoding: "utf-8",
				flag: "wx",
			}).catch((error: unknown) => {
				if (errCode(error) === "EEXIST") return;
				throw error;
			});
		}),
	);
}

/** The content a seeded override file carries, rendered from the current defaults. */
function seededContent(section: GuidanceSection): string {
	return `---\norder: ${section.defaultOrder}\n---\n\n${section.renderDefault()}`;
}

/**
 * Heal an existing empty override file: a blank file means "use the default",
 * so it is rewritten with the current seeded default. Malformed, non-blank, and
 * deliberate-blank (valid-fence) files are left untouched — overwriting a
 * malformed file would destroy the user's salvageable body. Plain overwrite:
 * the file already exists. Errors propagate to the boot caller, which never
 * fails init.
 */
async function healBlankOverride(
	path: string,
	section: GuidanceSection,
): Promise<void> {
	let content: string | undefined;
	try {
		content = await readFile(path, "utf-8");
	} catch (error: unknown) {
		// Vanished between readdir and read; nothing to heal.
		if (errCode(error) === "ENOENT") return;
		throw error;
	}
	if (!isBlankOverride(content)) return;
	await writeFile(path, seededContent(section), { encoding: "utf-8" });
}
