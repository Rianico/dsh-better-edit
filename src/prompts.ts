/**
 * Model-facing prompt text for the hashline tools, embedded so the bundle
 * ships no external prompt files. Each tool's schema `description` is short;
 * the `tool:*` system-prompt sections carry the brief guidance the model
 * reads when the tools are presented. Guidance is uniform: a one-line opener
 * followed by tight bullets.
 * @module dsh-better-edit/prompts
 */

export interface ToolGuidance {
  intro: string;
  lines: readonly string[];
}

export const EDIT_DESCRIPTION =
  'Edit a range of lines in a text file with `{ "file": file, "edits": [{ "anchor_from": a, "anchor_to": b, "replace_with": text }, ...] }` (arity = edits.length, atomic, one file per call). ' +
  '`file` is the text file (a file, never a directory). `read` shows `HASH\u2502content` (e.g. `wUp\u2502  "site": {`) \u2014 use bare 3-char HASH anchors for ' +
  '`anchor_from`/`anchor_to` (e.g. "wUp"), never `HASH\u2502content`. `replace_with` is bare content, \\n joins lines, "" deletes. ' +
  'Example: `{"file":"a.py","edits":[{"anchor_from":"wUp","anchor_to":"AU6","replace_with":"new"}]}` (legacy tuples still fold). Reuse `HASH\u2502content` from the diff after success unless the result says NOT recorded as served, then re-read. ' +
  "On failure follow the error hint: `[TO MODEL]` errors need a retry with fresh anchors, `[USER]` is human-only.";

export const EDIT_GUIDANCE: ToolGuidance = {
  intro:
    "Edit a range of lines via a bare 3-char HASH anchor \u2014 payload is { file, edits: [{anchor_from, anchor_to, replace_with}] } (single-file atomic; legacy tuples still fold pre-validation).",
  lines: [
    '`edit`: `HASH` vs `HASH\u2502content` \u2014 `HASH` is the bare 3-char (e.g. "wUp"), `HASH\u2502content` is the full line from `read`/`diff` (e.g. `wUp\u2502    "site": {`); never mix them.',
    "`edit`: get `anchor_from`/`anchor_to` by copying only the 3 chars before `\u2502` from `read` output \u2014 never include `\u2502` or content after it.",
    '`edit`: `replace_with` is plain file content without `HASH\u2502` \u2014 e.g. "    \\"site\\": {\\n        \\"class\\": SiteScraper," \u2014 never prefix lines with `HASH\u2502`.',
    '`edit`: every `\\n` in `replace_with` separates lines; mirror trailing blank lines explicitly (use "" to delete a range).',
    "`edit`: `edits` entries are objects `{anchor_from, anchor_to, replace_with}` \u2014 legacy tuples still fold pre-validation; unknown fields are rejected.",
    "`edit`: after an edit whose serve landed, the returned diff shows fresh anchors (`HASH\u2502content`) \u2014 copy new `HASH` values from there for the next edit; if the result says the rows were NOT recorded as served, re-read instead.",
    "`edit`: `anchor_from`/`anchor_to` are inclusive; batch multiple edits to the same file only when independent \u2014 they apply atomically (fail \u2192 nothing written).",
    "`edit`: `[TO MODEL]` errors (e.g. `E_STALE_*`, `E_UNSERVED_*`, `E_BAD_PAYLOAD`, `E_SUSPICIOUS_TEXT`) need a retry \u2014 `[USER]` warnings/`drift:` notices are human-only.",
    "`edit`: on `E_STALE_ANCHOR` re-read for fresh anchors; on `E_STALE_RANGE`/`E_UNSERVED_RANGE` the echoed rows are the file's current anchors, NOT serves — re-read before retrying.",
  ],
};

export const READ_DESCRIPTION =
  "Read a text file; each line returned as HASH│content with a 3-char alphanumeric hash. " +
  "No line numbers — use the HASH as the anchor in edit calls. Binary/directory → rejected; " +
  "empty → HASH│ (edit to insert); pageable with offset/limit, or several disjoint ranges in one call " +
  "with `windows: [{offset, limit}, ...]` (every listed window is served there, so anchors from all " +
  "of them work in one edit); BOM stripped; non-UTF-8 shown as U+FFFD.";

export const READ_GUIDANCE: ToolGuidance = {
  intro:
    "Use read, not shell commands, to inspect text files and obtain the HASH anchors the editing tools require.",
  lines: [
    "`read`: call it only for content the tools have not served — a page you never saw, or lines past the post-edit diff.",
    "`read`: each row is `HASH│content`; the HASH is the anchor (no line numbers). Rejection echoes show the file's current rows — they are NOT recorded as serves, so re-read before retrying.",
    "`read`: binary/directory rejects; page large files with offset/limit.",
  ],
};

export const UNDO_DESCRIPTION =
  "Undo the last edit on a file, reverting it to its previous state. Use when an edit produced " +
  "incorrect results (e.g., wrong content, duplicated lines, broken syntax).";

export const UNDO_GUIDANCE: ToolGuidance = {
  intro: "Revert the last edit on a file.",
  lines: [
    "`undo_last_edit`: reverts only the most recent edit — any write clears history, so call it immediately after a bad edit.",
    "`undo_last_edit`: the restored diff\u2019s `+HASH│` and ` HASH│` rows are fresh anchors for follow-up edits \u2014 unless the result says the rows were NOT recorded as served, then re-read.",
  ],
};

/**
 * @deprecated batch_edit guidance seam was removed with ADR-0003 (payload contract
 * merged batch_edit into edit's {file, edits:[...]} arity). This alias
 * is kept for backwards compat — use EDIT_DESCRIPTION. The guidance system no
 * longer includes tool:batch_edit.
 */
export const BATCH_EDIT_DESCRIPTION = EDIT_DESCRIPTION;
/** @deprecated see BATCH_EDIT_DESCRIPTION — use EDIT_GUIDANCE */
export const BATCH_EDIT_GUIDANCE: ToolGuidance = EDIT_GUIDANCE;
