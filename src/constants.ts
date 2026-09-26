import { formatError } from "./domain-errors.js";

export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_READ_LINE_BYTES = 200 * 1024;

export const HASH_STORE_BUSY_TIMEOUT = 1000;
export const HASH_STORE_VERSION = 7;
export const EDITS_MAX_ITEMS = 32;
/** @deprecated batch_edit seam removed (ADR-0003) — use EDITS_MAX_ITEMS */
export const BATCH_EDIT_MAX_ITEMS = EDITS_MAX_ITEMS;
export const SERVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SERVED_ECHO_CAP = 150;

// WHY: ADR-0024/D3 — the applied diff's removed-line cap, the mirror of the served-row cap on the
// WHY: refusal side: a range deletion renders head + tail with an exact omitted count instead of
// WHY: every removed row. The omitted rows still advance the render cursor, so every surviving row
// WHY: keeps its exact old line number and hash.
export const DIFF_REMOVED_CAP = 6;
export const DIFF_REMOVED_EDGE = 2;

export const NOOP_LOOP_THRESHOLD = 3;
export const NEW_CONTENT_BODY =
  `"replace_with" must be a string with \\n line separators, not an array.` +
  ` Do not pass an array of lines — pass the replacement text as one string: "line1\\nline2". Use "" to delete a range.`;
/** Model-facing header for a non-string replace_with, composed once by the registry. */
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
