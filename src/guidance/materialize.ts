/**
 * Materializer: IO-heavy seam owning per-preset directory seeding, seed-ledger
 * reconciliation, blank-heal, and README generation. Idempotent and
 * concurrent-safe (wx).
 * @module dsh-better-edit/guidance/materialize
 */
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeAtomic } from "../fs-write.js";
import { errCode } from "../utils.js";
import { isBlankOverride } from "./parse.js";
import { GUIDANCE_SECTIONS, type GuidanceSection } from "./resolve.js";
import { SEED_VERSION, decideSeededFile, seedHash, type GuidanceFile } from "./seed.js";
import { KNOWN_HISTORICAL_SEEDS } from "./seed-history.js";

/** The presets shipped by the harness, each seeded with editable guidance. */
export const DEFAULT_PRESETS: readonly string[] = ["standard", "ptc", "minimal", "cordis"];

/**
 * The root README: the per-preset customization convention users see in the
 * plugin home.
 */
export const GUIDANCE_HOME_README = `# dsh-better-edit guidance

Each agent preset has its own guidance directory here: \`<preset>/<section>.md\`.
On first boot the plugin seeds the shipped presets (\`standard\`, \`ptc\`,
\`minimal\`, \`cordis\`) with the compiled defaults. A seeded file is refreshed
when a release changes the compiled default; unedited files carry no permanent
provenance. Files you edit are never overwritten.

Each file is one tool section:

- \`read.md\` -> \`tool:read\`
- \`edit.md\` -> \`tool:edit\`
- \`undo_last_edit.md\` -> \`tool:undo_last_edit\`

## Customize

Edit the \`<section>.md\` file for the preset and section you want to change —
the file body IS the text the model reads for that section. Files are read once
per agent when it is created (\`agent/created\`), so edits apply to new sessions.

Section order follows the harness tool band. An optional YAML front-matter fence
is still honored when you pin a custom position in the assembled system prompt:

    ---
    order: 1100
    ---

    <section text>

A file without front-matter keeps the harness order. A malformed fence (a
missing closing \`---\`, a non-integer \`order\`, an unknown key) makes the whole
file plain prose.

## Fallback

A preset with no directory here, or a missing section file, falls back to the
compiled defaults in the plugin bundle. To customize a preset that has no
seeded directory, copy a seeded one to its name.
`;

export const GUIDANCE_HOME_README_ZH = `# dsh-better-edit 指引

每个 agent preset 在这里都有自己的指引目录：\`<preset>/<section>.md\`。首次启动时
插件会为随附的 preset（\`standard\`、\`ptc\`、\`minimal\`、\`cordis\`）写入编译内置的
默认内容。当某个版本改动了编译内置默认值时，种子文件会被刷新；未编辑的文件不
携带永久来源标记。你编辑过的文件绝不会被覆盖。

每个文件对应一个工具片段：

- \`read.md\` -> \`tool:read\`
- \`edit.md\` -> \`tool:edit\`
- \`undo_last_edit.md\` -> \`tool:undo_last_edit\`

## 自定义

编辑你想修改的 preset 与片段的 \`<section>.md\` 文件即可——文件正文就是该片段呈
现给模型的文本。文件在 agent 创建时（\`agent/created\`）读取一次，因此修改只影响新会话。

片段顺序跟随 harness 的工具带。可选的 YAML front-matter 栅栏仍会被尊重，用于把
片段固定到组装后系统提示中的自定义位置：

    ---
    order: 1100
    ---

    <片段文本>

没有 front-matter 的文件保持 harness 顺序。格式错误的栅栏（缺少收尾 \`---\`、非整数
\`order\`、未知键）会让整个文件退化为纯文本。

## 回退

这里没有对应目录的 preset、或缺失某个片段文件时，会回退到插件包内的编译内置默认
值。要自定义没有种子目录的 preset，把一个种子目录复制成它的名字即可。
`;

/** The ledger filename inside the plugin home. */
const SEED_MANIFEST_FILE = ".seeded.json";

