/**
 * The shared read-and-serve operation: resolve → read → normalize → render
 * the hashline preview → record the served rows → clear the drift marks →
 * append the UTF-8 rewrite note. Used by the `read` tool and by the write
 * auto-read hook, so the model is always shown fresh anchors the same way no
 * matter which tool produced the read.
 * @module dsh-better-edit/read-and-serve
 */

import { abortIf } from "./utils.js";
import { normFromText } from "./file-reader.js";
import { fmtReadPreview, MAX_HASH_LINES } from "./read-render.js";
import { recordServed, clearDriftReported } from "./served-store.js";
import type { FileIO } from "./fs-bridge.js";
import type { ServedRow } from "./hashline/served.js";

/** Appended when the file had non-UTF-8 bytes; editing rewrites it as UTF-8. */
export const UTF8_REWRITE_NOTE =
	"[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]";

export interface ReadAndServeOptions {
	/** The session whose served rows these lines belong to. */
	sessionKey: string;
	signal?: AbortSignal;
	/** Pagination for the rendered preview (undefined = from the start). */
	offset?: number;
	limit?: number;
}

export interface ReadAndServeResult {
	/** The model-facing read text, including the UTF-8 note when applicable. */
	text: string;
	/** The rows recorded as served (empty when nothing was shown). */
	served: ServedRow[];
	hadUtf8DecodeErrors: boolean;
	absolutePath: string;
}

/**
 * Perform one read-and-serve: normalize the file at `rawPath`, render its
 * hashline preview, record the shown rows as served for the session, and clear
 * the reported-drift marks (a fresh read resets them). The returned text
 * carries the UTF-8 rewrite note when the file had decode errors.
 *
 * Emits nothing on the fs-observation gate — callers that need the
 * observation recorded (the `read` tool) do that themselves with their exec
 * context.
 */
export async function readAndServe(
	io: FileIO,
	rawPath: string,
	cwd: string,
	options: ReadAndServeOptions,
): Promise<ReadAndServeResult> {
	const { sessionKey, signal } = options;
	abortIf(signal);
	const absolutePath = await io.resolve(rawPath, cwd, signal);
	const rawText = await io.readText(absolutePath, signal);
	const { normalized, fileHashes, hadUtf8DecodeErrors } =
		await normFromText({
			absolutePath,
			rawText,
			displayPath: rawPath,
			signal,
			maxLines: MAX_HASH_LINES,
		});

	const preview = await fmtReadPreview(
		normalized,
		{ offset: options.offset, limit: options.limit },
		fileHashes,
		absolutePath,
	);
	if (preview.served.length > 0) {
		await recordServed(
			sessionKey,
			absolutePath,
			preview.served,
			fileHashes.length,
		);
	}
	await clearDriftReported(sessionKey, absolutePath);

	const text = hadUtf8DecodeErrors
		? `${preview.text}\n\n${UTF8_REWRITE_NOTE}`
		: preview.text;
	return { text, served: preview.served, hadUtf8DecodeErrors, absolutePath };
}
