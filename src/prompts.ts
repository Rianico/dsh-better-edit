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
  "Edit a range of lines in a text file with `{ \"path\": path, \"edits\": [[remove_from, remove_to, replacement_text], ...] }`. " +
  "`path` is the file path or `null`. `read` returns `HASH\u2502content` (e.g. `wUp\u2502    \"site\": {`) \u2014 for `edit`, " +
  "`remove_from`/`remove_to` are HASH anchors (bare 3-char value before `\u2502`, e.g. \"wUp\", \"AU6\"), never `HASH\u2502content` or line content. " +
  "`replacement_text` is bare content without `HASH\u2502`, lines joined by \\n (e.g. \"    \\\"site\\\": {\\n        \\\"class\\\": SiteScraper,\"); use \"\" to delete. " +
  "Example: read shows `wUp\u2502    \"site\": {` + `AU6\u2502        \"name\": \"old\",` \u2192 edit " +
  "`{\"path\":\"scrape.py\",\"edits\":[[\"wUp\",\"AU6\",\"    \\\"site\\\": {\\n        \\\"class\\\": SiteScraper,\"]]}`. " +
  "Edits in one call apply atomically; after success reuse `HASH\u2502content` from the returned diff for the next edit (no re-read needed). On failure follow the error hint.";

export const EDIT_GUIDANCE: ToolGuidance = {
  intro: "Edit a range of lines via a bare 3-char HASH anchor \u2014 payload is { path, edits: [[hash,hash,text]] } (single-file atomic, null path infers).",
  lines: [
    "`edit`: `HASH` vs `HASH\u2502content` \u2014 `HASH` is the bare 3-char (e.g. \"wUp\"), `HASH\u2502content` is the full line from `read`/`diff` (e.g. `wUp\u2502    \"site\": {`); never mix them.",
    "`edit`: get `remove_from`/`remove_to` by copying only the 3 chars before `\u2502` from `read` output \u2014 never include `\u2502` or content after it.",
    "`edit`: `replacement_text` is plain file content without `HASH\u2502` \u2014 e.g. \"    \\\"site\\\": {\\n        \\\"class\\\": SiteScraper,\" \u2014 never prefix lines with `HASH\u2502`.",
    "`edit`: every `\\n` in `replacement_text` separates lines; mirror trailing blank lines explicitly (use \"\" to delete a range).",
    "`edit`: after a successful edit the returned diff shows fresh anchors (`HASH\u2502content`) \u2014 copy new `HASH` values from there for the next edit; no need to re-read.",
    "`edit`: `remove_from`/`remove_to` are inclusive; batch multiple edits to the same file only when independent \u2014 they apply atomically (fail \u2192 nothing written).",
  ],
};

export const READ_DESCRIPTION =
  "Read a text file; each line returned as HASH│content with a 3-char alphanumeric hash. " +
  "No line numbers — use the HASH as the anchor in edit calls. Binary/directory → rejected; " +
  "empty → HASH│ (edit to insert); pageable with offset/limit; BOM stripped; non-UTF-8 shown as U+FFFD.";

export const READ_GUIDANCE: ToolGuidance = {
  intro: "Use read, not shell commands, to inspect text files and obtain the HASH anchors the editing tools require.",
  lines: [
    "`read`: call it only for content the tools have not served — a page you never saw, or lines past the post-edit diff.",
    "`read`: each row is `HASH│content`; the HASH is the anchor (no line numbers). Rejection echoes return fresh rows that count as serves.",
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
    "`undo_last_edit`: the restored diff\u2019s `+HASH│` and ` HASH│` rows are fresh anchors for follow-up edits.",
  ],
};

/**
 * @deprecated batch_edit guidance seam was removed with ADR-0003 (payload contract
 * merged batch_edit into edit's {path, edits:[[hash,hash,text]]} arity). This alias
 * is kept for backwards compat — use EDIT_DESCRIPTION. The guidance system no
 * longer includes tool:batch_edit.
 */
export const BATCH_EDIT_DESCRIPTION = EDIT_DESCRIPTION;
/** @deprecated see BATCH_EDIT_DESCRIPTION — use EDIT_GUIDANCE */
export const BATCH_EDIT_GUIDANCE: ToolGuidance = EDIT_GUIDANCE;