/** The seeded-file ledger: the hash this plugin last wrote per override file. */
interface SeedManifest {
  version: number;
  files: Record<string, string>;
}

/** One materialization pass: the ledger plus the paths a warning must name. */
interface SeedRun {
  manifest: SeedManifest;
  preserved: string[];
}

/**
 * The content a seeded override file carries: the compiled default body only.
 * No front-matter fence — section order follows the harness tool band, and a
 * hand-written fence in a user file is still honored by parse/resolve.
 */
function seededContent(section: GuidanceSection): string {
  return section.renderDefault();
}

function emptyManifest(): SeedManifest {
  return { version: SEED_VERSION, files: {} };
}

/**
 * Parse the ledger. Anything that is not the exact expected shape — invalid
 * JSON, a non-object, a foreign `version`, non-string hash values — degrades to
 * an empty ledger, which the end-of-run write repairs.
 */
function parseManifest(raw: string): SeedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyManifest();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptyManifest();
  }
  const { version, files } = parsed as { version?: unknown; files?: unknown };
  if (version !== SEED_VERSION) return emptyManifest();
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return emptyManifest();
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(files)) {
    if (typeof value !== "string") return emptyManifest();
    entries[key] = value;
  }
  return { version: SEED_VERSION, files: entries };
}

/** Read the ledger; a missing file is simply an empty ledger. */
async function readManifest(homeDir: string): Promise<SeedManifest> {
  let raw: string;
  try {
    raw = await readFile(join(homeDir, SEED_MANIFEST_FILE), "utf-8");
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") return emptyManifest();
    throw error;
  }
  return parseManifest(raw);
}

/** Write the ledger once per run, key-sorted so concurrent boots agree. */
async function writeManifest(homeDir: string, manifest: SeedManifest): Promise<void> {
  const files: Record<string, string> = {};
  for (const key of Object.keys(manifest.files).sort()) {
    files[key] = manifest.files[key] as string;
  }
  const body = `${JSON.stringify({ version: SEED_VERSION, files }, null, 2)}\n`;
  await writeAtomic(join(homeDir, SEED_MANIFEST_FILE), body);
}

/** Read a file that may have vanished since the directory listing. */
async function readMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Reconcile one existing shipped-preset section file against the ledger.
 *
 * A bare blank file means "use the default" and is re-seeded. Otherwise the
 * decision matrix rules: the compiled default is recorded as `current`; a seed
 * this plugin wrote earlier (or a known historical seed) is refreshed, guarded
 * by a TOCTOU re-read so a concurrent edit wins; `preserve` and `malformed`
 * files are left untouched and named in the warning list; a deliberate blank
 * stays silent.
 */
async function reconcileShippedFile(
  path: string,
  key: GuidanceFile,
  section: GuidanceSection,
  run: SeedRun,
): Promise<void> {
  const content = await readMaybe(path);
  // Vanished between the listing and the read; the next boot seeds it.
  if (content === undefined) return;
  const body = seededContent(section);
  if (isBlankOverride(content)) {
    await writeFile(path, body, { encoding: "utf-8" });
    run.manifest.files[key] = seedHash(body);
    return;
  }
  const decision = decideSeededFile({
    content,
    recorded: run.manifest.files[key],
    currentDefault: body,
    historical: KNOWN_HISTORICAL_SEEDS[key] ?? [],
  });
  if (decision === "current") {
    run.manifest.files[key] = seedHash(content);
    return;
  }
  if (decision === "refresh") {
    // TOCTOU: re-read before writing. A file that changed (or vanished) under
    // us belongs to the user now — neither write it nor record it.
    const current = await readMaybe(path);
    if (current === undefined || seedHash(current) !== seedHash(content)) return;
    await writeAtomic(path, body);
    run.manifest.files[key] = seedHash(body);
    return;
  }
  if (decision === "preserve" || decision === "malformed") run.preserved.push(path);
}

