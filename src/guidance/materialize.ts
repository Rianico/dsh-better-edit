/**
 * Materializer: IO-heavy seam owning per-preset directory seeding, blank-heal,
 * and README generation. Idempotent and concurrent-safe (wx).
 * @module dsh-better-edit/guidance/materialize
 */
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { errCode } from "../utils.js";
import { isBlankOverride } from "./parse.js";
import { GUIDANCE_SECTIONS, type GuidanceSection } from "./resolve.js";

/** The presets shipped by the harness, each seeded with editable guidance. */
export const DEFAULT_PRESETS: readonly string[] = [
	"standard",
	"code",
	"minimal",
	"cordis",
];

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

/**
 * Materialize per-preset guidance directories in the plugin home.
 *
 * For each of `DEFAULT_PRESETS` creates `<preset>/{read,edit,
 * undo_last_edit}.md` rendered from the compiled defaults (with order
 * front-matter), plus a root `README.md` documenting the convention.
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
	// Ghost seam cleanup (ADR-0003): remove orphan batch_edit.md override files left
	// from pre-0.3.0 homes. The payload contract merged batch_edit into edit's
	// {path, edits:[[hash,hash,text]]} arity — the file is dead. Best-effort,
	// idempotent, concurrent-safe (ignore ENOENT).
	for (const preset of DEFAULT_PRESETS) {
		const ghost = join(homeDir, preset, "batch_edit.md");
		await unlink(ghost).catch((error: unknown) => {
			if (errCode(error) === "ENOENT") return;
			throw error;
		});
	}

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
	// Ghost seam cleanup for custom presets (same ADR-0003 dead file).
	for (const entry of entries) {
		if (!entry.isDirectory() || DEFAULT_PRESETS.includes(entry.name)) continue;
		const ghost = join(homeDir, entry.name, "batch_edit.md");
		await unlink(ghost).catch((error: unknown) => {
			if (errCode(error) === "ENOENT") return;
			throw error;
		});
	}

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
