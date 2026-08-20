/**
 * FileView — deep module owning "what the model sees".
 *
 * Single seam for normalize → hash → render → truncate → served-row
 * selection. The read path was 6 shallow modules for one concept:
 * `tool-read → read-and-serve → file-reader → read-render → fs-bridge
 * → file-kind/validation/truncate`, each with interface ≈ implementation.
 *
 * Now: one file to understand reads. The private helpers
 * (`file-reader`, `read-render`, `truncate`, `file-kind`, `validation`)
 * are *private to this seam* — do not import them directly outside this
 * module. Import from `file-view` instead. `fs-bridge` stays as the IO seam.
 *
 * Two surfaces:
 *  - `preview` (pure, no IO) — tested without filesystem
 *  - `readView` (IO) — read + normalize + render + truncate + hashes
 *
 * The emergent interaction (MAX_HASH_LINES vs MAX_READ_LINE_BYTES vs
 * truncation, partial serve on oversized lines) now lives in one module
 * and is one test surface.
 *
 * @module dsh-better-edit/file-view
 */

import { normFromText } from "./file-reader.js";
import { fmtReadPreview, MAX_HASH_LINES } from "./read-render.js";
import type { FileIO } from "./fs-bridge.js";
import type { ServedRow } from "./hashline/served.js";
import type { TruncationResult } from "./truncate.js";
import type { LineEnding } from "./edit-diff.js";

/** What the model sees for one read — the deep seam's core type. */
export interface FileView {
	/** Model-facing preview text (hashline rows + pagination/oversized notes). */
	text: string;
	/** Per-line hashes for the whole file (canonical, stored deterministically). */
	hashes: string[];
	/** Rows actually shown to the model (empty when nothing shown, e.g. empty file edge). */
	served: ServedRow[];
	/** Canonical absolute path (resolved against cwd). */
	absolutePath: string;
	/** Truncation meta when preview was capped. */
	truncation?: TruncationResult;
	/** Next pagination offset when preview was paginated/truncated. */
	nextOffset?: number;
	/** Whether the raw file had non-UTF-8 bytes (shown as U+FFFD, rewritten on edit). */
	hadUtf8DecodeErrors: boolean;
	/** Stripped BOM if present (for round-trip fidelity on edit/write). */
	bom: string;
	/** Original line ending (for round-trip fidelity). */
	originalEnding: LineEnding;
	/** Normalized LF content (internal, but useful for callers that need content + hashes). */
	normalized: string;
}

export interface PreviewOpts {
	offset?: number;
	limit?: number;
}

export interface ReadViewOpts extends PreviewOpts {
	signal?: AbortSignal;
}

/**
 * Pure rendering without IO — tested without filesystem.
 * Wraps `fmtReadPreview` so callers have one place to render.
 */
export async function preview(
	content: string,
	hashes: string[],
	opts: PreviewOpts = {},
	absolutePath?: string,
): Promise<{
	text: string;
	served: ServedRow[];
	truncation?: TruncationResult;
	nextOffset?: number;
}> {
	return fmtReadPreview(content, opts, hashes, absolutePath);
}

/**
 * IO version: read + normalize + render + truncate + hashes.
 * Single place that decides `served[]` — no emergent partial-serve.
 */
export async function readView(
	io: FileIO,
	path: string,
	cwd: string,
	opts: ReadViewOpts = {},
): Promise<FileView> {
	const { signal } = opts;
	const absolutePath = await io.resolve(path, cwd, signal);
	const rawText = await io.readText(absolutePath, signal);
	const { normalized, fileHashes, hadUtf8DecodeErrors, bom, originalEnding } =
		await normFromText({
			absolutePath,
			rawText,
			displayPath: path,
			signal,
			maxLines: MAX_HASH_LINES,
		});
	const r = await fmtReadPreview(
		normalized,
		{ offset: opts.offset, limit: opts.limit },
		fileHashes,
		absolutePath,
	);
	return {
		text: r.text,
		hashes: fileHashes,
		served: r.served,
		absolutePath,
		truncation: r.truncation,
		nextOffset: r.nextOffset,
		hadUtf8DecodeErrors,
		bom,
		originalEnding,
		normalized,
	};
}

// Re-export constants that belong to this seam for callers that need limits
export { MAX_HASH_LINES };
