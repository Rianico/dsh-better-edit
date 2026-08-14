import { constants } from "node:fs";
import { stat } from "fs/promises";
import { lineHashes } from "./hashline/index.js";
import { loadFileKindAndText, type LFile } from "./file-kind.js";
import { resolveTarget } from "./fs-write.js";
import { toCwd } from "./paths.js";
import { detectEnding, toLF, stripBOM, type LineEnding } from "./edit-diff.js";
import { abortIf } from "./utils.js";
import { valKind, valAccess } from "./validation.js";
import { visLines } from "./utils.js";
import type { HashStore } from "./hash-store.js";

export interface NormFile {
	absolutePath: string;
	normalized: string;
	bom: string;
	originalEnding: LineEnding;
	fileHashes: string[];
	hadUtf8DecodeErrors: boolean;
}

export type SnapInfo = {
	snapshotId: string;
	ino: number;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
};

function fmtSnapId(
	canonicalPath: string,
	info: { ino: number; mtimeMs: number; ctimeMs: number; size: number },
): string {
	return `v2|${canonicalPath}|${info.ino}|${info.mtimeMs}|${info.ctimeMs}|${info.size}`;
}

export async function fileSnap(absolutePath: string): Promise<SnapInfo> {
	const canonicalPath = await resolveTarget(absolutePath);
	const stats = await stat(canonicalPath);
	return {
		snapshotId: fmtSnapId(canonicalPath, stats),
		ino: stats.ino,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
		size: stats.size,
	};
}

export interface ReadNormOptions {
	signal?: AbortSignal;
	accessMode?: number;
	preloadedFile?: LFile;
	maxLines?: number;
	store?: HashStore;
	noPersist?: boolean;
}

/**
 * Hashline normalization shared by every reader: strip the BOM, detect the
 * original line ending, normalize to LF, enforce the line ceiling, and assign
 * (or recall from the hash store) the per-line hash anchors.
 *
 * This is the string-level core of the read/edit pipeline; the caller owns
 * path resolution and raw IO (local filesystem, `ctx.fs`, or a sandbox
 * backend) so the same anchors are produced no matter where the file lives.
 */
export async function normFromText(input: {
	absolutePath: string;
	rawText: string;
	displayPath: string;
	signal?: AbortSignal;
	maxLines?: number;
	store?: HashStore;
	noPersist?: boolean;
	hadUtf8DecodeErrors?: boolean;
}): Promise<NormFile> {
	const { absolutePath, displayPath, signal } = input;
	abortIf(signal);
	const { bom, text: rawContent } = stripBOM(input.rawText);
	const originalEnding = detectEnding(rawContent);
	const normalized = toLF(rawContent);

	if (input.maxLines !== undefined) {
		const lineCount = visLines(normalized).length;
		if (lineCount > input.maxLines) {
			throw new Error(
				`[E_FILE_TOO_LARGE] ${displayPath} has ${lineCount} lines, exceeding the ${input.maxLines}-line edit limit. Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.`,
			);
		}
	}

	const fileHashes = await lineHashes(
		normalized,
		absolutePath,
		undefined,
		input.store,
		input.noPersist !== true,
	);
	return {
		absolutePath,
		normalized,
		bom,
		originalEnding,
		fileHashes,
		hadUtf8DecodeErrors: input.hadUtf8DecodeErrors === true,
	};
}

export async function readNormFile(
	path: string,
	cwd: string,
	options?: ReadNormOptions,
): Promise<NormFile> {
	const absolutePath = toCwd(path, cwd);
	const resolvedPath = await resolveTarget(absolutePath);
	const signal = options?.signal;
	const accessMode = options?.accessMode ?? constants.R_OK;

	abortIf(signal);
	await valAccess(resolvedPath, path, accessMode);

	abortIf(signal);
	const file =
		options?.preloadedFile ??
		(await loadFileKindAndText(resolvedPath, {
			maxLines: options?.maxLines,
			displayPath: path,
		}));
	valKind(file, path);
	return normFromText({
		absolutePath: resolvedPath,
		rawText: file.text,
		displayPath: path,
		signal,
		maxLines: options?.maxLines,
		store: options?.store,
		noPersist: options?.noPersist,
		hadUtf8DecodeErrors: file.hadUtf8DecodeErrors,
	});
}
