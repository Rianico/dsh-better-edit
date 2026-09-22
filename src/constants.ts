import { formatError } from "./domain-errors.js";

export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_READ_LINE_BYTES = 200 * 1024;

export const HASH_STORE_BUSY_TIMEOUT = 1000;
export const HASH_STORE_VERSION = 6;
export const EDITS_MAX_ITEMS = 32;
/** @deprecated batch_edit seam removed (ADR-0003) — use EDITS_MAX_ITEMS */
export const BATCH_EDIT_MAX_ITEMS = EDITS_MAX_ITEMS;
export const SERVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SERVED_ECHO_CAP = 150;
export const NOOP_LOOP_THRESHOLD = 3;
export const NEW_CONTENT_BODY =
  `"replacement_text" must be a string with \\n line separators, not an array.` +
  ` Do not pass an array of lines — pass the replacement text as one string: "line1\\nline2". Use "" to delete a range.`;
/** Model-facing header for a non-string replacement_text, composed once by the registry. */
export const NEW_CONTENT_NOT_STRING_MSG = formatError("E_BAD_PAYLOAD", {
  message: NEW_CONTENT_BODY,
});

export function eLargeFileMsg(displayPath: string, lineCount: number, maxLines: number): string {
  return formatError("E_LARGE_FILE", {
    path: displayPath,
    lineCount,
    limit: maxLines,
    limitKind: "lines",
  });
}