/**
 * Inspect one existing section file in a custom preset directory. Custom
 * presets are never refreshed and never fabricated: a bare blank is healed with
 * the current default (the "use the default" signal), and every other verdict
 * that is not `current` or a deliberate blank is reported. A `refresh` here
 * means an old compiled seed and is a detect signal only — never a write.
 */
async function inspectCustomFile(
  path: string,
  section: GuidanceSection,
  run: SeedRun,
): Promise<void> {
  const content = await readMaybe(path);
  if (content === undefined) return;
  const body = seededContent(section);
  if (isBlankOverride(content)) {
    await writeFile(path, body, { encoding: "utf-8" });
    return;
  }
  const decision = decideSeededFile({
    content,
    recorded: undefined,
    currentDefault: body,
    // Custom presets have no ledger row; their historical seeds are unknown.
    historical: [],
  });
  if (decision === "refresh" || decision === "preserve" || decision === "malformed") {
    run.preserved.push(path);
  }
}

/** Build the aggregated, one-call warning naming every preserved path. */
function preservationWarning(paths: readonly string[]): string {
  return [
    `dsh-better-edit: ${paths.length} guidance override file(s) were preserved (customized, stale, or malformed); review them against the current defaults:`,
    ...paths.map((path) => `  - ${path}`),
  ].join("\n");
}

/**
 * Materialize per-preset guidance directories in the plugin home.
 *
 * For each of `DEFAULT_PRESETS` creates `<preset>/{read,edit,
 * undo_last_edit}.md` carrying the compiled default body, plus a root
 * `README.md` documenting the convention. A `.seeded.json` ledger records the
 * hash this plugin last wrote per file, so an upgrade can refresh a seed it
 * owns: an unedited file is re-seeded when a release changes the compiled
 * default, while a file the user edited is never overwritten. A blank override
 * file (whitespace-only body, no fence) is re-seeded with the current compiled
 * default; malformed, non-blank, and deliberate-blank (valid-fence) files are
 * never touched. Custom preset directories present on disk are scanned for
 * blank heals and for stale or customized files, but never fabricated or
 * refreshed. Missing directories are created on demand (shipped presets only),
 * and shipped files are written exclusively so two concurrent first runs race
 * safely. Preserved paths are reported through `warn` in a single call.
 */
export async function ensurePresetGuidance(
  homeDir: string,
  warn?: (message: string) => void,
): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  const run: SeedRun = { manifest: await readManifest(homeDir), preserved: [] };

  await Promise.all(
    DEFAULT_PRESETS.map(async (preset) => {
      const dir = join(homeDir, preset);
      await mkdir(dir, { recursive: true });
      const existing = new Set(await readdir(dir));
      await Promise.all(
        GUIDANCE_SECTIONS.map(async (section) => {
          const path = join(dir, section.file);
          const key: GuidanceFile = `${preset}/${section.file}`;
          if (existing.has(section.file)) {
            await reconcileShippedFile(path, key, section, run);
            return;
          }
          const body = seededContent(section);
          try {
            await writeFile(path, body, { encoding: "utf-8", flag: "wx" });
            run.manifest.files[key] = seedHash(body);
          } catch (error: unknown) {
            // A concurrent writer landed first; leave it and do not record it.
            if (errCode(error) !== "EEXIST") throw error;
          }
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

  // Custom presets present on disk: heal blank section files, report stale or
  // customized ones. Absence is respected — a custom preset's files are never
  // fabricated, and nothing here is ever refreshed.
  const entries = await readdir(homeDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !DEFAULT_PRESETS.includes(entry.name))
      .map(async (entry) => {
        const dir = join(homeDir, entry.name);
        const existing = new Set(await readdir(dir));
        await Promise.all(
          GUIDANCE_SECTIONS.map(async (section) => {
            if (!existing.has(section.file)) return;
            await inspectCustomFile(join(dir, section.file), section, run);
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

  await writeManifest(homeDir, run.manifest);

  if (run.preserved.length > 0 && warn !== undefined) {
    try {
      warn(preservationWarning([...run.preserved].sort()));
    } catch {
      // A logger callback must never break boot.
    }
  }
}
